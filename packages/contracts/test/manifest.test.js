import { describe, expect, it } from 'vitest';
import {
	MANIFEST_RULES,
	MILLICREDITS_PER_CREDIT,
	checkManifest,
	eventGlobMatches,
	eventNamespace,
	isEventGlob,
	manifestSchema,
	validateFeatureConfig,
	validateManifest,
} from '../src/index.js';
import { manifest, packManifest } from '../src/testing.js';
import { expectProblem, expectRule } from './helpers.js';

describe('manifest schema', () => {
	it('accepts the reference service manifest and pack manifest', () => {
		expect(validateManifest(manifest())).toMatchObject({ ok: true });
		expect(validateManifest(packManifest()).ok).toBe(true);
	});

	it('accepts capabilities.identityIssuer (a product asking to become a website identity issuer)', () => {
		for (const identityIssuer of [true, false]) {
			const m = manifest();
			m.capabilities.identityIssuer = identityIssuer;
			expect(validateManifest(m)).toMatchObject({ ok: true });
		}
	});

	it('is frozen and priced in integer millicredits', () => {
		expect(Object.isFrozen(manifestSchema)).toBe(true);
		expect(MILLICREDITS_PER_CREDIT).toBe(1000);
	});

	/** @type {Array<[string, (m: any) => unknown, string, string]>} */
	const invalid = [
		['wrong ssps', (m) => (m.ssps = '2'), '/ssps', 'const'],
		['missing product', (m) => delete m.product, '/product', 'required'],
		['non-semver version', (m) => (m.product.version = '1.4'), '/product/version', 'pattern'],
		['unknown kind', (m) => (m.product.kind = 'plugin'), '/product/kind', 'enum'],
		['fractional hourly price', (m) => (m.elements[0].price.hourly = 0.5), '/elements/0/price/hourly', 'type'],
		[
			'negative metered price',
			(m) => (m.elements[0].price.metered[0].perUnit = -1),
			'/elements/0/price/metered/0/perUnit',
			'minimum',
		],
		['bad event type', (m) => (m.events.consumes = ['order.placed']), '/events/consumes/0', 'pattern'],
		['unknown mode', (m) => (m.elements[0].modes = ['D']), '/elements/0/modes/0', 'enum'],
		['service without endpoints', (m) => delete m.endpoints, '/endpoints', 'required'],
		['http endpoint', (m) => (m.endpoints.base = 'http://coupons.example.dev'), '/endpoints/base', 'pattern'],
		['non-boolean identityIssuer', (m) => (m.capabilities.identityIssuer = 'yes'), '/capabilities/identityIssuer', 'type'],
		['unknown resource', (m) => (m.requires.resources = ['mainframe']), '/requires/resources/0', 'enum'],
		['bad retention duration', (m) => (m.retention.redemptions = '365 days'), '/retention/redemptions', 'format'],
		[
			'non-UTC price book',
			(m) => (m.priceBook.effectiveFrom = '2026-10-01T00:00:00+02:00'),
			'/priceBook/effectiveFrom',
			'pattern',
		],
		['extra top-level member', (m) => (m.surprise = true), '/surprise', 'additionalProperties'],
		[
			'combinator in feature schema',
			(m) => (m.elements[0].features.properties.maxActive.anyOf = [{ type: 'integer' }]),
			'/elements/0/features/properties/maxActive/anyOf',
			'additionalProperties',
		],
		[
			'feature without default',
			(m) => delete m.elements[0].features.properties.prefix.default,
			'/elements/0/features/properties/prefix/default',
			'required',
		],
		[
			'bad x-plan max',
			(m) => (m.elements[0].features.properties.maxActive['x-plan'].starter.max = 'lots'),
			'/elements/0/features/properties/maxActive/x-plan/starter/max',
			'type',
		],
		['bad module ref', (m) => (m.elements[1].headless = '../outside.js#x'), '/elements/1/headless', 'anyOf'],
		['plan bounds (removed; x-plan is canonical)', (m) => (m.plans[0].bounds = {}), '/plans/0/bounds', 'additionalProperties'],
	];

	it.each(invalid)('rejects %s', (_name, mutate, path, keyword) => {
		const m = manifest();
		mutate(m);
		expectProblem(validateManifest(m), path, keyword);
	});

	it('rejects non-objects', () => {
		expectProblem(validateManifest(null), '', 'type');
		expectProblem(validateManifest([]), '', 'type');
	});
});

describe('manifest semantics', () => {
	/** @param {(m: any) => void} mutate */
	const semantic = (mutate) => {
		const m = manifest();
		mutate(m);
		return checkManifest(m);
	};

	it('passes the reference manifest', () => {
		expect(checkManifest(manifest())).toEqual([]);
		expect(checkManifest(packManifest())).toEqual([]);
	});

	it('flags duplicate element keys', () => {
		expectRule(
			semantic((m) => m.elements.push({ ...m.elements[1] })),
			MANIFEST_RULES.duplicateElementKey,
			'/elements/2/key',
		);
	});

	it('flags unknown, self and cyclic dependencies', () => {
		expectRule(
			semantic((m) => (m.elements[1].dependsOn = ['ghost'])),
			MANIFEST_RULES.unknownDependency,
			'/elements/1/dependsOn/0',
		);
		expectRule(
			semantic((m) => (m.elements[1].dependsOn = ['apply_box'])),
			MANIFEST_RULES.selfDependency,
		);
		const cyclic = semantic((m) => (m.elements[0].dependsOn = ['apply_box']));
		expectRule(cyclic, MANIFEST_RULES.dependencyCycle);
		expect(cyclic.find((p) => p.keyword === MANIFEST_RULES.dependencyCycle)?.message).toMatch(
			/codes → apply_box → codes|apply_box → codes → apply_box/,
		);
	});

	it('enforces mode rules', () => {
		expectRule(
			semantic((m) => ((m.product.kind = 'pack'), delete m.endpoints)),
			MANIFEST_RULES.packRequiresModeA,
			'/elements/0/modes',
		);
		expectRule(
			semantic((m) => (m.elements[1].renderer = null)),
			MANIFEST_RULES.modeARequiresRenderer,
			'/elements/1/renderer',
		);
		expectRule(
			semantic((m) => (m.elements[1].headless = null)),
			MANIFEST_RULES.rendererRequiresHeadless,
			'/elements/1/headless',
		);
		expectRule(
			semantic((m) => (m.elements[1].headless = null)),
			MANIFEST_RULES.modeBRequiresHeadless,
			'/elements/1/headless',
		);
		expectRule(
			semantic((m) => (m.elements[1].budget.js = 0)),
			MANIFEST_RULES.modeARequiresBudget,
		);
		expectRule(
			semantic((m) => (m.elements[1].modes = ['B', 'C'])),
			MANIFEST_RULES.rendererRequiresModeA,
		);
		expectRule(
			semantic((m) => (m.elements[1].modes = ['A', 'C'])),
			MANIFEST_RULES.uiRequiresModeB,
		);
		expectRule(
			semantic((m) => (m.elements[0].modes = ['B'])),
			MANIFEST_RULES.statefulRequiresModeC,
			'/elements/0/modes',
		);
		expectRule(
			semantic((m) => {
				delete m.elements[0].api;
				m.elements[0].stateful = false;
			}),
			MANIFEST_RULES.modeCRequiresApi,
			'/elements/0/api',
		);
	});

	it('accepts element resources on their own: product-level resources mean "always required"', () => {
		expect(semantic((m) => (m.elements[0].requires.resources = ['ai']))).toEqual([]);
		expect(
			semantic((m) => {
				delete m.requires;
				m.elements[0].requires.resources = ['database', 'messaging'];
			}),
		).toEqual([]);
		expect(semantic((m) => (m.requires.resources = ['database', 'storage']))).toEqual([]);
		expect(MANIFEST_RULES.undeclaredResource).toBe('undeclaredResource');
	});

	it('checks plans: codes, elements and dependency closure', () => {
		expectRule(
			semantic((m) => m.plans.push({ ...m.plans[0] })),
			MANIFEST_RULES.duplicatePlanCode,
			'/plans/1/code',
		);
		expectRule(
			semantic((m) => m.plans[0].elements.push('ghost')),
			MANIFEST_RULES.unknownPlanElement,
			'/plans/0/elements/2',
		);
		expectRule(
			semantic((m) => (m.plans[0].elements = ['apply_box'])),
			MANIFEST_RULES.planMissingDependency,
			'/plans/0/elements/0',
		);
		expectRule(
			semantic((m) => (m.plans[0].elements = [])),
			MANIFEST_RULES.planElementMissing,
			'/elements/0/features/properties/maxActive/x-plan/starter',
		);
	});

	it('checks plan add-ons', () => {
		/** @param {(m: any) => void} mutate */
		const withAddon = (mutate) =>
			semantic((m) => {
				m.plans[0].elements = ['codes'];
				m.plans[0].addons = ['apply_box'];
				mutate(m);
			});
		expect(withAddon(() => {})).toEqual([]);
		expect(
			validateManifest({ ...manifest(), plans: [{ code: 'starter', elements: ['codes'], addons: ['apply_box'] }] }).ok,
		).toBe(true);
		expectRule(
			withAddon((m) => (m.plans[0].elements = ['codes', 'apply_box'])),
			MANIFEST_RULES.planElementConflict,
			'/plans/0/addons/0',
		);
		expectRule(
			withAddon((m) => m.plans[0].addons.push('ghost')),
			MANIFEST_RULES.unknownPlanElement,
			'/plans/0/addons/1',
		);
		expectRule(
			withAddon((m) => (m.plans[0].elements = [])),
			MANIFEST_RULES.planMissingDependency,
			'/plans/0/addons/0',
		);
		// both as add-ons: the dependency is offered, so allowed
		expect(withAddon((m) => ((m.plans[0].elements = []), (m.plans[0].addons = ['apply_box', 'codes'])))).toEqual([]);
		// an included element cannot rely on an add-on being switched on
		expectRule(
			withAddon((m) => ((m.plans[0].elements = ['apply_box']), (m.plans[0].addons = ['codes']))),
			MANIFEST_RULES.planMissingDependency,
			'/plans/0/elements/0',
		);
		// x-plan for a plan that only offers the element as an add-on is fine
		expect(withAddon((m) => ((m.plans[0].elements = []), (m.plans[0].addons = ['codes', 'apply_box'])))).toEqual([]);
	});

	it('validates quota and rate metadata', () => {
		/** @param {any} m */
		const props = (m) => m.elements[0].features.properties;
		expectRule(
			semantic((m) => delete props(m).monthlyRedemptions['x-period']),
			MANIFEST_RULES.featureKindMeta,
			'/elements/0/features/properties/monthlyRedemptions/x-period',
		);
		expectRule(
			semantic((m) => delete props(m).validateRate['x-per']),
			MANIFEST_RULES.featureKindMeta,
			'/elements/0/features/properties/validateRate/x-per',
		);
		expectRule(
			semantic((m) => (props(m).validateRate['x-hardStop'] = true)),
			MANIFEST_RULES.featureKindMeta,
			'/elements/0/features/properties/validateRate/x-hardStop',
		);
		expectRule(
			semantic((m) => (props(m).monthlyRedemptions['x-per'] = 'minute')),
			MANIFEST_RULES.featureKindMeta,
		);
		expectRule(
			semantic((m) => (props(m).maxActive['x-unit'] = 'code')),
			MANIFEST_RULES.featureKindMeta,
		);
		expectRule(
			semantic((m) => (props(m).prefix['x-period'] = 'day')),
			MANIFEST_RULES.featureKindMeta,
		);
		/** @type {Array<[string, unknown, string]>} */
		const bad = [
			['x-period', 'year', 'enum'],
			['x-hardStop', 'yes', 'type'],
			['x-unit', 'Redemption Units', 'pattern'],
		];
		for (const [keyword, value, ajvKeyword] of bad) {
			const m = manifest();
			props(m).monthlyRedemptions[keyword] = value;
			expectProblem(validateManifest(m), `/elements/0/features/properties/monthlyRedemptions/${keyword}`, ajvKeyword);
		}
		const m = manifest();
		props(m).validateRate['x-per'] = 'day';
		expectProblem(validateManifest(m), '/elements/0/features/properties/validateRate/x-per', 'enum');
		expect(validateFeatureConfig(manifest().elements[0].features, { monthlyRedemptions: 5, validateRate: 10 }).ok).toBe(true);
	});

	it('checks x-plan entries (the canonical per-plan bounds)', () => {
		/** @param {any} m */
		const props = (m) => m.elements[0].features.properties;
		/** @param {any} m */
		const xPlan = (m) => props(m).maxActive['x-plan'];
		expectRule(
			semantic((m) => (xPlan(m).pro = { max: 10 })),
			MANIFEST_RULES.unknownPlan,
		);
		expectRule(
			semantic((m) => (xPlan(m).starter = { default: 60, max: 50 })),
			MANIFEST_RULES.planDefaultExceedsMax,
		);
		expectRule(
			semantic((m) => (xPlan(m).starter = { default: 0 })),
			MANIFEST_RULES.planDefaultInvalid,
		);
		expectRule(
			semantic((m) => (xPlan(m).starter = { max: 1e9 })),
			MANIFEST_RULES.boundRange,
		);
		expectRule(
			semantic((m) => (xPlan(m).starter = { max: 0 })),
			MANIFEST_RULES.boundRange,
		);
		expectRule(
			semantic((m) => (xPlan(m).starter = { max: true })),
			MANIFEST_RULES.boundType,
		);
		expectRule(
			semantic((m) => (props(m).allowStacking['x-plan'] = { starter: { max: 3 } })),
			MANIFEST_RULES.boundType,
		);
		expectRule(
			semantic((m) => (props(m).window['x-plan'] = { starter: { max: 3 } })),
			MANIFEST_RULES.boundType,
		);
		expectRule(
			semantic((m) => (props(m).prefix['x-plan'] = { starter: { max: 99 } })),
			MANIFEST_RULES.boundRange,
		);
		expectRule(
			semantic((m) => (props(m).channels['x-plan'] = { starter: { default: ['web', 'pos'], max: 1 } })),
			MANIFEST_RULES.planDefaultExceedsMax,
		);
		expectRule(
			semantic((m) => (props(m).prefix['x-plan'] = { starter: { default: 'LONGER', max: 2 } })),
			MANIFEST_RULES.planDefaultExceedsMax,
		);
		expect(
			semantic((m) => {
				props(m).channels['x-plan'] = { starter: { default: ['web'], max: 2 } };
				props(m).prefix['x-plan'] = { starter: { max: 8 } };
				props(m).window['x-plan'] = { starter: { default: { days: 7 } } };
			}),
		).toEqual([]);
		const flag = semantic((m) => {
			props(m).allowStacking['x-plan'] = { starter: { default: true, max: false } };
		});
		expectRule(flag, MANIFEST_RULES.planDefaultExceedsMax);
	});

	it('requires subscribe scopes for consumed events', () => {
		expectRule(
			semantic((m) => (m.scopes = m.scopes.filter((/** @type {string} */ s) => !s.startsWith('events.subscribe:cart')))),
			MANIFEST_RULES.eventNotSubscribed,
			'/events/consumes/1',
		);
		expect(semantic((m) => (m.scopes = ['events.subscribe:*']))).toEqual([]);
		expect(semantic((m) => (m.scopes = ['events.subscribe:order.placed@1', 'events.subscribe:cart.updated@1']))).toEqual([]);
		expectRule(
			semantic((m) => (m.scopes = ['events.subscribe:order.placed@2', 'events.subscribe:cart.*'])),
			MANIFEST_RULES.eventNotSubscribed,
			'/events/consumes/0',
		);
	});

	it('accepts consumed globs covered by subscribe scopes', () => {
		const globs = (/** @type {string[]} */ consumes, /** @type {string[]} */ scopes) =>
			semantic((m) => {
				m.events.consumes = consumes;
				m.scopes = scopes;
			});
		expect(isEventGlob('custom.*')).toBe(true);
		expect(isEventGlob('order.placed@1')).toBe(false);
		expect(globs(['custom.*', 'order.*@1'], ['events.subscribe:custom.*', 'events.subscribe:order.*'])).toEqual([]);
		expect(globs(['order.*@1'], ['events.subscribe:order.*@1'])).toEqual([]);
		expect(globs(['order.*@1'], ['events.subscribe:*'])).toEqual([]);
		// a scope narrower than the glob does not cover it
		expectRule(globs(['order.*'], ['events.subscribe:order.*@1']), MANIFEST_RULES.eventNotSubscribed, '/events/consumes/0');
		expectRule(globs(['order.*@1'], ['events.subscribe:order.placed']), MANIFEST_RULES.eventNotSubscribed);
		expectRule(globs(['custom.*'], ['events.subscribe:custom.a*']), MANIFEST_RULES.eventNotSubscribed);
		// malformed globs: a bare `*`, a glob without a namespace, a partial-segment glob, an exact type without a version
		for (const bad of ['*', '*.placed@1', 'custom.a*', 'order.placed']) {
			expectRule(globs([bad], ['events.subscribe:*']), MANIFEST_RULES.eventType, '/events/consumes/0');
			const schema = validateManifest({ ...manifest(), events: { consumes: [bad] } });
			expect(schema.ok).toBe(false);
		}
		expect(
			validateManifest({
				...manifest(),
				scopes: [...manifest().scopes, 'events.subscribe:custom.*'],
				events: { ...manifest().events, consumes: [...manifest().events.consumes, 'custom.*'] },
			}).ok,
		).toBe(true);
	});

	it('restricts published events to the product namespace or scoped standard events', () => {
		expectRule(
			semantic((m) => (m.events.publishes = ['coupon.redeemed@1'])),
			MANIFEST_RULES.publishOutsideNamespace,
			'/events/publishes/0',
		);
		expectRule(
			semantic((m) => (m.events.publishes = ['custom.x@1'])),
			MANIFEST_RULES.publishOutsideNamespace,
		);
		expectRule(
			semantic((m) => (m.events.publishes = ['order.placed@2'])),
			MANIFEST_RULES.publishOutsideNamespace,
		);
		expectRule(
			semantic((m) => (m.events.publishes = ['order.placed@1'])),
			MANIFEST_RULES.publishScopeMissing,
			'/events/publishes/0',
		);
		expect(semantic((m) => ((m.events.publishes = ['order.placed@1']), m.scopes.push('events.publish:order.*')))).toEqual([]);
		const pack = packManifest();
		pack.product.slug = 'notice-bar';
		pack.events = { publishes: ['notice_bar.dismissed@1'] };
		expect(checkManifest(pack)).toEqual([]);
	});

	it('matches event globs', () => {
		expect(eventGlobMatches('order.*', 'order.placed@1')).toBe(true);
		expect(eventGlobMatches('order.*', 'orders.placed@1')).toBe(false);
		expect(eventGlobMatches('*', 'a.b@3')).toBe(true);
		expect(eventGlobMatches('order.placed@1', 'order.placed@1')).toBe(true);
		expect(eventGlobMatches('order.placed@1', 'order.placed@2')).toBe(false);
		expect(eventGlobMatches('order.placed', 'orderXplaced@1')).toBe(false);
		expect(eventNamespace('notice-bar')).toBe('notice_bar');
	});

	it('restricts element packs', () => {
		/** @param {(m: any) => void} mutate */
		const pack = (mutate) => {
			const m = packManifest();
			mutate(m);
			return checkManifest(m);
		};
		expectRule(
			pack((m) => (m.endpoints = { base: 'https://x.dev' })),
			MANIFEST_RULES.packEndpoints,
			'/endpoints',
		);
		expectRule(
			pack((m) => (m.capabilities = { adminLaunch: false })),
			MANIFEST_RULES.packAdminLaunch,
			'/capabilities/adminLaunch',
		);
		expectRule(
			pack((m) => (m.elements[0].modes = ['A', 'B', 'C'])),
			MANIFEST_RULES.packModes,
			'/elements/0/modes',
		);
		expectRule(
			pack((m) => (m.elements[0].api = { resources: ['bars'] })),
			MANIFEST_RULES.packApi,
			'/elements/0/api',
		);
		expectRule(
			pack((m) => (m.scopes = ['graph.customer.read', 'messaging.send'])),
			MANIFEST_RULES.packScope,
			'/scopes/1',
		);
		expectRule(
			pack((m) => (m.scopes = ['events.subscribe:order.*'])),
			MANIFEST_RULES.packScope,
			'/scopes/0',
		);
		expectRule(
			pack((m) => (m.elements[0].stateful = true)),
			MANIFEST_RULES.packStateRequiresGraph,
			'/elements/0/stateful',
		);
		expect(
			pack((m) => {
				m.elements[0].stateful = true;
				m.scopes = ['graph.wishlist.write', 'events.publish:item.*'];
				m.events = { publishes: ['item.viewed@1'] };
			}),
		).toEqual([]);
		expect(validateManifest({ ...packManifest(), endpoints: { base: 'https://x.dev' } }).ok).toBe(false);
	});

	it('requires base, register and events endpoints for service products', () => {
		for (const key of ['register', 'events']) {
			const m = manifest();
			delete m.endpoints[key];
			expectProblem(validateManifest(m), `/endpoints/${key}`, 'required');
		}
		const m = manifest();
		delete m.endpoints.dashboard;
		delete m.endpoints.demo;
		expect(validateManifest(m).ok).toBe(true);
	});

	it('flags duplicate metered units and unknown included plans', () => {
		expectRule(
			semantic((m) => m.elements[0].price.metered.push({ unit: 'redemption', perUnit: 1 })),
			MANIFEST_RULES.duplicateMeteredUnit,
			'/elements/0/price/metered/1/unit',
		);
		expectRule(
			semantic((m) => (m.elements[0].price.metered[0].included = { pro: 1 })),
			MANIFEST_RULES.unknownPlan,
		);
	});

	it('re-checks event types and the price book date', () => {
		expectRule(
			semantic((m) => (m.events.publishes = ['Coupon.Redeemed@1'])),
			MANIFEST_RULES.eventType,
			'/events/publishes/0',
		);
		expectRule(
			semantic((m) => (m.priceBook.effectiveFrom = '2026-02-30T00:00:00Z')),
			MANIFEST_RULES.priceBookEffectiveFrom,
		);
		const result = validateManifest({ ...manifest(), priceBook: { version: '1', effectiveFrom: '2026-13-01T00:00:00Z' } });
		expect(result.ok).toBe(false);
	});

	it('requires experiments: true for x-experiment features', () => {
		expectRule(
			semantic((m) => (m.elements[0].experiments = false)),
			MANIFEST_RULES.experimentsDisabled,
		);
	});

	it('reports semantic problems through validateManifest', () => {
		const m = manifest();
		m.elements[1].dependsOn = ['ghost'];
		expectProblem(validateManifest(m), '/elements/1/dependsOn/0', MANIFEST_RULES.unknownDependency);
	});

	it('validates feature defaults with the full validator (formats)', () => {
		const m = manifest();
		m.elements[0].features.properties.contact = { type: 'string', title: 'Contact', default: 'not-an-email', format: 'email' };
		expectProblem(validateManifest(m), '/elements/0/features/properties/contact/default', 'format');
	});

	it('reports feature schemas that do not compile in strict mode', () => {
		const m = manifest();
		m.elements[0].features.properties.prefix.minimum = 1;
		expectProblem(validateManifest(m), '/elements/0/features', 'featureCompile');
	});
});
