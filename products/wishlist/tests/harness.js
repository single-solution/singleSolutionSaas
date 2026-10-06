/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal, with the merchant database on the test run's MongoMemoryReplSet (`TEST_MONGODB_URI`, started by the
 * @ss/config Mongo global setup).
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal, createTestIdentityIssuer } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createWishlist, wireEvents } from '../api/routes.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PORTAL_URL = 'https://portal.test';
export const APP_ID = 'app_0123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const WEBSITE_2 = 'web_1123456789abcdefghjkmnpq';
export const DOMAIN = 'shop.example.com';
export const T0 = Date.parse('2026-10-01T10:00:00Z');
export const ELEMENTS = ['lists', 'guest_merge', 'share', 'price_drop_hook', 'widgets'];
export const ISSUER = 'https://login.shop.example.com';

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

/** MongoDB URI of a fresh database on the shared replica set. */
export const mongoUri = (/** @type {string} */ name) => {
	const base = process.env.TEST_MONGODB_URI;
	if (!base) throw new Error('TEST_MONGODB_URI is not set (run through this product vitest config)');
	const url = new URL(base);
	url.pathname = `/${name}`;
	return url.toString();
};

/** A sample item from a product page. @param {Record<string, unknown>} [patch] */
export const item = (patch = {}) => ({
	itemId: 'itm_1',
	title: 'Linen shirt',
	image: 'https://cdn.example.net/linen.jpg',
	url: `https://${DOMAIN}/p/linen-shirt`,
	price: { amount: 5000, currency: 'EUR' },
	...patch,
});

/**
 * @param {{ config?: Record<string, Record<string, unknown>>, elements?: Record<string, boolean>, env?: Record<string, string>,
 *   website?: Record<string, string> }} [options]
 */
export const createHarness = async ({ config = {}, elements = {}, env = {}, website } = {}) => {
	const clock = createClock();
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'wishlist-test-1' });
	portal.trustProductKey(publicJwk);
	const dbName = `wishlist_${nodeRandomBytes(5).toString('hex')}`;
	const uri = mongoUri(dbName);
	const client = await new MongoClient(uri).connect();
	const app = await createPlatform({
		env: {
			...env,
		},
		root: ROOT,
		overrides: { portalUrl: PORTAL_URL, appId: APP_ID, signingKey: `${privateJwk.kid}:${privateJwk.d}`, fetch: portal.fetch, now: clock.now, logger: noopLogger },
	});
	const wishlist = wireEvents(createWishlist(app));
	const handle = createRequestHandler(wishlist.product, buildRoutes(wishlist));
	const issuer = await createTestIdentityIssuer({ issuer: ISSUER, claimMap: { subject: 'sub', email: 'email' } });

	let version = 0;
	/**
	 * Publish the entitlement of a website (all elements on by default); every call is a newer document version.
	 * @param {{ websiteId?: string, config?: Record<string, any>, elements?: Record<string, boolean>, identity?: boolean }} [input]
	 */
	const entitle = async ({ websiteId = WEBSITE, config: overrides = {}, elements: switches = {}, identity = true } = {}) => {
		const merged = { ...config, ...overrides };
		const flags = { ...elements, ...switches };
		await portal.setEntitlement({
			websiteId,
			merchantId: MERCHANT,
			productSlug: 'wishlist',
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
			...(identity ? { identity: issuer.section } : {}),
			...(website ? { website } : {}),
		});
		await wishlist.product.entitlements.refresh(websiteId);
	};
	for (const websiteId of [WEBSITE, WEBSITE_2]) portal.setResource(websiteId, 'database', { uri, dbName }, 24 * 3_600_000);
	await entitle();
	await entitle({ websiteId: WEBSITE_2 });

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
	 * @param {{ body?: unknown, key?: string | null, headers?: Record<string, string>, idempotencyKey?: string | null, identity?: string }} [init]
	 */
	const call = async (method, path, { body, key: bearer = pk, headers = {}, idempotencyKey, identity } = {}) => {
		const response = await handle(
			new Request(`https://wishlist.example.com${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
					...(bearer && bearer.startsWith('pk_') ? { origin: `https://${DOMAIN}` } : {}),
					...(method === 'POST' && idempotencyKey !== null ? { 'idempotency-key': idempotencyKey ?? createId('idk') } : {}),
					...(identity ? { 'ss-identity': identity } : {}),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		return { status: response.status, headers: response.headers, json, text };
	};

	/**
	 * A customer login token of the website's own issuer.
	 * @param {string} subject
	 * @param {Record<string, unknown>} [claims]
	 */
	const login = (subject, claims = {}) =>
		issuer.sign({
			iss: ISSUER,
			sub: subject,
			iat: Math.floor(clock.now() / 1000),
			exp: Math.floor(clock.now() / 1000) + 3600,
			...claims,
		});

	/** A fresh guest token from the API. */
	const guest = async () => {
		const result = await call('POST', '/v1/guests', { body: {} });
		return /** @type {string} */ (result.json.token);
	};

	/**
	 * Deliver an event to the product as the Event Hub would (signed POST /.well-known/ss-events).
	 * @param {string} type
	 * @param {Record<string, unknown>} data
	 * @param {{ id?: string, websiteId?: string, actor?: { type: string, id?: string }, context?: Record<string, unknown> }} [options]
	 */
	const deliver = async (
		type,
		data,
		{ id = createId('evt'), websiteId = WEBSITE, actor = { type: 'merchant' }, context = {} } = {},
	) => {
		const envelope = {
			id,
			type,
			websiteId,
			env: 'live',
			occurredAt: new Date(clock.now()).toISOString(),
			idempotencyKey: id,
			actor,
			data,
			context: { source: 'portal', ...context },
		};
		const signed = await portal.signEvent(envelope);
		const response = await handle(
			new Request('https://wishlist.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: signed.headers,
				body: signed.body,
			}),
		);
		return { status: response.status, id, envelope };
	};

	/** Published events of a type. @param {string} type */
	const published = (type) =>
		portal.published
			.flatMap((/** @type {any} */ body) => body?.events ?? [])
			.filter((/** @type {any} */ event) => event.type === type);

	/** Site of the main website. */
	const site = async (websiteId = WEBSITE) => /** @type {import('../api/lists.js').Site} */ (await wishlist.siteFor(websiteId));

	const db = client.db(dbName);
	return {
		clock,
		portal,
		app,
		wishlist,
		handle,
		call,
		deliver,
		published,
		entitle,
		site,
		login,
		guest,
		key,
		sk,
		pk,
		db,
		/** Raw merchant collection. @param {string} name */
		collection: (name) => db.collection(`ss_wishlist_${name}`),
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};
