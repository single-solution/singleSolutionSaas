/**
 * Test fixtures of the config module: a coupons manifest (two versions), ids.
 * @module
 */

export const APP = 'app_coupons';
export const MER_A = 'mer_aaaaaaaaaaaaaaaaaaaaaaaaaa';
export const MER_B = 'mer_bbbbbbbbbbbbbbbbbbbbbbbbbb';
export const WEB_A1 = 'web_a1a1a1a1a1a1a1a1a1a1a1a1a1';
export const WEB_A2 = 'web_a2a2a2a2a2a2a2a2a2a2a2a2a2';
export const WEB_A3 = 'web_a3a3a3a3a3a3a3a3a3a3a3a3a3';
export const WEB_B1 = 'web_b1b1b1b1b1b1b1b1b1b1b1b1b1';
export const SUB_A1 = 'sub_a1a1a1a1a1a1a1a1a1a1a1a1a1';
export const SUB_A2 = 'sub_a2a2a2a2a2a2a2a2a2a2a2a2a2';
export const SUB_B1 = 'sub_b1b1b1b1b1b1b1b1b1b1b1b1b1';

/**
 * @param {string} [version]
 * @returns {any}
 */
export const manifest = (version = '1.4.0') => ({
	ssps: '1',
	product: { slug: 'coupons', name: 'Coupons', kind: 'service', version, category: 'commerce' },
	endpoints: {
		base: 'https://coupons.example.dev',
		events: '/.well-known/ss-events',
		register: '/.well-known/ss-register',
	},
	scopes: ['events.subscribe:order.*'],
	events: { consumes: ['order.placed@1'], publishes: [] },
	elements: [
		{
			key: 'codes',
			name: 'Coupon codes',
			modes: ['C'],
			price: { hourly: 1000 },
			api: { resources: ['coupons'] },
			experiments: true,
			features: {
				type: 'object',
				additionalProperties: false,
				properties: {
					maxActive: {
						type: 'integer',
						title: 'Maximum active codes',
						default: 20,
						minimum: 1,
						maximum: 100000,
						'x-kind': 'limit',
						'x-plan': { starter: { default: 10, max: 50 } },
					},
					allowStacking: {
						type: 'boolean',
						title: 'Allow stacking',
						default: false,
						'x-kind': 'flag',
						'x-experiment': true,
					},
					prefix: {
						type: 'string',
						title: 'Code prefix',
						default: 'SAVE',
						maxLength: 12,
						pattern: '^[A-Z0-9]*$',
						'x-experiment': true,
					},
					note: { type: 'string', title: 'Internal note', default: '', maxLength: 50, 'x-lock': false },
					window: {
						type: 'object',
						title: 'Validity window',
						default: { days: 30 },
						required: ['days'],
						properties: { days: { type: 'integer', minimum: 1, maximum: 3650 } },
						additionalProperties: false,
					},
				},
			},
		},
		{
			key: 'banner',
			name: 'Promo banner',
			modes: ['C'],
			price: { hourly: 0 },
			dependsOn: ['codes'],
			features: {
				type: 'object',
				additionalProperties: false,
				properties: {
					text: { type: 'string', title: 'Text', default: 'Sale', maxLength: 40 },
				},
			},
		},
	],
	plans: [{ code: 'starter', name: 'Starter', elements: ['codes'], addons: ['banner'] }],
	priceBook: { version: '2026-10-01', effectiveFrom: '2026-10-01T00:00:00Z' },
});
