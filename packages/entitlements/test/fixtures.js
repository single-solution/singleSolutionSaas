import { normaliseProduct } from '../src/catalog.js';

/**
 * Recursively freezes a value so any mutation by the code under test throws (ESM is strict mode).
 * @template T
 * @param {T} value
 * @returns {T}
 */
export const deepFreeze = (value) => {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
};

/**
 * Contracts-shaped (SSPS v1) manifest of a Coupons product used across tests. Prices are integer
 * millicredits; per-plan bounds live only in `x-plan`. `priceBooks` is the Portal-side history.
 * @returns {import('../src/catalog.js').ProductInput}
 */
export const couponsInput = () => ({
	product: { slug: 'coupons', version: '1.4.0' },
	elements: [
		{
			key: 'codes',
			name: 'Coupon codes',
			price: { hourly: 1000, metered: [{ unit: 'redemption', perUnit: 10, included: { starter: 500, pro: 5000 } }] },
			features: {
				type: 'object',
				properties: {
					maxActive: {
						type: 'integer',
						title: 'Max active codes',
						default: 10,
						minimum: 1,
						maximum: 10000,
						'x-kind': 'limit',
						'x-plan': { starter: { default: 50, max: 100 }, pro: { default: 50, max: 1000 } },
					},
					redemptions: {
						type: 'integer',
						title: 'Redemptions',
						default: 100,
						'x-kind': 'quota',
						'x-period': 'month',
						'x-unit': 'redemption',
					},
					softRedemptions: {
						type: 'integer',
						title: 'Soft',
						default: 100,
						'x-kind': 'quota',
						'x-period': 'day',
						'x-hardStop': false,
					},
					bulk: { type: 'boolean', title: 'Bulk', default: false, 'x-kind': 'flag', 'x-plan': { starter: { max: false } } },
					apiRate: {
						type: 'integer',
						title: 'API rate',
						default: 60,
						'x-kind': 'rate',
						'x-per': 'minute',
						'x-plan': { starter: { max: 120 } },
					},
					layout: {
						type: 'string',
						title: 'Layout',
						default: 'inline',
						enum: ['inline', 'collapsible', 'modal'],
					},
					pattern: { type: 'string', title: 'Pattern', default: 'SAVE-####', 'x-lock': false },
					headline: {
						type: 'string',
						title: 'Headline',
						default: 'Have a code?',
						maxLength: 40,
						'x-plan': { starter: { max: 20 } },
					},
					tags: {
						type: 'array',
						title: 'Tags',
						default: [],
						items: { type: 'string' },
						'x-plan': { starter: { max: 2 } },
					},
					theme: { type: 'object', title: 'Theme', default: {}, properties: {} },
				},
			},
		},
		{
			key: 'apply_box',
			name: 'Apply box',
			price: { hourly: 500 },
			dependsOn: ['codes'],
			features: {
				type: 'object',
				properties: {
					delayMs: {
						type: 'integer',
						title: 'Delay',
						default: 0,
						'x-kind': 'limit',
						'x-plan': { starter: { max: 1000 } },
					},
				},
			},
		},
		{
			key: 'reports',
			name: 'Reports',
			price: { hourly: 250 },
			dependsOn: ['apply_box'],
			requires: { resources: ['database'] },
		},
		{ key: 'ai_copy', name: 'AI copy', price: { hourly: 2000 }, requires: { resources: ['ai'] } },
	],
	plans: [
		{ code: 'starter', name: 'Starter', elements: ['codes', 'apply_box'], addons: ['reports'] },
		{ code: 'pro', elements: ['codes', 'apply_box', 'reports', 'ai_copy'] },
	],
	priceBooks: [
		{ version: '2026-01-01', effectiveFrom: '2026-01-01T00:00:00Z', base: 100 },
		{ version: '2026-06-01', effectiveFrom: '2026-06-01T00:00:00Z', base: 100, elements: { codes: 1500 } },
	],
});

export const coupons = deepFreeze(normaliseProduct(deepFreeze(couponsInput())));

export const NOW = '2026-10-01T12:00:00Z';

/** Connected resources for every requirement in the fixture. */
export const HEALTHY = { database: 'connected', ai: 'connected' };
