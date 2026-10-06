import { generateSigningKey } from '@ss/protocol';
import { createFakePortal } from '../src/testing.js';
import { createProduct } from '../src/index.js';

export const T0 = Date.parse('2026-10-01T10:00:00Z');
export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const WEBSITE_2 = 'web_1123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const PORTAL_URL = 'https://portal.test';
export const APP_ID = 'app_test';

/** Controllable clock. */
export const createClock = (start = T0) => {
	let t = start;
	return {
		now: () => t,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
	};
};

/** Deterministic randomBytes. */
export const seededRandom = (seed = 7) => {
	let counter = seed;
	/** @param {number} length */
	return (length) => {
		const out = new Uint8Array(length);
		for (let i = 0; i < length; i += 1) out[i] = (counter * 131 + i * 17 + (counter >> 3)) & 0xff;
		counter += 1;
		return out;
	};
};

/** Logger that records entries. */
export const createTestLogger = () => {
	/** @type {Array<{ level: string, msg: string, fields?: Record<string, unknown> }>} */
	const entries = [];
	/** @param {string} level */
	const at = (level) => (/** @type {string} */ msg, /** @type {Record<string, unknown>} */ fields) => {
		entries.push({ level, msg, ...(fields ? { fields } : {}) });
	};
	/** @type {any} */
	const logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
	logger.child = () => logger;
	return { logger, entries };
};

/** @returns {any} */
export const manifest = () => ({
	ssps: '1',
	product: { slug: 'coupon-box', name: 'Coupons', kind: 'service', version: '1.4.0', category: 'commerce' },
	endpoints: {
		base: 'https://coupons.example.dev',
		dashboard: '/dashboard',
		events: '/.well-known/ss-events',
	},
	capabilities: { adminLaunch: true, offlineGrace: 'PT24H' },
	scopes: ['events.subscribe:order.*'],
	events: { consumes: ['order.placed@1'], publishes: ['coupon_box.redeemed@1'] },
	elements: [
		{
			key: 'codes',
			name: 'Coupon codes',
			modes: ['C'],
			stateful: true,
			price: { hourly: 1000, metered: [{ unit: 'redemption', perUnit: 10 }] },
			features: {
				type: 'object',
				additionalProperties: false,
				properties: {
					maxActive: { type: 'integer', title: 'Max active', default: 20, minimum: 1, maximum: 1000, 'x-kind': 'limit' },
				},
			},
			api: { resources: ['coupons'] },
		},
		{
			key: 'bulk',
			name: 'Bulk import',
			modes: ['C'],
			stateful: true,
			price: { hourly: 0 },
			dependsOn: ['codes'],
			api: { resources: ['imports'] },
		},
	],
	priceBook: { version: '2026-10-01', effectiveFrom: '2026-10-01T00:00:00Z' },
});

/**
 * Wire a product against a fake Portal.
 * @param {{ clock?: ReturnType<typeof createClock>, overrides?: Record<string, any>, portalOptions?: Record<string, any> }} [options]
 */
export const setup = async ({ clock = createClock(), overrides = {}, portalOptions = {} } = {}) => {
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID, ...portalOptions });
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'product-1' });
	portal.trustProductKey(publicJwk);
	const { logger, entries } = createTestLogger();
	const product = createProduct({
		manifest: manifest(),
		portalUrl: PORTAL_URL,
		appId: APP_ID,
		signingKey: privateJwk,
		fetch: portal.fetch,
		now: clock.now,
		randomBytes: seededRandom(),
		logger,
		outbound: { allowHosts: ['127.0.0.1'] }, // the in-memory MongoDB replica set listens on loopback
		...overrides,
	});
	return { portal, product, clock, privateJwk, publicJwk, logs: entries };
};

/**
 * Publish a standard entitlement for WEBSITE.
 * @param {Awaited<ReturnType<typeof createFakePortal>>} portal
 * @param {Record<string, any>} [overrides]
 */
export const entitle = (portal, overrides = {}) =>
	portal.setEntitlement({
		websiteId: WEBSITE,
		merchantId: MERCHANT,
		productSlug: 'coupon-box',
		elements: { codes: { enabled: true }, bulk: { enabled: false, reason: 'merchant_disabled' } },
		features: { 'codes.maxActive': { value: 50, source: 'plan_default', locked: false } },
		config: { codes: { prefix: 'SAVE' } },
		...overrides,
	});

/**
 * Issue a website key for WEBSITE.
 * @param {Awaited<ReturnType<typeof createFakePortal>>} portal
 * @param {Record<string, any>} [overrides]
 */
export const websiteKey = async (portal, overrides = {}) =>
	(
		await portal.issueWebsiteKey({
			kind: 'pk',
			websiteId: WEBSITE,
			merchantId: MERCHANT,
			domain: 'shop.example.com',
			env: 'live',
			scopes: ['coupons.read'],
			keyId: 'key_1',
			...overrides,
		})
	).key;
