/**
 * Fresh, valid fixtures for every schema. Each call returns a new deep copy so tests may mutate freely.
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
		demo: '/demo',
		events: '/.well-known/ss-events',
		register: '/.well-known/ss-register',
	},
	capabilities: { adminLaunch: true, sandbox: true, localEnforcement: ['quota:redeem'], offlineGrace: 'PT24H' },
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
			budget: { js: 0 },
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
						'x-experiment': true,
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
			experiments: true,
			api: { resources: ['coupons', 'redemptions'] },
			headless: null,
			renderer: null,
		},
		{
			key: 'apply_box',
			name: 'Coupon apply box',
			modes: ['A', 'B', 'C'],
			price: { hourly: 0 },
			budget: { js: 6 },
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
			budget: { js: 3 },
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
	experiments: [{ element: 'codes', variant: 'b' }],
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

/** @param {string} id */
const base = (id) => ({
	id,
	websiteId: WEBSITE,
	merchantId: MERCHANT,
	env: 'live',
	createdAt: '2026-10-01T00:00:00Z',
	updatedAt: '2026-10-01T00:00:00Z',
	schemaVersion: 1,
});

/** Valid graph entities by name. */
export const graph = () => ({
	customer: {
		...base('cus_1'),
		identities: [
			{ type: 'email', value: 'ana@example.com', verified: true, primary: true },
			{ type: 'phone', value: '+923001234567' },
			{ type: 'externalId', value: 'u-778', issuer: 'https://login.example.com' },
		],
		name: 'Ana',
		locale: 'ur-PK',
		consent: { marketing: { granted: true, updatedAt: '2026-10-01T00:00:00Z' } },
		attributes: { tier: 'gold', visits: 3, sizes: ['m', 'l'] },
		tags: ['vip'],
		custom: { favouriteColour: 'green' },
	},
	item: {
		...base('itm_1'),
		type: 'device',
		title: 'Phone X',
		slug: 'phone-x',
		status: 'active',
		attributes: { storage: '128GB' },
		variants: [{ id: 'v1', sku: 'PX-128', prices: [{ amount: 49900, currency: 'USD' }], quantity: 4 }],
		media: [{ fileId: 'fil_1', role: 'primary', alt: 'Front' }],
		prices: [{ amount: 49900, currency: 'USD', compareAtAmount: 59900 }],
	},
	order: {
		...base('ord_1'),
		number: 'A-1001',
		customerId: 'cus_1',
		status: 'paid',
		currency: 'EUR',
		lines: [{ itemId: 'itm_1', quantity: 1, unitAmount: 49900, totalAmount: 49900 }],
		amounts: { subtotal: 49900, total: 49900 },
		placedAt: '2026-10-01T00:00:00Z',
	},
	session: {
		...base('ses_1'),
		startedAt: '2026-10-01T00:00:00Z',
		device: 'mobile',
		landingPath: '/',
		campaign: { source: 'newsletter', medium: 'email' },
		pageViews: 3,
	},
	file: {
		...base('fil_1'),
		name: 'front.jpg',
		contentType: 'image/jpeg',
		size: 1024,
		storageRef: 'bucket-key/2026/front.jpg',
		folder: '/items/',
		checksum: { algorithm: 'sha256', value: 'abc123' },
		width: 800,
		height: 600,
	},
	'consent-record': {
		...base('cns_1'),
		subjectType: 'anonymous',
		subjectId: 'anon_1',
		categories: { analytics: true, marketing: false },
		policyVersion: '2026-09',
		source: 'banner',
		recordedAt: '2026-10-01T00:00:00Z',
	},
	'custom-field-definition': {
		...base('cfd_1'),
		entity: 'customer',
		key: 'shoeSize',
		label: 'Shoe size',
		type: 'enum',
		options: [{ value: '42' }, { value: '43' }],
		filterable: true,
	},
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
