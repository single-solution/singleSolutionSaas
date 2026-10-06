/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal, with the merchant database on the test run's MongoMemoryReplSet (`SS_TEST_MONGO_URI`, started by the root
 * vitest global setup).
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createCoupons, wireEvents } from '../api/routes.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PORTAL_URL = 'https://portal.test';
export const APP_ID = 'app_0123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const WEBSITE_2 = 'web_1123456789abcdefghjkmnpq';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = Object.freeze({ origin: `https://${DOMAIN}` });
export const T0 = Date.parse('2026-10-01T10:00:00Z');
export const MINUTE = 60_000;
export const ELEMENTS = [
	'codes',
	'eligibility',
	'actions',
	'limits',
	'stacking',
	'api',
	'apply_box',
	'distribution',
	'reporting',
];

/** Controllable clock. */
export const createClock = (start = T0) => {
	let t = start;
	return {
		now: () => t,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
		/** @param {number} ms */
		set: (ms) => {
			t = ms;
		},
	};
};

/** MongoDB URI of a fresh database on the shared replica set. */
export const mongoUri = (/** @type {any} */ name) => {
	const base = process.env.SS_TEST_MONGO_URI;
	if (!base) throw new Error('SS_TEST_MONGO_URI is not set (run through this product vitest config)');
	const url = new URL(base);
	url.pathname = `/${name}`;
	return url.toString();
};

/** A cart in EUR. @param {Record<string, any>} [overrides] */
export const cart = (overrides = {}) => ({
	currency: 'EUR',
	lines: [
		{ lineId: 'l1', itemId: 'itm_socks', quantity: 3, unitAmount: 1000, collections: ['socks'] },
		{ lineId: 'l2', itemId: 'itm_shoes', quantity: 1, unitAmount: 7000 },
	],
	shipping: 500,
	...overrides,
});

/**
 * @param {{ config?: Record<string, Record<string, unknown>>, elements?: Record<string, boolean>, env?: Record<string, string> }} [options]
 */
export const createHarness = async (
	/** @type {{ config?: Record<string, any>, elements?: Record<string, boolean>, env?: Record<string, string> }} */ {
		config = {},
		elements = {},
		env = {},
	} = {},
) => {
	const clock = createClock();
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'coupons-test-1' });
	portal.trustProductKey(publicJwk);
	const dbName = `coupons_${nodeRandomBytes(5).toString('hex')}`;
	const uri = mongoUri(dbName);
	const client = await new MongoClient(uri).connect();
	const app = await createPlatform({
		env: {
			SS_PORTAL_URL: PORTAL_URL,
			SS_APP_ID: APP_ID,
			SS_APP_SIGNING_KEY: JSON.stringify(privateJwk),
			SS_REGISTRATION_TOKEN_HASH: hashRegistrationToken('rt_coupons_api_tests_0123456789'),
			...env,
		},
		root: ROOT,
		overrides: { fetch: portal.fetch, now: clock.now, logger: noopLogger },
	});
	const coupons = wireEvents(createCoupons(app));
	const handle = createRequestHandler(coupons.product, buildRoutes(coupons));

	let version = 0;
	/**
	 * Publish the entitlement of a website (all elements on by default); every call is a newer document version.
	 * @param {{ websiteId?: string, config?: Record<string, any>, elements?: Record<string, boolean>,
	 *   identity?: import('@ss/contracts').IdentitySection }} [input] `identity`: the website's own identity issuer
	 */
	const entitle = async ({ websiteId = WEBSITE, config: overrides = {}, elements: switches = {}, identity } = {}) => {
		const merged = { ...config, ...overrides };
		const flags = { ...elements, ...switches };
		await portal.setEntitlement({
			websiteId,
			merchantId: MERCHANT,
			productSlug: 'coupons',
			domain: DOMAIN,
			version: (version += 1),
			validForMs: 3_600_000,
			elements: Object.fromEntries(
				ELEMENTS.map((key) => [
					key,
					flags[key] === false ? { enabled: false, reason: 'merchant_disabled' } : { enabled: true },
				]),
			),
			config: Object.fromEntries(ELEMENTS.map((key) => [key, merged[key] ?? {}])),
			...(identity ? { identity } : {}),
		});
		await coupons.product.entitlements.refresh(websiteId);
	};
	portal.setResource(WEBSITE, 'database', { uri, dbName }, 24 * 3_600_000);
	portal.setResource(WEBSITE_2, 'database', { uri, dbName }, 24 * 3_600_000);
	await entitle();

	/** @param {'pk' | 'sk'} [kind] @param {string} [websiteId] */
	const key = async (kind = 'sk', websiteId = WEBSITE) =>
		(
			await portal.issueWebsiteKey({
				kind,
				websiteId,
				merchantId: MERCHANT,
				domain: DOMAIN,
				env: 'live',
				scopes: [],
				keyId: createId('key'),
			})
		).key;
	const sk = await key('sk');
	const pk = await key('pk');

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ body?: unknown, key?: string | null, headers?: Record<string, string>, idempotencyKey?: string | null }} [init]
	 */
	const call = async (method, path, { body, key: bearer = sk, headers = {}, idempotencyKey } = {}) => {
		const response = await handle(
			new Request(`https://coupons.example.com${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
					...(method === 'POST' && idempotencyKey !== null ? { 'idempotency-key': idempotencyKey ?? createId('idk') } : {}),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const type = response.headers.get('content-type') ?? '';
		const text = await response.text();
		return {
			status: response.status,
			headers: response.headers,
			text,
			json: text && type.includes('json') ? JSON.parse(text) : null,
		};
	};

	/**
	 * Deliver an event to the product as the Event Hub would (signed POST /.well-known/ss-events).
	 * @param {string} type
	 * @param {Record<string, unknown>} data
	 * @param {{ id?: string, websiteId?: string, occurredAt?: number }} [options]
	 */
	const deliver = async (type, data, { id = createId('evt'), websiteId = WEBSITE, occurredAt = clock.now() } = {}) => {
		const envelope = {
			id,
			type,
			websiteId,
			env: 'live',
			occurredAt: new Date(occurredAt).toISOString(),
			idempotencyKey: id,
			actor: { type: 'system' },
			data,
			context: { source: 'portal' },
		};
		const signed = await portal.signEvent(envelope);
		const response = await handle(
			new Request('https://coupons.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: signed.headers,
				body: signed.body,
			}),
		);
		return { status: response.status, id, envelope };
	};

	/**
	 * Create a coupon through the API (201 expected).
	 * @param {Record<string, any>} body
	 */
	const coupon = async (body) => {
		const result = await call('POST', '/v1/coupons', { body: { name: 'Test coupon', ...body } });
		if (result.status !== 201) throw new Error(`coupon create failed: ${result.status} ${result.text}`);
		return result.json;
	};

	/** Published events of a type. @param {string} type */
	const published = (type) =>
		portal.published
			.flatMap((/** @type {any} */ body) => body?.events ?? [])
			.filter((/** @type {any} */ event) => event.type === type);

	const db = client.db(dbName);
	return {
		clock,
		portal,
		app,
		coupons,
		handle,
		call,
		deliver,
		coupon,
		published,
		entitle,
		key,
		sk,
		pk,
		db,
		/** Raw merchant collection. @param {string} name */
		collection: (name) => db.collection(`ss_coupons_${name}`),
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};
