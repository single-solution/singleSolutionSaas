import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { AUTHORITY, LAYERS, pickEffective, resolveEntitlement } from '../src/resolve.js';
import { normaliseProduct } from '../src/catalog.js';
import { HEALTHY, NOW, coupons, couponsInput, deepFreeze } from './fixtures.js';

/** @typedef {import('../src/resolve.js').Layer} Layer */

const SUB = deepFreeze({
	id: 'sub_1',
	plan: 'pro',
	priceBookVersion: '2026-06-01',
	status: /** @type {const} */ ('active'),
	websiteId: 'w1',
	merchantId: 'm1',
});

/**
 * @param {Partial<Parameters<typeof resolveEntitlement>[0]>} [overrides]
 */
const resolve = (overrides = {}) =>
	resolveEntitlement({
		product: coupons,
		subscription: SUB,
		now: NOW,
		runtime: { resources: HEALTHY },
		...overrides,
	});

const CONFIG_LAYERS = /** @type {const} */ (['platform', 'website', 'admin']);
const RUNTIME_STATES = /** @type {const} */ (['active', 'paused', 'suspended', 'cancelled', 'spend_cap']);

/**
 * All subsets of the configurable layers.
 * @returns {Array<Array<typeof CONFIG_LAYERS[number]>>}
 */
const subsets = () => {
	/** @type {Array<Array<typeof CONFIG_LAYERS[number]>>} */
	const out = [];
	for (let mask = 0; mask < 1 << CONFIG_LAYERS.length; mask += 1) out.push(CONFIG_LAYERS.filter((_, i) => mask & (1 << i)));
	return out;
};

/**
 * Specification oracle (written from the README table, independently of the implementation):
 * - an admin value always wins;
 * - otherwise a platform lock pins platform's value;
 * - otherwise the last provided layer wins.
 * @param {readonly Layer[]} provided In precedence order.
 * @param {typeof CONFIG_LAYERS[number] | null} lock
 * @returns {{ source: Layer, ignored: Layer[] }}
 */
const oracle = (provided, lock) => {
	const ignored = lock === 'admin' || lock === 'platform' ? provided.filter((l) => l === 'website') : [];
	if (provided.includes('admin')) return { source: 'admin', ignored };
	if (lock === 'platform') return { source: 'platform', ignored };
	return { source: /** @type {Layer} */ (provided.filter((l) => LAYERS.includes(l)).at(-1)), ignored };
};

describe('precedence matrix: elements (every layer × lock × runtime state)', () => {
	/** Distinct values per layer so the source is observable. */
	const VALUE = { product: false, plan: true, platform: false, website: true, admin: false };
	const cases = [];
	for (const provided of subsets()) {
		const all = /** @type {Layer[]} */ (['product', 'plan', ...provided]);
		for (const lock of [null, ...provided]) for (const state of RUNTIME_STATES) cases.push({ provided, all, lock, state });
	}

	it.each(cases)('$provided lock=$lock state=$state', ({ provided, all, lock, state }) => {
		const product = coupons;
		/** @type {Record<string, { elements: Record<string, { enabled: boolean, locked: boolean }> }>} */
		const layers = {};
		for (const layer of provided) layers[layer] = { elements: { codes: { enabled: VALUE[layer], locked: lock === layer } } };
		const doc = resolveEntitlement({
			product,
			subscription: { ...SUB, status: state === 'spend_cap' ? 'active' : state },
			layers: deepFreeze(layers),
			runtime: { resources: HEALTHY, spendCap: state === 'spend_cap' },
			now: NOW,
		});
		const expected = oracle(all, lock);
		const codes = doc.elements.codes;
		expect(codes?.source).toBe(expected.source);
		expect(codes?.locked).toBe(lock !== null);
		const configured = VALUE[expected.source];
		expect(codes?.enabled).toBe(configured && state === 'active');
		expect(codes?.reason).toBe(configured && state !== 'active' ? state : expected.source);
		expect(doc.state).toBe(state);
		const ignored = doc.report
			.filter((r) => r.target === 'element' && r.key === 'codes' && r.reason === 'locked')
			.map((r) => r.layer);
		expect(ignored).toEqual(expected.ignored);
	});
});

describe('precedence matrix: features (every layer × lock × runtime state)', () => {
	const VALUE = { product: 10, plan: 50, platform: 60, website: 80, admin: 90 };
	const cases = [];
	for (const provided of subsets()) {
		const all = /** @type {Layer[]} */ (['product', 'plan', ...provided]);
		for (const lock of [null, ...provided]) for (const state of RUNTIME_STATES) cases.push({ provided, all, lock, state });
	}

	it.each(cases)('$provided lock=$lock state=$state', ({ provided, all, lock, state }) => {
		const product = coupons;
		/** @type {Record<string, { features: Record<string, { value: number, locked: boolean }> }>} */
		const layers = {};
		for (const layer of provided)
			layers[layer] = { features: { 'codes.maxActive': { value: VALUE[layer], locked: lock === layer } } };
		const doc = resolveEntitlement({
			product,
			subscription: { ...SUB, status: state === 'spend_cap' ? 'active' : state },
			layers: deepFreeze(layers),
			runtime: { resources: HEALTHY, spendCap: state === 'spend_cap' },
			now: NOW,
		});
		const expected = oracle(all, lock);
		expect(doc.features['codes.maxActive']).toEqual({
			value: VALUE[expected.source],
			source: expected.source,
			locked: lock !== null,
			lockedBy: lock,
			reason: null,
			blocked: false,
		});
		expect(doc.config.codes?.maxActive).toBe(VALUE[expected.source]);
		const ignored = doc.report.filter((r) => r.key === 'codes.maxActive' && r.reason === 'locked').map((r) => r.layer);
		expect(ignored).toEqual(expected.ignored);
	});
});

describe('locks', () => {
	it('the highest-authority lock holds when several layers lock', () => {
		const doc = resolve({
			layers: {
				platform: { features: { 'codes.maxActive': { value: 60, locked: true } } },
				website: { features: { 'codes.maxActive': { value: 80, locked: true } } },
			},
		});
		expect(doc.features['codes.maxActive']).toMatchObject({ value: 60, source: 'platform', lockedBy: 'platform' });
		expect(doc.report.filter((r) => r.reason === 'locked').map((r) => r.layer)).toEqual(['website']);
	});

	it('admin overrides a platform lock and the lock stays in effect', () => {
		const doc = resolve({
			layers: {
				platform: { features: { 'codes.maxActive': { value: 60, locked: true } } },
				admin: { features: { 'codes.maxActive': { value: 90 } } },
			},
		});
		expect(doc.features['codes.maxActive']).toMatchObject({ value: 90, source: 'admin', locked: true, lockedBy: 'platform' });
	});

	it('ignores lock requests on non-lockable features except from admin', () => {
		const website = resolve({
			layers: {
				platform: { features: { 'codes.pattern': { value: 'A-#' } } },
				website: { features: { 'codes.pattern': { value: 'B-#', locked: true } } },
			},
		});
		expect(website.features['codes.pattern']).toMatchObject({ value: 'B-#', locked: false });
		expect(website.report).toContainEqual({
			target: 'feature',
			key: 'codes.pattern',
			layer: 'website',
			kind: 'ignored',
			reason: 'lock_not_allowed',
		});
		const admin = resolve({ layers: { admin: { features: { 'codes.pattern': { value: 'C-#', locked: true } } } } });
		expect(admin.features['codes.pattern']).toMatchObject({ value: 'C-#', locked: true, lockedBy: 'admin' });
	});

	it('exposes the authority table', () => {
		expect(AUTHORITY.admin).toBeGreaterThan(AUTHORITY.platform);
		expect(pickEffective([{ layer: 'product', value: 1, locked: false }]).effective.value).toBe(1);
	});
});

describe('clamping and validation', () => {
	const starter = { ...SUB, plan: 'starter' };

	it.each([
		['website', 500, 100, 'plan_max'],
		['website', null, 100, 'plan_max'],
		['website', 0, 1, 'min'],
		['admin', 500, 500, null],
		['platform', 500, 500, null],
		['admin', 20000, 10000, 'max'],
		['admin', null, 10000, 'max'],
	])('%s sets maxActive=%s on starter → %s (%s)', (layer, attempted, applied, reason) => {
		const doc = resolve({
			subscription: starter,
			layers: { [layer]: { features: { 'codes.maxActive': { value: attempted } } } },
		});
		expect(doc.features['codes.maxActive']).toMatchObject({ value: applied, source: layer, reason: reason ? 'clamped' : null });
		const clamps = doc.report.filter((r) => r.kind === 'clamped');
		expect(clamps).toEqual(
			reason ? [{ target: 'feature', key: 'codes.maxActive', layer, kind: 'clamped', reason, attempted, applied }] : [],
		);
	});

	it('clamps flags against plan max false and numeric rates', () => {
		const doc = resolve({
			subscription: starter,
			layers: { website: { features: { 'codes.bulk': { value: true }, 'codes.apiRate': { value: 1000 } } } },
		});
		expect(doc.features['codes.bulk']).toMatchObject({ value: false, reason: 'clamped' });
		expect(doc.features['codes.apiRate']).toMatchObject({ value: 120, reason: 'clamped' });
		const admin = resolve({ subscription: starter, layers: { admin: { features: { 'codes.bulk': { value: true } } } } });
		expect(admin.features['codes.bulk']).toMatchObject({ value: true, reason: null });
	});

	it('plan elements are on, addons off but enableable, anything else unavailable (not_in_plan)', () => {
		const base = resolve({ subscription: starter });
		expect(base.elements.codes).toMatchObject({ enabled: true, source: 'plan', reason: 'plan' });
		expect(base.elements.reports).toMatchObject({ enabled: false, source: 'plan', reason: 'plan' });
		expect(base.elements.ai_copy).toMatchObject({ enabled: false, source: 'plan', reason: 'not_in_plan' });
		expect(base.report).toEqual([]);

		const addon = resolve({ subscription: starter, layers: { website: { elements: { reports: true } } } });
		expect(addon.elements.reports).toMatchObject({ enabled: true, source: 'website', reason: 'website' });

		const attempt = resolve({
			subscription: starter,
			layers: { website: { elements: { ai_copy: { enabled: true } } } },
		});
		expect(attempt.elements.ai_copy).toMatchObject({ enabled: false, reason: 'not_in_plan' });
		expect(attempt.report).toEqual([
			{ target: 'element', key: 'ai_copy', layer: 'website', kind: 'ignored', reason: 'not_in_plan', attempted: true },
		]);
		// Switching an unavailable element off is harmless and not reported.
		expect(resolve({ subscription: starter, layers: { website: { elements: { ai_copy: false } } } }).report).toEqual([]);

		const admin = resolve({ subscription: starter, layers: { admin: { elements: { ai_copy: true } } } });
		expect(admin.elements.ai_copy).toMatchObject({ enabled: true, reason: 'admin' });
		const platform = resolve({ subscription: starter, layers: { platform: { elements: { ai_copy: { enabled: true } } } } });
		expect(platform.elements.ai_copy?.enabled).toBe(true);
		const staffOff = resolve({ subscription: starter, layers: { admin: { elements: { ai_copy: false } } } });
		expect(staffOff.elements.ai_copy).toMatchObject({ enabled: false, reason: 'admin' });
	});

	it('ignores string/array values above the x-plan max (length / item count) instead of truncating', () => {
		const doc = resolve({
			subscription: starter,
			layers: {
				website: {
					features: {
						'codes.headline': { value: 'A headline that is far too long' },
						'codes.tags': { value: ['a', 'b', 'c'] },
					},
				},
			},
		});
		expect(doc.features['codes.headline']?.value).toBe('Have a code?');
		expect(doc.features['codes.tags']?.value).toEqual([]);
		expect(doc.report).toEqual([
			{
				target: 'feature',
				key: 'codes.headline',
				layer: 'website',
				kind: 'ignored',
				reason: 'plan_max',
				attempted: 'A headline that is far too long',
			},
			{
				target: 'feature',
				key: 'codes.tags',
				layer: 'website',
				kind: 'ignored',
				reason: 'plan_max',
				attempted: ['a', 'b', 'c'],
			},
		]);
		const ok = resolve({
			subscription: starter,
			layers: {
				website: { features: { 'codes.tags': { value: ['a', 'b'] } } },
				admin: { features: { 'codes.headline': { value: 'Admin may exceed plan max' } } },
			},
		});
		expect(ok.features['codes.tags']?.value).toEqual(['a', 'b']);
		expect(ok.features['codes.headline']?.value).toBe('Admin may exceed plan max');
	});

	it('ignores invalid and unknown values with a report', () => {
		const doc = resolve({
			layers: {
				website: {
					elements: { codes: /** @type {never} */ ('yes'), nope: true },
					features: { 'codes.maxActive': { value: 'many' }, 'codes.layout': { value: 'sideways' }, 'x.y': { value: 1 } },
				},
			},
		});
		expect(doc.features['codes.maxActive']?.value).toBe(50);
		expect(doc.features['codes.layout']?.value).toBe('inline');
		expect(doc.report).toEqual(
			expect.arrayContaining([
				{ target: 'element', key: 'codes', layer: 'website', kind: 'ignored', reason: 'invalid', attempted: 'yes' },
				{ target: 'element', key: 'nope', layer: 'website', kind: 'ignored', reason: 'unknown' },
				{
					target: 'feature',
					key: 'codes.layout',
					layer: 'website',
					kind: 'ignored',
					reason: 'invalid',
					attempted: 'sideways',
				},
				{
					target: 'feature',
					key: 'codes.maxActive',
					layer: 'website',
					kind: 'ignored',
					reason: 'invalid',
					attempted: 'many',
				},
				{ target: 'feature', key: 'x.y', layer: 'website', kind: 'ignored', reason: 'unknown' },
			]),
		);
	});

	it('applies scheduled entries only inside their window', () => {
		const layers = {
			website: { elements: { ai_copy: { enabled: true, from: '2026-10-01T10:00:00Z', until: '2026-10-01T14:00:00Z' } } },
		};
		expect(resolve({ layers, now: '2026-10-01T09:59:59Z' }).elements.ai_copy?.enabled).toBe(true); // pro plan default: all on
		const off = {
			website: { elements: { codes: { enabled: false, from: '2026-10-01T10:00:00Z', until: '2026-10-01T14:00:00Z' } } },
		};
		expect(resolve({ layers: off, now: '2026-10-01T09:59:59Z' }).elements.codes?.enabled).toBe(true);
		expect(resolve({ layers: off, now: '2026-10-01T10:00:00Z' }).elements.codes?.enabled).toBe(false);
		expect(resolve({ layers: off, now: '2026-10-01T14:00:00Z' }).elements.codes?.enabled).toBe(true);
	});

	it('uses product defaults when there is no plan and rejects unknown plans', () => {
		const doc = resolve({ subscription: { id: 's', plan: null } });
		expect(doc.plan).toBeNull();
		expect(doc.elements.codes).toMatchObject({ enabled: false, source: 'product' });
		expect(doc.features['codes.maxActive']?.value).toBe(10);
		expect(doc.priceBookVersion).toBe('2026-06-01');
		expect(() => resolve({ subscription: { id: 's', plan: 'gold' } })).toThrow(/gold/);
	});
});

describe('runtime state', () => {
	it('disables elements requiring an unhealthy connector', () => {
		const doc = resolve({ runtime: { resources: { database: 'connected', ai: 'failing' } } });
		expect(doc.elements.ai_copy).toMatchObject({ enabled: false, reason: 'resource_missing', missing: ['ai'] });
		expect(doc.elements.reports?.enabled).toBe(true);
		const none = resolve({ runtime: {} });
		expect(none.elements.reports).toMatchObject({ enabled: false, reason: 'resource_missing', missing: ['database'] });
	});

	it('treats product-level resources as always required: every element is disabled while one is missing', () => {
		const product = normaliseProduct({ ...couponsInput(), requires: { resources: ['storage'] } });
		expect(product.requires).toEqual(['storage']);
		expect(product.elements.codes?.requires).toEqual(['storage']);
		expect(product.elements.ai_copy?.requires).toEqual(['ai', 'storage']);
		const missing = resolve({ product, runtime: { resources: HEALTHY } });
		for (const key of ['codes', 'apply_box', 'reports', 'ai_copy'])
			expect(missing.elements[key], key).toMatchObject({ enabled: false, reason: 'resource_missing' });
		expect(missing.elements.ai_copy?.missing).toEqual(['storage']);
		const connected = resolve({ product, runtime: { resources: { ...HEALTHY, storage: 'connected' } } });
		expect(Object.values(connected.elements).every((element) => element.enabled)).toBe(true);
	});

	it('blocks hard-stop quotas when exhausted, not soft ones', () => {
		const doc = resolve({
			runtime: {
				resources: HEALTHY,
				usage: { 'codes.redemptions': 100, 'codes.softRedemptions': 500, 'codes.maxActive': 999, 'x.y': 1 },
			},
		});
		expect(doc.features['codes.redemptions']).toMatchObject({ blocked: true, reason: 'quota_exhausted', value: 100 });
		expect(doc.features['codes.softRedemptions']).toMatchObject({ blocked: false, reason: null });
		expect(doc.features['codes.maxActive']?.blocked).toBe(false);
		expect(doc.elements.codes?.enabled).toBe(true);
		const below = resolve({ runtime: { resources: HEALTHY, usage: { 'codes.redemptions': 99 } } });
		expect(below.features['codes.redemptions']?.blocked).toBe(false);
		const unlimited = resolve({
			layers: { admin: { features: { 'codes.redemptions': { value: null } } } },
			runtime: { usage: { 'codes.redemptions': 1e9 } },
		});
		expect(unlimited.features['codes.redemptions']?.blocked).toBe(false);
	});

	it('runtime.state pauses even when the subscription is active; cancelled outranks others', () => {
		expect(resolve({ runtime: { state: 'paused', resources: HEALTHY } }).state).toBe('paused');
		expect(resolve({ subscription: { ...SUB, status: 'cancelled' }, runtime: { state: 'suspended' } }).state).toBe('cancelled');
		expect(resolve({ subscription: { ...SUB, status: 'trialing' } }).state).toBe('active');
	});
});

describe('dependency cascades', () => {
	it('disabling an element disables its transitive dependents', () => {
		const doc = resolve({ layers: { website: { elements: { codes: false } } } });
		expect(doc.elements.codes).toMatchObject({ enabled: false, reason: 'website' });
		expect(doc.elements.apply_box).toMatchObject({ enabled: false, reason: 'dependency', blockedBy: ['codes'] });
		expect(doc.elements.reports).toMatchObject({ enabled: false, reason: 'dependency', blockedBy: ['apply_box'] });
		expect(doc.elements.ai_copy?.enabled).toBe(true);
	});

	it('does not auto-enable dependencies', () => {
		const doc = resolve({
			subscription: { ...SUB, plan: 'starter' },
			layers: { website: { elements: { codes: false, reports: true } } },
		});
		expect(doc.elements.reports).toMatchObject({ enabled: false, reason: 'dependency' });
	});
});

describe('determinism, order independence and versioning', () => {
	/** @type {Parameters<typeof resolveEntitlement>[0]['layers']} */
	const layers = {
		platform: {
			elements: { ai_copy: false },
			features: { 'codes.apiRate': { value: 90 }, 'codes.maxActive': { value: 70, locked: true } },
		},
		website: {
			elements: { reports: false },
			features: { 'codes.maxActive': { value: 80 }, 'codes.headline': { value: { en: 'Code?' } } },
		},
		admin: { features: { 'codes.bulk': { value: true } } },
	};
	/**
	 * Rebuilds an object with keys in a permuted order.
	 * @template {Record<string, unknown>} T
	 * @param {T} record
	 * @param {number[]} order
	 * @returns {T}
	 */
	const permute = (record, order) => {
		const keys = Object.keys(record);
		const permuted = order
			.map((i) => /** @type {string} */ (keys[i % keys.length]))
			.filter((k, i, arr) => arr.indexOf(k) === i);
		const rest = keys.filter((k) => !permuted.includes(k));
		return /** @type {T} */ (Object.fromEntries([...permuted, ...rest].map((k) => [k, record[k]])));
	};

	it('same inputs in any key/array order produce the identical document (property)', () => {
		const base = resolve({ layers, runtime: { resources: HEALTHY } });
		fc.assert(
			fc.property(fc.array(fc.nat(10), { maxLength: 6 }), (order) => {
				const shuffled = Object.fromEntries(
					Object.entries(permute(/** @type {Record<string, import('../src/resolve.js').LayerInput>} */ (layers), order)).map(
						([name, layer]) => [
							name,
							{
								features: layer.features && permute(layer.features, [...order].reverse()),
								elements: layer.elements && permute(layer.elements, order),
							},
						],
					),
				);
				const doc = resolve({
					layers: shuffled,
					runtime: { resources: permute(HEALTHY, order) },
				});
				expect(doc).toEqual(base);
				expect(JSON.stringify(doc)).toBe(JSON.stringify(base));
			}),
		);
	});

	it('does not mutate inputs', () => {
		expect(() =>
			resolve({
				layers: deepFreeze(structuredClone(layers)),
				runtime: deepFreeze({ resources: HEALTHY }),
			}),
		).not.toThrow();
	});

	it('contentHash hashes the effective content only', () => {
		const a = resolve({ layers });
		const later = resolve({ layers, now: '2026-10-02T00:00:00Z' });
		expect(later.resolvedAt).not.toBe(a.resolvedAt);
		expect(later.contentHash).toBe(a.contentHash);
		// An ignored attempt changes the report, not the version.
		const ignoredAttempt = resolve({
			layers: {
				...layers,
				website: { ...layers.website, features: { ...layers.website?.features, 'codes.maxActive': { value: 99 } } },
			},
		});
		expect(ignoredAttempt.contentHash).toBe(a.contentHash);
		expect(ignoredAttempt.report).not.toEqual(a.report);
		const changed = resolve({ layers: { ...layers, admin: { features: { 'codes.bulk': { value: false } } } } });
		expect(changed.contentHash).not.toBe(a.contentHash);
		expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
		expect(resolve({ layers, hash: (text) => `len:${text.length}` }).contentHash).toMatch(/^len:\d+$/);
	});

	it('produces the documented payload shape', () => {
		const doc = resolve();
		expect(Object.keys(doc)).toEqual([
			'schema',
			'subscriptionId',
			'productSlug',
			'productVersion',
			'plan',
			'priceBookVersion',
			'state',
			'elements',
			'features',
			'config',
			'contentHash',
			'resolvedAt',
			'report',
		]);
		expect(doc).toMatchObject({
			schema: 'entitlement@1',
			subscriptionId: 'sub_1',
			productSlug: 'coupons',
			productVersion: '1.4.0',
			plan: 'pro',
			priceBookVersion: '2026-06-01',
		});
		expect(Object.keys(doc.elements)).toEqual(['ai_copy', 'apply_box', 'codes', 'reports']);
		expect(doc.config.apply_box).toEqual({ delayMs: 0 });
	});
});
