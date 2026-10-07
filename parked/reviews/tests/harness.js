/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal, with the merchant database on the test run's MongoMemoryReplSet (`TEST_MONGODB_URI`, started by the root
 * vitest global setup), and the merchant's storage and messaging providers replaced by an in-memory `outboundSend`.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal, createTestIdentityIssuer } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createReviews, wireEvents } from '../api/routes.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PORTAL_URL = 'https://portal.test';
export const APP_ID = 'app_0123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const WEBSITE_2 = 'web_1123456789abcdefghjkmnpq';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = { origin: `https://${DOMAIN}` };
export const T0 = Date.parse('2026-10-01T10:00:00Z');
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const ELEMENTS = [
	'collection',
	'request_flow',
	'moderation',
	'content',
	'photos',
	'display',
	'structured_data',
	'qna',
	'import',
	'analytics',
];
export const STORAGE = {
	bucket: 'shop-media',
	region: 'eu-west-1',
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
	endpoint: 'https://s3.example.com',
	forcePathStyle: true,
};
export const MESSAGING = { baseUrl: 'https://messaging.example.com/v1', apiKey: 'msg_test_key' };

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
	const base = process.env.TEST_MONGODB_URI;
	if (!base) throw new Error('TEST_MONGODB_URI is not set (run through this product vitest config)');
	const url = new URL(base);
	url.pathname = `/${name}`;
	return url.toString();
};

/**
 * The merchant's providers: S3-compatible storage (objects put with `upload`) and a messaging API, recorded.
 */
export const createProviders = () => {
	/** @type {Map<string, { size: number, type: string }>} */
	const objects = new Map();
	/** @type {Array<{ url: string, method: string, body: any }>} */
	const messages = [];
	/** @type {{ status: number } | null} */
	let messagingFailure = null;
	/**
	 * @param {string} url
	 * @param {{ method?: string, body?: any }} [init]
	 */
	const send = async (url, init = {}) => {
		const method = (init.method ?? 'GET').toUpperCase();
		const parsed = new URL(url);
		if (parsed.hostname === 's3.example.com') {
			const key = decodeURIComponent(parsed.pathname.replace(/^\/shop-media\//, ''));
			const object = objects.get(key);
			if (method === 'HEAD')
				return object
					? {
							status: 200,
							headers: { 'content-length': String(object.size), 'content-type': object.type },
							body: Buffer.alloc(0),
							url,
						}
					: { status: 404, headers: {}, body: Buffer.alloc(0), url };
			if (method === 'DELETE') {
				objects.delete(key);
				return { status: 204, headers: {}, body: Buffer.alloc(0), url };
			}
		}
		if (parsed.hostname === 'messaging.example.com') {
			const body = init.body ? JSON.parse(Buffer.from(init.body).toString('utf8')) : null;
			if (messagingFailure) {
				const { status } = messagingFailure;
				return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"x"}'), url };
			}
			messages.push({ url, method, body });
			return { status: 202, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"id":"msg_1"}'), url };
		}
		return { status: 404, headers: {}, body: Buffer.alloc(0), url };
	};
	return {
		send,
		objects,
		messages,
		/** Put an object as a browser would through the presigned URL. @param {string} key @param {number} size @param {string} type */
		upload: (key, size, type) => objects.set(key, { size, type }),
		/** @param {{ status: number } | null} failure */
		failMessaging: (failure) => {
			messagingFailure = failure;
		},
	};
};

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
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'reviews-test-1' });
	portal.trustProductKey(publicJwk);
	const dbName = `reviews_${nodeRandomBytes(5).toString('hex')}`;
	const uri = mongoUri(dbName);
	const client = await new MongoClient(uri).connect();
	const providers = createProviders();
	const app = await createPlatform({
		env: {
			...env,
		},
		root: ROOT,
		overrides: {
			portalUrl: PORTAL_URL,
			appId: APP_ID,
			signingKey: `${privateJwk.kid}:${privateJwk.d}`,
			fetch: portal.fetch,
			now: clock.now,
			logger: noopLogger,
			outboundSend: providers.send,
		},
	});
	const reviews = wireEvents(createReviews(app));
	const handle = createRequestHandler(reviews.product, [...buildRoutes(reviews)]);
	const issuer = createTestIdentityIssuer({ alg: 'ES256', audience: 'shop-web' });

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
			productSlug: 'reviews',
			domain: DOMAIN,
			version: (version += 1),
			validForMs: 800 * DAY,
			elements: Object.fromEntries(
				ELEMENTS.map((key) => [
					key,
					flags[key] === false ? { enabled: false, reason: 'merchant_disabled' } : { enabled: true },
				]),
			),
			config: Object.fromEntries(ELEMENTS.map((key) => [key, merged[key] ?? {}])),
			...(identity ? { identity: issuer.section } : {}),
		});
		await reviews.product.entitlements.refresh(websiteId);
	};
	for (const website of [WEBSITE, WEBSITE_2]) {
		portal.setResource(website, 'database', { uri, dbName }, 365 * DAY);
		portal.setResource(website, 'storage', STORAGE, 365 * DAY);
		portal.setResource(website, 'messaging', MESSAGING, 365 * DAY);
	}
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

	/** A login token of the website's own identity issuer. @param {string} subject @param {Record<string, unknown>} [claims] */
	const login = (subject, claims = {}) => {
		const now = Math.floor(clock.now() / 1000);
		return issuer.sign({ iss: issuer.section.issuer, aud: 'shop-web', sub: subject, iat: now, exp: now + 900, ...claims });
	};

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ body?: unknown, key?: string | null, headers?: Record<string, string>, idempotencyKey?: string | null, as?: string }} [init]
	 *   `as`: a pk_ browser request signed in as this customer
	 */
	const call = async (method, path, { body, key: bearer, headers = {}, idempotencyKey, as } = {}) => {
		const browser = as !== undefined || bearer === pk;
		const response = await handle(
			new Request(`https://reviews.example.com${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...((bearer ?? (as !== undefined ? pk : sk))
						? { authorization: `Bearer ${bearer ?? (as !== undefined ? pk : sk)}` }
						: {}),
					...(browser ? ORIGIN : {}),
					...(as ? { 'ss-identity': login(as) } : {}),
					...((method === 'POST' || method === 'PUT') && idempotencyKey !== null
						? { 'idempotency-key': idempotencyKey ?? createId('idk') }
						: {}),
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
			json = text;
		}
		return { status: response.status, headers: response.headers, json };
	};

	/**
	 * Deliver an event to the product as the Event Hub would (signed POST /.well-known/ss-events).
	 * @param {string} type
	 * @param {Record<string, unknown>} data
	 * @param {{ id?: string, websiteId?: string, occurredAt?: number, actor?: { type: string, id?: string } }} [options]
	 */
	const deliver = async (
		type,
		data,
		{ id = createId('evt'), websiteId = WEBSITE, occurredAt = clock.now(), actor = { type: 'system' } } = {},
	) => {
		const envelope = {
			id,
			type,
			websiteId,
			env: 'live',
			occurredAt: new Date(occurredAt).toISOString(),
			idempotencyKey: id,
			actor,
			data,
			context: { source: 'portal' },
		};
		const signed = await portal.signEvent(envelope);
		const response = await handle(
			new Request('https://reviews.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: signed.headers,
				body: signed.body,
			}),
		);
		return { status: response.status, id, envelope };
	};

	/**
	 * A completed order of a customer (with lines and contact on the completion event).
	 * @param {{ orderId?: string, customerId?: string, subject?: string | null, items?: string[], email?: string | null,
	 *   phone?: string | null, placedFirst?: boolean }} [input]
	 */
	const completeOrder = async ({
		orderId = createId('ord'),
		customerId = 'cus_1',
		subject = null,
		items = ['itm_1'],
		email = 'buyer@example.com',
		phone = null,
		placedFirst = false,
	} = {}) => {
		const lines = items.map((itemId, index) => ({
			itemId,
			sku: `SKU-${index}`,
			title: `Item ${itemId}`,
			quantity: 1,
			unitAmount: 1000,
		}));
		const customer = {
			customerId,
			...(subject ? { subject } : {}),
			...(email ? { email } : {}),
			...(phone ? { phone } : {}),
		};
		if (placedFirst) {
			await deliver('order.placed@1', {
				orderId,
				number: orderId.slice(-6),
				customer,
				currency: 'USD',
				lines,
				amounts: { subtotal: 1000 * items.length, total: 1000 * items.length },
			});
			return { orderId, result: await deliver('order.completed@1', { orderId }) };
		}
		return {
			orderId,
			result: await deliver('order.completed@1', { orderId, number: orderId.slice(-6), customer, currency: 'USD', lines }),
		};
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
		reviews,
		handle,
		call,
		deliver,
		completeOrder,
		published,
		entitle,
		key,
		login,
		issuer,
		providers,
		sk,
		pk,
		db,
		/** Raw merchant collection. @param {string} name */
		collection: (name) => db.collection(`ss_reviews_${name}`),
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};
