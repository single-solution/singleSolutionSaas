import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
	currentPriceBook,
	elementDependencies,
	findPriceBook,
	isValidFeatureValue,
	normaliseFeatureKey,
	normaliseProduct,
	planDefaults,
	withinPlanMax,
} from '../src/catalog.js';
import {
	MILLICREDITS_PER_CREDIT,
	assertMillicredits,
	chargeFor,
	normaliseRate,
	rateFromCredits,
	toCredits,
	toMillicredits,
} from '../src/units.js';
import { bucketOf, deepEqual, stableStringify } from '../src/hash.js';
import { ceilHour, isoHour, isoInstant, toMs } from '../src/time.js';
import { coupons, couponsInput, deepFreeze } from './fixtures.js';

/**
 * @param {() => unknown} fn
 * @param {string} code
 */
const expectCode = (fn, code) => {
	try {
		fn();
	} catch (error) {
		expect(/** @type {{ code?: string }} */ (error).code).toBe(code);
		return;
	}
	throw new Error(`expected ${code}`);
};

describe('units', () => {
	it('converts credits to integer millicredits', () => {
		expect(MILLICREDITS_PER_CREDIT).toBe(1000);
		expect(toMillicredits(1)).toBe(1000);
		expect(toMillicredits(0.25)).toBe(250);
		expect(toMillicredits(0.001)).toBe(1);
		expect(toMillicredits(1.1)).toBe(1100);
		expect(toCredits(1250)).toBe(1.25);
		expect(() => toMillicredits(0.0001)).toThrow(RangeError);
		expect(() => toMillicredits(-1)).toThrow(RangeError);
		expect(() => toMillicredits(Number.NaN)).toThrow(RangeError);
		expect(assertMillicredits(5)).toBe(5);
		expect(() => assertMillicredits(1.5)).toThrow(RangeError);
	});

	it('builds reduced rates for sub-millicredit prices', () => {
		expect(rateFromCredits(0.01)).toEqual({ millicredits: 10, per: 1 });
		expect(rateFromCredits(0.00001)).toEqual({ millicredits: 1, per: 100 });
		expect(rateFromCredits(0.0000025)).toEqual({ millicredits: 1, per: 400 });
		expect(rateFromCredits(0)).toEqual({ millicredits: 0, per: 1 });
		expect(normaliseRate({ millicredits: 4, per: 8 })).toEqual({ millicredits: 1, per: 2 });
		expect(() => normaliseRate({ millicredits: 1, per: 0 })).toThrow(RangeError);
		expect(() => rateFromCredits(-1)).toThrow(RangeError);
		expect(() => rateFromCredits(1e-15)).toThrow(RangeError);
	});

	it('charges floor(quantity × rate) exactly', () => {
		expect(chargeFor(250, { millicredits: 1, per: 100 })).toBe(2);
		expect(chargeFor(7, { millicredits: 10, per: 1 })).toBe(70);
		expect(() => chargeFor(-1, { millicredits: 1, per: 1 })).toThrow(RangeError);
		fc.assert(
			fc.property(fc.nat(1_000_000), fc.nat(10_000), fc.integer({ min: 1, max: 1_000_000 }), (q, m, per) => {
				expect(chargeFor(q, { millicredits: m, per })).toBe(Math.floor((q * m) / per));
			}),
		);
	});
});

describe('hash and time helpers', () => {
	it('serialises with sorted keys', () => {
		expect(stableStringify({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
		expect(stableStringify(undefined)).toBe('null');
		expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		const b = bucketOf(['x', 'y']);
		expect(b).toBeGreaterThanOrEqual(0);
		expect(b).toBeLessThan(10000);
		expect(bucketOf(['x', 'y'])).toBe(b);
	});

	it('normalises instants', () => {
		expect(toMs(new Date(5))).toBe(5);
		expect(toMs('1970-01-01T00:00:01Z')).toBe(1000);
		expect(() => toMs('nope')).toThrow(RangeError);
		expect(isoHour(3_600_000)).toBe('1970-01-01T01:00:00Z');
		expect(isoInstant(1)).toBe('1970-01-01T00:00:00.001Z');
		expect(ceilHour(1)).toBe(3_600_000);
	});
});

/**
 * Minimal contracts-shaped manifest.
 * @param {Record<string, unknown>} [overrides]
 * @returns {never}
 */
const mini = (overrides = {}) =>
	/** @type {never} */ ({
		product: { slug: 's' },
		elements: [{ key: 'a' }],
		priceBook: { version: 'v', effectiveFrom: 0 },
		...overrides,
	});

/**
 * One element `a` with the given feature schema nodes.
 * @param {Record<string, unknown>} properties
 * @param {Record<string, unknown>} [overrides]
 */
const withFeatures = (properties, overrides = {}) =>
	mini({ elements: [{ key: 'a', features: { type: 'object', properties } }], ...overrides });

describe('normaliseProduct', () => {
	it('normalises elements, features (x-* metadata), plans and price books', () => {
		expect(coupons.slug).toBe('coupons');
		expect(coupons.version).toBe('1.4.0');
		expect(coupons.elementOrder).toEqual(['ai_copy', 'codes', 'apply_box', 'reports']);
		expect(coupons.elements.reports).toMatchObject({ dependsOn: ['apply_box'], requires: ['database'], defaultEnabled: false });
		expect(coupons.features['codes.redemptions']).toMatchObject({
			kind: 'quota',
			jsonType: 'integer',
			period: 'month',
			hardStop: true,
			unit: 'redemption',
			min: 0,
			max: null,
		});
		expect(coupons.features['codes.softRedemptions']).toMatchObject({ period: 'day', hardStop: false });
		expect(coupons.features['codes.apiRate']).toMatchObject({ kind: 'rate', per: 'minute', unit: null });
		expect(coupons.features['codes.maxActive']).toMatchObject({ kind: 'limit', min: 1, max: 10000, lockable: true });
		expect(coupons.features['codes.bulk']).toMatchObject({ kind: 'flag', default: false, min: null, max: null });
		expect(coupons.features['codes.layout']).toMatchObject({
			kind: 'config',
			experiment: true,
			enum: ['inline', 'collapsible', 'modal'],
		});
		expect(coupons.features['codes.pattern']?.lockable).toBe(false);
		expect(coupons.plans.starter).toEqual({
			code: 'starter',
			name: 'Starter',
			elements: ['apply_box', 'codes'],
			addons: ['reports'],
			available: ['apply_box', 'codes', 'reports'],
			defaults: { 'codes.maxActive': 50 },
			max: {
				'codes.maxActive': 100,
				'codes.bulk': false,
				'codes.apiRate': 120,
				'codes.headline': 20,
				'codes.tags': 2,
				'apply_box.delayMs': 1000,
			},
		});
		expect(coupons.plans.pro).toMatchObject({
			name: 'pro',
			addons: [],
			available: ['ai_copy', 'apply_box', 'codes', 'reports'],
		});
		expect(coupons.priceBooks.map((b) => b.version)).toEqual(['2026-01-01', '2026-06-01']);
		expect(coupons.priceBooks[0]).toMatchObject({
			baseHourly: 100,
			elements: { codes: 1000, apply_box: 500, reports: 250, ai_copy: 2000 },
		});
		expect(coupons.priceBooks[1]?.elements.codes).toBe(1500);
		expect(coupons.priceBooks[0]?.metered.redemption).toEqual({
			unit: 'redemption',
			element: 'codes',
			included: { starter: 500, pro: 5000 },
			overage: { millicredits: 10, per: 1 },
		});
	});

	it('accepts the single priceBook manifest form, bare requires arrays and infers kinds', () => {
		const product = normaliseProduct({
			product: { slug: 'notice' },
			elements: [
				{
					key: 'bar',
					defaultEnabled: true,
					requires: ['storage'],
					price: { metered: [{ unit: 'render', perUnit: 1, per: 1000 }] },
					features: {
						type: 'object',
						properties: {
							text: { type: 'string', title: 'Text', default: 'Hi' },
							on: { type: 'boolean', title: 'On', default: true },
							max: { type: 'integer', title: 'Max', 'x-kind': 'quota', 'x-period': 'week' },
							r: { type: 'number', title: 'R', default: 1.5, 'x-kind': 'rate', 'x-per': 'second', 'x-unit': 'render' },
							opt: { type: 'object', title: 'Opt', default: {}, properties: {} },
							list: { type: 'array', title: 'List' },
							n: { type: 'number', title: 'N' },
						},
					},
				},
			],
			priceBook: { version: 'v1', effectiveFrom: '2026-10-01T00:00:00Z' },
		});
		expect(product.version).toBe('0.0.0');
		expect(product.plans).toEqual({});
		expect(product.elements.bar?.requires).toEqual(['storage']);
		expect(product.features['bar.text']).toMatchObject({ kind: 'config', default: 'Hi' });
		expect(product.features['bar.on']).toMatchObject({ kind: 'flag' });
		expect(product.features['bar.max']).toMatchObject({ default: 0, period: 'week', hardStop: true });
		expect(product.features['bar.r']).toMatchObject({ per: 'second', unit: 'render' });
		expect(product.features['bar.list']?.default).toEqual([]);
		expect(product.features['bar.n']).toMatchObject({ default: 0, min: null });
		expect(product.priceBooks[0]).toMatchObject({
			baseHourly: 0,
			elements: { bar: 0 },
			metered: { render: { overage: { millicredits: 1, per: 1000 } } },
		});
		expect(planDefaults(product, null)).toMatchObject({ elements: { bar: true }, available: ['bar'] });
	});

	it('supports price-book overrides of metered units', () => {
		const product = normaliseProduct({
			...couponsInput(),
			priceBooks: [{ version: 'x', effectiveFrom: 0, metered: [{ unit: 'redemption', perUnit: 1, per: 10 }] }],
		});
		expect(product.priceBooks[0]?.metered.redemption?.overage).toEqual({ millicredits: 1, per: 10 });
	});

	it('does not mutate its input', () => {
		expect(() => normaliseProduct(deepFreeze(couponsInput()))).not.toThrow();
	});

	it.each([
		['missing_slug', () => mini({ product: {} })],
		['no_elements', () => mini({ elements: [] })],
		['invalid_key', () => mini({ elements: [{ key: 'Bad' }] })],
		['duplicate_element', () => mini({ elements: [{ key: 'a' }, { key: 'a' }] })],
		['unknown_dependency', () => mini({ elements: [{ key: 'a', dependsOn: ['b'] }] })],
		[
			'dependency_cycle',
			() =>
				mini({
					elements: [
						{ key: 'a', dependsOn: ['b'] },
						{ key: 'b', dependsOn: ['a'] },
					],
				}),
		],
		['no_price_book', () => mini({ priceBook: undefined })],
		['invalid_feature_type', () => withFeatures({ f: { type: 'nope' } })],
		['invalid_feature_type', () => withFeatures({ f: 'x' })],
		['invalid_key', () => withFeatures({ '1f': { type: 'boolean' } })],
		['invalid_feature_kind', () => withFeatures({ f: { type: 'integer', 'x-kind': 'nope' } })],
		['invalid_feature_kind', () => withFeatures({ f: { type: 'integer', 'x-kind': 'flag' } })],
		['invalid_feature_kind', () => withFeatures({ f: { type: 'string', 'x-kind': 'limit' } })],
		['invalid_period', () => withFeatures({ f: { type: 'integer', 'x-kind': 'quota' } })],
		['invalid_period', () => withFeatures({ f: { type: 'integer', 'x-kind': 'rate' } })],
		['invalid_period', () => withFeatures({ f: { type: 'integer', 'x-kind': 'quota', 'x-period': 'year' } })],
		['invalid_period', () => withFeatures({ f: { type: 'integer', 'x-kind': 'rate', 'x-per': 'day' } })],
		['invalid_bounds', () => withFeatures({ f: { type: 'integer', minimum: 5, maximum: 2 } })],
		['invalid_default', () => withFeatures({ f: { type: 'boolean', default: 1 } })],
		['invalid_default', () => withFeatures({ f: { type: 'integer', 'x-kind': 'limit', default: 20, maximum: 10 } })],
		['invalid_default', () => withFeatures({ f: { type: 'integer', 'x-kind': 'limit', default: null, maximum: 10 } })],
		['invalid_default', () => withFeatures({ f: { type: 'string', default: 'toolong', maxLength: 3 } })],
		['invalid_default', () => withFeatures({ f: { type: 'string', default: 'b', enum: ['a'] } })],
		['unknown_unit', () => withFeatures({ f: { type: 'integer', 'x-kind': 'quota', 'x-period': 'day', 'x-unit': 'x' } })],
		['unknown_plan', () => withFeatures({ f: { type: 'integer', 'x-plan': { gold: { max: 1 } } } })],
		[
			'invalid_plan',
			() =>
				withFeatures({ f: { type: 'integer', 'x-plan': { p: { max: true } } } }, { plans: [{ code: 'p', elements: ['a'] }] }),
		],
		[
			'invalid_plan',
			() => withFeatures({ f: { type: 'boolean', 'x-plan': { p: { max: 1 } } } }, { plans: [{ code: 'p', elements: ['a'] }] }),
		],
		[
			'invalid_plan',
			() =>
				withFeatures(
					{ f: { type: 'integer', 'x-kind': 'limit', 'x-plan': { p: { default: 20, max: 10 } } } },
					{ plans: [{ code: 'p', elements: ['a'] }] },
				),
		],
		[
			'invalid_plan',
			() =>
				withFeatures({ f: { type: 'string', 'x-plan': { p: { default: 7 } } } }, { plans: [{ code: 'p', elements: ['a'] }] }),
		],
		[
			'duplicate_plan',
			() =>
				mini({
					plans: [
						{ code: 'p', elements: [] },
						{ code: 'p', elements: [] },
					],
				}),
		],
		['invalid_plan', () => mini({ plans: [{ code: '', elements: [] }] })],
		['unknown_element', () => mini({ plans: [{ code: 'p', elements: ['z'] }] })],
		['unknown_element', () => mini({ plans: [{ code: 'p', elements: [], addons: ['z'] }] })],
		['invalid_plan', () => mini({ plans: [{ code: 'p', elements: ['a'], addons: ['a'] }] })],
		[
			'invalid_plan',
			() =>
				mini({
					elements: [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }],
					plans: [{ code: 'p', elements: ['b'], addons: ['a'] }],
				}),
		],
		[
			'invalid_plan',
			() =>
				mini({
					elements: [{ key: 'a' }, { key: 'b', dependsOn: ['a'] }],
					plans: [{ code: 'p', elements: [], addons: ['b'] }],
				}),
		],
		['invalid_price', () => mini({ elements: [{ key: 'a', price: { hourly: 1.5 } }] })],
		['invalid_key', () => mini({ elements: [{ key: 'a', price: { metered: [{ unit: 'X', perUnit: 1 }] } }] })],
		['invalid_price', () => mini({ elements: [{ key: 'a', price: { metered: [{ unit: 'x' }] } }] })],
		['invalid_price', () => mini({ elements: [{ key: 'a', price: { metered: [{ unit: 'x', perUnit: 0.5 }] } }] })],
		[
			'unknown_plan',
			() => mini({ elements: [{ key: 'a', price: { metered: [{ unit: 'x', perUnit: 1, included: { gold: 1 } }] } }] }),
		],
		[
			'invalid_price',
			() =>
				mini({
					elements: [{ key: 'a', price: { metered: [{ unit: 'x', perUnit: 1, included: { p: -1 } }] } }],
					plans: [{ code: 'p', elements: ['a'] }],
				}),
		],
		[
			'duplicate_unit',
			() =>
				mini({
					elements: [
						{ key: 'a', price: { metered: [{ unit: 'x', perUnit: 1 }] } },
						{ key: 'b', price: { metered: [{ unit: 'x', perUnit: 1 }] } },
					],
				}),
		],
		['invalid_price_book', () => mini({ priceBooks: [{ version: '', effectiveFrom: 0 }] })],
		[
			'duplicate_price_book',
			() =>
				mini({
					priceBooks: [
						{ version: 'v', effectiveFrom: 0 },
						{ version: 'v', effectiveFrom: 1 },
					],
				}),
		],
		['unknown_element', () => mini({ priceBooks: [{ version: 'v', effectiveFrom: 0, elements: { z: 1 } }] })],
		['invalid_price', () => mini({ priceBooks: [{ version: 'v', effectiveFrom: 0, base: -1 }] })],
		['unknown_element', () => mini({ priceBooks: [{ version: 'v', effectiveFrom: 0, metered: [{ unit: 'q', perUnit: 1 }] }] })],
	])('rejects %s', (code, build) => {
		expectCode(() => normaliseProduct(build()), `catalog/${code}`);
	});

	it('sorts price books with equal effectiveFrom by version', () => {
		const product = normaliseProduct(
			mini({
				priceBooks: [
					{ version: 'b', effectiveFrom: 0 },
					{ version: 'a', effectiveFrom: 0 },
				],
			}),
		);
		expect(product.priceBooks.map((b) => b.version)).toEqual(['a', 'b']);
	});
});

describe('catalog helpers', () => {
	it('computes transitive dependencies and dependents', () => {
		expect(elementDependencies(coupons, 'reports')).toEqual({ dependsOn: ['apply_box', 'codes'], dependents: [] });
		expect(elementDependencies(coupons, 'codes')).toEqual({ dependsOn: [], dependents: ['apply_box', 'reports'] });
		expectCode(() => elementDependencies(coupons, 'zzz'), 'catalog/unknown_element');
	});

	it('returns plan defaults', () => {
		const starter = planDefaults(coupons, 'starter');
		expect(starter.elements).toEqual({ codes: true, apply_box: true, reports: false, ai_copy: false });
		expect(starter.available).toEqual(['apply_box', 'codes', 'reports']);
		expect(starter.features['codes.maxActive']).toBe(50);
		expect(starter.features['codes.layout']).toBe('inline');
		expect(planDefaults(coupons, undefined).elements.codes).toBe(false);
	});

	it('finds price books', () => {
		expect(findPriceBook(coupons, '2026-06-01')?.elements.codes).toBe(1500);
		expect(findPriceBook(coupons, 'nope')).toBeUndefined();
		expect(currentPriceBook(coupons, '2026-05-31T23:59:59Z')?.version).toBe('2026-01-01');
		expect(currentPriceBook(coupons, '2026-06-01T00:00:00Z')?.version).toBe('2026-06-01');
		expect(currentPriceBook(coupons, '2025-01-01T00:00:00Z')).toBeUndefined();
	});

	it('validates values and plan bounds', () => {
		const f = (/** @type {string} */ key) => /** @type {import('../src/catalog.js').FeatureDef} */ (coupons.features[key]);
		expect(isValidFeatureValue(f('codes.layout'), 'modal')).toBe(true);
		expect(isValidFeatureValue(f('codes.layout'), 'other')).toBe(false);
		expect(isValidFeatureValue(f('codes.headline'), 'x'.repeat(41))).toBe(false);
		expect(isValidFeatureValue(f('codes.headline'), null)).toBe(false);
		expect(isValidFeatureValue(f('codes.tags'), ['a'])).toBe(true);
		expect(isValidFeatureValue(f('codes.tags'), 'a')).toBe(false);
		expect(isValidFeatureValue(f('codes.theme'), {})).toBe(true);
		expect(isValidFeatureValue(f('codes.theme'), [])).toBe(false);
		expect(isValidFeatureValue(f('codes.maxActive'), null)).toBe(true);
		expect(isValidFeatureValue(f('codes.maxActive'), 1.5)).toBe(false);
		const n = normaliseProduct(withFeatures({ x: { type: 'number', title: 'x', default: 0.5 } })).features['a.x'];
		expect(n && isValidFeatureValue(n, 0.25)).toBe(true);
		expect(n && isValidFeatureValue(n, Number.NaN)).toBe(false);
		expect(withinPlanMax(f('codes.maxActive'), 5, undefined)).toBe(true);
		expect(withinPlanMax(f('codes.maxActive'), null, 10)).toBe(false);
		expect(withinPlanMax(f('codes.bulk'), true, false)).toBe(false);
		expect(withinPlanMax(f('codes.bulk'), false, false)).toBe(true);
		expect(withinPlanMax(f('codes.bulk'), true, true)).toBe(true);
		expect(withinPlanMax(f('codes.headline'), 'abc', 2)).toBe(false);
		expect(withinPlanMax(f('codes.tags'), ['a'], 1)).toBe(true);
		expect(withinPlanMax(f('codes.theme'), {}, 1)).toBe(true);
		expect(withinPlanMax(f('codes.headline'), null, 1)).toBe(true);
		expect(normaliseFeatureKey('a.features.b')).toBe('a.b');
		expect(normaliseFeatureKey('a.b')).toBe('a.b');
	});
});
