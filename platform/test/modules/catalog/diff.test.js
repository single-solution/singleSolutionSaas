import { describe, expect, it } from 'vitest';
import { compareRates, diffManifests } from '../../../src/modules/catalog/core/diff.js';
import { serviceManifest } from './fixtures.js';

/** @param {any} diff */
const codes = (diff) => diff.breaking.map((/** @type {any} */ b) => b.code).sort();

/**
 * @param {(m: any) => void} change
 */
const after = (change) => {
	const m = serviceManifest();
	change(m);
	return m;
};

const codes0 = (/** @type {any} */ m) => m.elements[0];

describe('manifest diff', () => {
	it('reports nothing for identical manifests', () => {
		const diff = diffManifests(serviceManifest(), serviceManifest());
		expect(diff).toMatchObject({ changed: false, isBreaking: false, breaking: [], prices: [], features: [] });
		expect(diff.elements).toEqual({ added: [], removed: [], changed: [] });
		expect(diff.plans).toEqual({ added: [], removed: [], changed: [] });
	});

	it('treats a first version as all additions, never breaking', () => {
		const diff = diffManifests(null, serviceManifest());
		expect(diff.elements.added).toEqual(['apply_box', 'codes']);
		expect(diff.plans.added).toEqual(['starter']);
		expect(diff.isBreaking).toBe(false);
		expect(diff.version).toEqual({ from: null, to: '1.4.0' });
	});

	/** @type {Array<[string, (m: any) => void, string[]]>} */
	const matrix = [
		['element added', (m) => m.elements.push({ ...m.elements[1], key: 'extra', dependsOn: [] }), []],
		[
			'element removed',
			(m) => {
				m.elements = m.elements.filter((/** @type {any} */ e) => e.key !== 'apply_box');
				m.plans[0].elements = ['codes'];
			},
			['element_removed', 'plan_element_removed'],
		],
		['hourly price increase', (m) => (codes0(m).price.hourly = 2000), ['price_increase']],
		['hourly price decrease', (m) => (codes0(m).price.hourly = 500), []],
		['metered rate increase', (m) => (codes0(m).price.metered[0].perUnit = 20), ['price_increase']],
		[
			'metered rate same value, different fraction',
			(m) => Object.assign(codes0(m).price.metered[0], { perUnit: 20, per: 2 }),
			[],
		],
		['metered rate decrease via per', (m) => (codes0(m).price.metered[0].per = 3), []],
		['included quota lowered', (m) => (codes0(m).price.metered[0].included.starter = 100), ['price_increase']],
		['included quota raised', (m) => (codes0(m).price.metered[0].included.starter = 900), []],
		['new metered unit', (m) => codes0(m).price.metered.push({ unit: 'validation', perUnit: 1 }), ['price_increase']],
		['metered unit removed', (m) => delete codes0(m).price.metered, []],
		['feature added', (m) => (codes0(m).features.properties.newFlag = { type: 'boolean', title: 'New', default: false }), []],
		['feature removed', (m) => delete codes0(m).features.properties.prefix, ['feature_removed']],
		['nested feature removed', (m) => delete codes0(m).features.properties.window.properties.days, ['feature_removed']],
		['max lowered', (m) => (codes0(m).features.properties.maxActive.maximum = 500), ['max_lowered']],
		['max raised', (m) => (codes0(m).features.properties.maxActive.maximum = 900000), []],
		['max newly imposed', (m) => (codes0(m).features.properties.allowStacking.maxLength = 3), ['max_lowered']],
		['maxLength lowered', (m) => (codes0(m).features.properties.prefix.maxLength = 6), ['max_lowered']],
		['maxItems lowered', (m) => (codes0(m).features.properties.channels.maxItems = 2), ['max_lowered']],
		['nested max lowered', (m) => (codes0(m).features.properties.window.properties.days.maximum = 365), ['max_lowered']],
		['plan max lowered', (m) => (codes0(m).features.properties.maxActive['x-plan'].starter.max = 20), ['max_lowered']],
		['plan max raised', (m) => (codes0(m).features.properties.maxActive['x-plan'].starter.max = 80), []],
		[
			'plan max newly imposed',
			(m) => (codes0(m).features.properties.prefix['x-plan'] = { starter: { max: 4 } }),
			['max_lowered'],
		],
		['min raised', (m) => (codes0(m).features.properties.maxActive.minimum = 5), ['min_raised']],
		['min lowered', (m) => (codes0(m).features.properties.validateRate.minimum = 0), []],
		['type changed', (m) => (codes0(m).features.properties.prefix.type = 'integer'), ['feature_type_changed']],
		[
			'enum value removed in items',
			(m) => (codes0(m).features.properties.channels.items.enum = ['web']),
			['enum_value_removed'],
		],
		['items added', (m) => (codes0(m).features.properties.prefix.items = { type: 'string' }), []],
		['enum on node restricted', (m) => (codes0(m).features.properties.prefix.enum = ['SAVE']), ['enum_value_removed']],
		['default changed', (m) => (codes0(m).features.properties.prefix.default = 'OFF'), []],
		['mode removed', (m) => (m.elements[1].modes = ['A', 'B']), ['mode_removed']],
		['plan added', (m) => m.plans.push({ code: 'pro', elements: ['codes', 'apply_box'] }), []],
		['plan removed', (m) => (m.plans = []), ['plan_removed']],
		['plan element dropped', (m) => (m.plans[0].elements = ['codes']), ['plan_element_removed']],
		['plan element moved to add-on', (m) => Object.assign(m.plans[0], { elements: ['codes'], addons: ['apply_box'] }), []],
		['plan renamed', (m) => (m.plans[0].name = 'Basic'), []],
		['endpoints changed', (m) => (m.endpoints.base = 'https://coupons2.example.dev'), []],
		['scopes changed', (m) => m.scopes.push('graph.item.read'), []],
	];

	it.each(matrix)('%s', (_name, change, expected) => {
		const diff = diffManifests(serviceManifest(), after(change));
		expect(codes(diff)).toEqual([...expected].sort());
		expect(diff.isBreaking).toBe(expected.length > 0);
		expect(diff.changed).toBe(true);
	});

	it('details element, price, plan, feature and other changes', () => {
		const diff = diffManifests(
			serviceManifest(),
			after((m) => {
				m.product.version = '1.5.0';
				codes0(m).price.hourly = 1500;
				codes0(m).price.metered[0].perUnit = 5;
				codes0(m).features.properties.maxActive.maximum = 500;
				codes0(m).features.properties.extra = { type: 'boolean', title: 'Extra', default: true };
				m.plans[0].elements = ['codes'];
				m.plans[0].addons = ['apply_box'];
				m.plans.push({ code: 'pro', elements: ['codes'] });
				m.scopes = m.scopes.filter((/** @type {string} */ s) => s !== 'messaging.send');
				m.trialHours = 24;
				m.priceBook.version = '2026-11-01';
				m.events.publishes = [];
				m.capabilities.sandbox = false;
				m.requires.resources = [];
			}),
		);
		expect(diff.version).toEqual({ from: '1.4.0', to: '1.5.0' });
		expect(diff.elements.changed).toEqual([{ key: 'codes', fields: ['features', 'price'] }]);
		expect(diff.prices).toEqual([
			{ element: 'codes', field: 'hourly', from: 1000, to: 1500, direction: 'increase' },
			{
				element: 'codes',
				field: 'metered:redemption',
				from: { perUnit: 10, per: 1 },
				to: { perUnit: 5, per: 1 },
				direction: 'decrease',
			},
		]);
		expect(diff.features).toEqual([
			{ element: 'codes', feature: 'extra', change: 'added', fields: [] },
			{ element: 'codes', feature: 'maxActive', change: 'changed', fields: ['maximum'] },
		]);
		expect(diff.plans).toEqual({
			added: ['pro'],
			removed: [],
			changed: [
				{ code: 'starter', elementsAdded: [], elementsRemoved: ['apply_box'], addonsAdded: ['apply_box'], addonsRemoved: [] },
			],
		});
		expect(diff.other).toEqual({
			priceBook: true,
			endpoints: false,
			capabilities: true,
			scopesAdded: [],
			scopesRemoved: ['messaging.send'],
			eventsChanged: true,
			requiresChanged: true,
			trialHours: true,
		});
		expect(codes(diff)).toEqual(['max_lowered', 'price_increase']);
		expect(diff.breaking.find((b) => b.code === 'price_increase')?.path).toBe('elements.codes.price.hourly');
	});

	it('reports removed metered units and quota changes in prices', () => {
		const diff = diffManifests(
			serviceManifest(),
			after((m) => delete codes0(m).price.metered),
		);
		expect(diff.prices).toEqual([expect.objectContaining({ field: 'metered:redemption', direction: 'removed', to: null })]);
		const quota = diffManifests(
			serviceManifest(),
			after((m) => (codes0(m).price.metered[0].included = { pro: 10 })),
		);
		expect(quota.prices.map((p) => [p.field, p.direction])).toEqual([
			['included:redemption:pro', 'decrease'],
			['included:redemption:starter', 'increase'],
		]);
	});

	it('compares rates exactly', () => {
		expect(compareRates({ perUnit: 1, per: 3 }, { perUnit: 2, per: 6 })).toBe(0);
		expect(compareRates({ perUnit: 1, per: 3 }, { perUnit: 1 })).toBe(1);
		expect(compareRates({ perUnit: 1 }, { perUnit: 1, per: 3 })).toBe(-1);
		expect(compareRates({ perUnit: Number.MAX_SAFE_INTEGER, per: 1 }, { perUnit: Number.MAX_SAFE_INTEGER, per: 2 })).toBe(-1);
	});

	it('handles flags in x-plan max and missing feature schemas', () => {
		const before = serviceManifest();
		codes0(before).features.properties.allowStacking['x-plan'] = { starter: { max: true } };
		const next = structuredClone(before);
		codes0(next).features.properties.allowStacking['x-plan'] = { starter: { max: false } };
		expect(codes(diffManifests(before, next))).toEqual(['max_lowered']);
		const noFeatures = structuredClone(before);
		delete codes0(noFeatures).features;
		expect(codes(diffManifests(before, noFeatures))).toEqual(Array(7).fill('feature_removed'));
		expect(codes(diffManifests(noFeatures, before))).toEqual([]);
	});
});
