/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal, with the merchant database on the test run's MongoMemoryReplSet (`TEST_MONGODB_URI`, started by the
 * @ss/config vitest global setup), and the merchant's storage and messaging providers replaced by an in-memory
 * `outboundSend`.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal, createTestIdentityIssuer } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createAftersales, wireEvents } from '../api/routes.js';

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
export const ELEMENTS = ['claims', 'photos', 'queue', 'refunds', 'restock', 'serial_registry', 'messages'];
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
	};
};

/** MongoDB URI of a fresh database on the shared replica set. @param {string} name */
export const mongoUri = (name) => {
	const base = process.env.TEST_MONGODB_URI;
	if (!base) throw new Error('TEST_MONGODB_URI is not set (run through this product vitest config)');
	const url = new URL(base);
	url.pathname = `/${name}`;
	return url.toString();
};

/** The merchant's providers: S3-compatible storage (objects put with `upload`) and a messaging API, recorded. */
export const createProviders = () => {
	/** @type {Map<string, { size: number, type: string }>} */
	const objects = new Map();
	/** @type {Array<{ url: string, method: string, body: any }>} */
	const messages = [];
	let failMessaging = false;
	let failStorage = false;
	/**
	 * @param {string} url
	 * @param {{ method?: string, body?: any }} [init]
	 */
	const send = async (url, init = {}) => {
		const method = (init.method ?? 'GET').toUpperCase();
		const parsed = new URL(url);
		if (parsed.hostname === 's3.example.com') {
			if (failStorage) return { status: 500, headers: {}, body: Buffer.alloc(0), url };
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
		}
		if (parsed.hostname === 'messaging.example.com') {
			if (failMessaging)
				return { status: 500, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"x"}'), url };
			messages.push({ url, method, body: init.body ? JSON.parse(Buffer.from(init.body).toString('utf8')) : null });
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
		/** @param {boolean} value */
		failMessaging: (value) => {
			failMessaging = value;
		},
		/** @param {boolean} value */
		failStorage: (value) => {
			failStorage = value;
		},
	};
};

/**
 * @param {{ config?: Record<string, any>, elements?: Record<string, boolean>, env?: Record<string, string>,
 *   website?: Record<string, string> }} [options]
 */
export const createHarness = async ({ config = {}, elements = {}, env = {}, website = { currency: 'USD' } } = {}) => {
	const clock = createClock();
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'aftersales-test-1' });
	portal.trustProductKey(publicJwk);
	const dbName = `aftersales_${nodeRandomBytes(5).toString('hex')}`;
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
	const aftersales = wireEvents(createAftersales(app));
	const handle = createRequestHandler(aftersales.product, buildRoutes(aftersales));
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
			productSlug: 'aftersales',
			domain: DOMAIN,
			version: (version += 1),
			validForMs: 800 * DAY,
			website,
			elements: Object.fromEntries(
				ELEMENTS.map((key) => [
					key,
					flags[key] === false ? { enabled: false, reason: 'merchant_disabled' } : { enabled: true },
				]),
			),
			config: Object.fromEntries(ELEMENTS.map((key) => [key, merged[key] ?? {}])),
			...(identity ? { identity: issuer.section } : {}),
		});
		await aftersales.product.entitlements.refresh(websiteId);
	};
	for (const id of [WEBSITE, WEBSITE_2]) {
		portal.setResource(id, 'database', { uri, dbName }, 365 * DAY);
		portal.setResource(id, 'storage', STORAGE, 365 * DAY);
		portal.setResource(id, 'messaging', MESSAGING, 365 * DAY);
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

	/** A login token of the website's own identity issuer. @param {string} subject */
	const login = (subject) => {
		const now = Math.floor(clock.now() / 1000);
		return issuer.sign({ iss: issuer.section.issuer, aud: 'shop-web', sub: subject, iat: now, exp: now + 900 });
	};

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ body?: unknown, key?: string | null, headers?: Record<string, string>, idempotencyKey?: string | null,
	 *   as?: string, browser?: boolean }} [init] `as`: a pk_ browser request signed in as this customer; `browser`: pk_ without login
	 */
	const call = async (method, path, { body, key: bearer, headers = {}, idempotencyKey, as, browser = false } = {}) => {
		const usePk = as !== undefined || browser || bearer === pk;
		const auth = bearer === null ? null : (bearer ?? (usePk ? pk : sk));
		const response = await handle(
			new Request(`https://aftersales.example.com${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(auth ? { authorization: `Bearer ${auth}` } : {}),
					...(usePk ? ORIGIN : {}),
					...(as ? { 'ss-identity': login(as) } : {}),
					...(method === 'POST' && idempotencyKey !== null ? { 'idempotency-key': idempotencyKey ?? createId('idk') } : {}),
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
	 * @param {{ id?: string, websiteId?: string, occurredAt?: number, context?: Record<string, unknown> }} [options]
	 */
	const deliver = async (type, data, { id = createId('evt'), websiteId = WEBSITE, occurredAt = clock.now(), context } = {}) => {
		const envelope = {
			id,
			type,
			websiteId,
			env: 'live',
			occurredAt: new Date(occurredAt).toISOString(),
			idempotencyKey: id,
			actor: { type: 'system' },
			data,
			context: context ?? { source: 'portal' },
		};
		const signed = await portal.signEvent(envelope);
		const response = await handle(
			new Request('https://aftersales.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: signed.headers,
				body: signed.body,
			}),
		);
		return { status: response.status, id, envelope };
	};

	/**
	 * A delivered order (order.placed@1 then order.completed@1) of a customer.
	 * @param {{ orderId?: string, subject?: string, email?: string, phone?: string, lines?: Array<Record<string, unknown>>,
	 *   complete?: boolean }} [input]
	 */
	const order = async ({
		orderId = createId('ord'),
		subject = 'cus_ada',
		email = 'ada@example.com',
		phone,
		lines = [{ itemId: 'itm_1', variantId: 'var_1', sku: 'CASE-1', title: 'Phone case', quantity: 2, unitAmount: 2500 }],
		complete = true,
	} = {}) => {
		const customer = { customerId: subject, ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
		await deliver('order.placed@1', {
			orderId,
			number: `N-${orderId.slice(-4)}`,
			customer,
			currency: 'USD',
			lines,
			amounts: { subtotal: 5000, total: 5000 },
		});
		if (complete) await deliver('order.completed@1', { orderId });
		const purchase = await collection('purchases').findOne({ websiteId: WEBSITE, orderId });
		return { orderId, purchaseId: /** @type {string} */ (purchase?.id), number: /** @type {string} */ (purchase?.number) };
	};

	/** A dashboard session (`ses_…`) from a launch exchanged at /sso. @param {'merchant' | 'demo'} [kind] */
	const session = async (kind = 'merchant') => {
		const { token } = await portal.issueLaunch({
			kind,
			subject: 'usr_merchant',
			user: { id: 'usr_merchant' },
			scope: kind === 'demo' ? {} : { merchantId: MERCHANT, websiteId: WEBSITE },
		});
		const sso = await handle(new Request(`https://aftersales.example.com/sso?launch=${encodeURIComponent(token)}`));
		const id = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		if (!id) throw new Error(`no session (${sso.status})`);
		return id;
	};

	/** Published events of a type (after flushing the outbox). @param {string} type */
	const published = async (type) => {
		await aftersales.product.flush();
		return portal.published
			.flatMap((/** @type {any} */ body) => body?.events ?? [])
			.filter((/** @type {any} */ event) => event.type === type);
	};

	const db = client.db(dbName);
	/** Raw merchant collection. @param {string} name */
	const collection = (name) => db.collection(`ss_aftersales_${name}`);
	return {
		clock,
		portal,
		app,
		aftersales,
		handle,
		call,
		deliver,
		order,
		session,
		published,
		entitle,
		key,
		login,
		providers,
		sk,
		pk,
		db,
		collection,
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};
