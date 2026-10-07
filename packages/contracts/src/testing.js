/**
 * `@ss/contracts/testing` — fresh, valid fixtures for every schema. Each call returns a new deep copy so tests may mutate freely.
 * @module
 */

export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const SUBSCRIPTION = 'sub_0123456789abcdefghjkmnpq';

/** @returns {any} */
export const manifest = () => ({
	ssps: '1',
	product: { slug: 'coupons', name: 'Coupons', kind: 'service', version: '1.4.0', category: 'commerce' },
	endpoints: {
		base: 'https://coupons.example.dev',
		dashboard: '/dashboard',
		events: '/.well-known/ss-events',
	},
	capabilities: { adminLaunch: true },
	scopes: [
		'graph.customer.read',
		'graph.order.read',
		'events.subscribe:order.*',
		'events.subscribe:cart.updated',
		'messaging.send',
	],
	requires: { resources: ['database'] },
	events: { consumes: ['order.placed@1', 'cart.updated@1'], publishes: ['coupons.redeemed@1'] },
	elements: [
		{
			key: 'codes',
			name: 'Coupon codes',
			modes: ['C'],
			stateful: true,
			price: { hourly: 1000, metered: [{ unit: 'redemption', perUnit: 10, included: { starter: 500 } }] },
			dependsOn: [],
			requires: { resources: ['database'] },
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
						'x-lock': true,
						'x-ui': { widget: 'number', group: 'Limits', order: 1 },
					},
					allowStacking: {
						type: 'boolean',
						title: 'Allow stacking',
						default: false,
						'x-kind': 'flag',
					},
					monthlyRedemptions: {
						type: 'integer',
						title: 'Redemptions per month',
						default: 1000,
						minimum: 0,
						maximum: 10000000,
						'x-kind': 'quota',
						'x-period': 'month',
						'x-hardStop': false,
						'x-unit': 'redemption',
						'x-plan': { starter: { default: 500, max: 500 } },
					},
					validateRate: {
						type: 'integer',
						title: 'Validations per minute',
						default: 60,
						minimum: 1,
						maximum: 6000,
						'x-kind': 'rate',
						'x-per': 'minute',
						'x-unit': 'request',
						'x-lock': true,
					},
					prefix: { type: 'string', title: 'Code prefix', default: 'SAVE', maxLength: 12, pattern: '^[A-Z0-9]*$' },
					channels: {
						type: 'array',
						title: 'Channels',
						default: ['web'],
						items: { type: 'string', enum: ['web', 'pos', 'app'] },
						maxItems: 3,
						uniqueItems: true,
					},
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
			strings: 'strings/codes.json',
			placement: false,
			rules: ['eligibility'],
			hooks: ['beforeRedeem', 'afterRedeem'],
			customFields: ['coupon'],
			api: { resources: ['coupons', 'redemptions'] },
			headless: null,
			renderer: null,
		},
		{
			key: 'apply_box',
			name: 'Coupon apply box',
			modes: ['A', 'B', 'C'],
			price: { hourly: 0 },
			dependsOn: ['codes'],
			placement: true,
			headless: 'headless/applyBox.js#createApplyBox',
			renderer: 'ui/applyBox.js#render',
			variants: ['inline', 'collapsible'],
			slots: ['before', 'after', 'success'],
			a11y: { role: 'form', labels: true },
		},
	],
	plans: [{ code: 'starter', name: 'Starter', elements: ['codes', 'apply_box'] }],
	priceBook: { version: '2026-10-01', effectiveFrom: '2026-10-01T00:00:00Z' },
	trialHours: 48,
	retention: { redemptions: 'P365D' },
});

/** @returns {any} */
export const packManifest = () => ({
	ssps: '1',
	product: { slug: 'notice-bar', name: 'Notice bar', kind: 'pack', version: '0.1.0', category: 'storefront' },
	elements: [
		{
			key: 'bar',
			name: 'Notice bar',
			modes: ['A', 'B'],
			price: { hourly: 0 },
			placement: true,
			headless: 'headless/bar.js#createBar',
			renderer: 'ui/bar.js#render',
		},
	],
	priceBook: { version: '1', effectiveFrom: '2026-01-01T00:00:00.000Z' },
});

/** @returns {any} */
export const entitlement = () => ({
	subscriptionId: SUBSCRIPTION,
	websiteId: WEBSITE,
	merchantId: MERCHANT,
	domain: 'shop.example.com',
	allowSubdomains: false,
	env: 'live',
	productSlug: 'coupons',
	planCode: 'starter',
	priceBookVersion: '2026-10-01',
	version: 7,
	issuedAt: '2026-10-01T10:00:00Z',
	validFrom: '2026-10-01T10:00:00Z',
	validUntil: '2026-10-01T10:05:00Z',
	elements: { codes: { enabled: true }, apply_box: { enabled: false, reason: 'merchant_disabled' } },
	features: {
		'codes.maxActive': { value: 50, source: 'plan_default', locked: false },
		'codes.window.days': { value: 30, source: 'product_default', locked: true, reason: 'admin_lock' },
	},
	config: { codes: { prefix: 'SAVE' } },
	runtime: { state: 'active' },
	resources: [{ kind: 'database', ref: 'res_db_1', status: 'connected' }],
	dataScope: { prefix: 'ss_coupons_' },
});

/**
 * @param {string} type
 * @param {Record<string, unknown>} data
 * @returns {any}
 */
export const event = (type, data) => ({
	id: 'evt_0123456789abcdefghjkmnpq',
	type,
	websiteId: WEBSITE,
	env: 'test',
	occurredAt: '2026-10-01T12:34:56.789Z',
	idempotencyKey: 'order-42-placed',
	actor: { type: 'customer', id: 'cus_1' },
	data,
	context: { source: 'loader', locale: 'pt-BR', sessionId: 'ses_1', pageUrl: 'https://shop.example.com/cart' },
});

const lines = [{ itemId: 'itm_1', variantId: 'v1', quantity: 2, unitAmount: 1999, totalAmount: 3998 }];

/** Valid data for every standard event. */
export const standardEventData = () => ({
	'customer.created@1': { customerId: 'cus_1', identities: [{ type: 'email', value: 'a@example.com' }], source: 'signup' },
	'customer.updated@1': { customerId: 'cus_1', changed: ['name'] },
	'customer.signed_in@1': { customerId: 'cus_1', method: 'magic_link' },
	'page.viewed@1': { url: 'https://shop.example.com/p/1', path: '/p/1', title: 'Item', pageType: 'product' },
	'item.viewed@1': { itemId: 'itm_1', price: { amount: 1500, currency: 'JPY' } },
	'cart.updated@1': { cartId: 'crt_1', currency: 'EUR', lines, subtotalAmount: 3998 },
	'order.placed@1': {
		orderId: 'ord_1',
		number: '1001',
		currency: 'KWD',
		lines,
		amounts: { subtotal: 3998, shipping: 500, total: 4498 },
	},
	'order.paid@1': { orderId: 'ord_1', amount: { amount: 4498, currency: 'KWD' }, method: 'bank_transfer' },
	'order.completed@1': { orderId: 'ord_1' },
	'order.cancelled@1': { orderId: 'ord_1', reason: 'customer request' },
	'order.refunded@1': { orderId: 'ord_1', amount: { amount: 100, currency: 'KWD' }, lines: [{ itemId: 'itm_1', quantity: 1 }] },
	'item.created@1': {
		itemId: 'itm_1',
		title: 'Linen shirt',
		status: 'active',
		brand: 'Acme',
		collections: ['col_1', 'summer-sale'],
		attributes: { material: 'linen', sizes: ['S', 'M'], organic: true },
		currency: 'EUR',
		variants: [
			{
				variantId: 'v1',
				sku: 'LS-S',
				title: 'S',
				attributes: { size: 'S' },
				price: 4900,
				compareAtPrice: 5900,
				cost: 2100,
				inventory: 12,
			},
			{ variantId: 'v2', price: 4900, inventory: -1 },
		],
	},
	'item.updated@1': { itemId: 'itm_1', title: 'Linen shirt (new)', changed: ['title'] },
	'item.deleted@1': { itemId: 'itm_1', reason: 'discontinued' },
	'inventory.changed@1': { itemId: 'itm_1', quantity: -2, previousQuantity: 3 },
	'price.changed@1': {
		itemId: 'itm_1',
		price: { amount: 999, currency: 'USD' },
		previousPrice: { amount: 1299, currency: 'USD' },
	},
	'file.uploaded@1': { fileId: 'fil_1', name: 'photo.jpg', contentType: 'image/jpeg', size: 20480 },
});

/** @returns {any} */
export const placement = () => ({
	paths: { include: ['/products/*', '/'], exclude: ['/checkout/**'] },
	selectors: [{ selector: '#main .buy-box', position: 'after' }],
	pageTypes: ['product'],
	devices: ['mobile', 'desktop'],
	referrers: { include: ['*.google.com'] },
	schedule: {
		timezone: 'Asia/Kolkata',
		from: '2026-10-01T00:00:00Z',
		until: '2026-12-31T23:59:59Z',
		windows: [{ days: ['fri', 'sat'], start: '22:00', end: '02:00' }],
	},
	consent: ['marketing'],
	triggers: [
		{ type: 'scroll', percent: 50 },
		{ type: 'event', event: 'cart.updated@1' },
		{ type: 'exit' },
		{ type: 'selector-click', selector: '.open-chat' },
	],
	frequency: { maxPerSession: 1, cooldown: 'P1D', dismissMemory: 'P30D' },
	audience: "inSegment('vip') and total() > 1000",
});

/** @returns {any} */
export const problemDoc = () => ({
	type: 'https://errors.example.dev/validation_failed',
	title: 'Validation failed',
	status: 422,
	detail: 'Two fields are invalid.',
	instance: '/v1/coupons',
	requestId: 'req_123',
	errors: [{ path: '/code', message: 'is required', keyword: 'required' }],
	extension: 'allowed by RFC 9457',
});
