/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal, with the merchant database on the test run's MongoMemoryReplSet (`SS_TEST_MONGO_URI`, started by the
 * vitest global setup), and the merchant's storage provider replaced by an in-memory `outboundSend`.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createCatalog, wireEvents } from '../api/routes.js';

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
export const ELEMENTS = ['items', 'variants', 'attributes', 'collections', 'brands', 'media', 'import_export', 'feeds', 'api'];
export const STORAGE = {
	bucket: 'shop-media',
	region: 'eu-west-1',
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
	endpoint: 'https://s3.example.com',
	forcePathStyle: true,
};

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

/** MongoDB URI of a fresh database on the shared replica set. @param {string} name */
export const mongoUri = (name) => {
	const base = process.env.SS_TEST_MONGO_URI;
	if (!base) throw new Error('SS_TEST_MONGO_URI is not set (run through this product vitest config)');
	const url = new URL(base);
	url.pathname = `/${name}`;
	return url.toString();
};

/** The merchant's S3-compatible storage (objects put with `upload`). */
export const createProviders = () => {
	/** @type {Map<string, { size: number, type: string }>} */
	const objects = new Map();
	/**
	 * @param {string} url
	 * @param {{ method?: string }} [init]
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
		}
		return { status: 404, headers: {}, body: Buffer.alloc(0), url };
	};
	return {
		send,
		objects,
		/** @param {string} key full object key @param {number} size @param {string} type */
		upload: (key, size, type) => objects.set(key, { size, type }),
	};
};

/**
 * @param {{ config?: Record<string, any>, elements?: Record<string, boolean>, website?: Record<string, string> }} [options]
 */
export const createHarness = async ({ config = {}, elements = {}, website = { currency: 'EUR' } } = {}) => {
	const clock = createClock();
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'catalog-test-1' });
	portal.trustProductKey(publicJwk);
	const dbName = `catalog_${nodeRandomBytes(5).toString('hex')}`;
	const uri = mongoUri(dbName);
	const client = await new MongoClient(uri).connect();
	const providers = createProviders();
	const app = await createPlatform({
		env: {
			SS_PORTAL_URL: PORTAL_URL,
			SS_APP_ID: APP_ID,
			SS_APP_SIGNING_KEY: JSON.stringify(privateJwk),
			SS_REGISTRATION_TOKEN_HASH: hashRegistrationToken('rt_catalog_api_tests_0123456789'),
		},
		root: ROOT,
		overrides: { fetch: portal.fetch, now: clock.now, logger: noopLogger, outboundSend: providers.send },
	});
	const catalog = wireEvents(createCatalog(app));
	const handle = createRequestHandler(catalog.product, buildRoutes(catalog), {
		maxBodyBytes: 16_000_000,
	});

	let version = 0;
	/**
	 * Publish the entitlement of a website (all elements on by default); every call is a newer document version.
	 * @param {{ websiteId?: string, config?: Record<string, any>, elements?: Record<string, boolean>, website?: Record<string, string> | null, storage?: boolean }} [input] `storage`: the optional storage connector is connected (default true)
	 */
	const entitle = async ({
		websiteId = WEBSITE,
		config: overrides = {},
		elements: switches = {},
		website: section = website,
		storage = true,
	} = {}) => {
		const merged = { ...config, ...overrides };
		const flags = { ...elements, ...switches };
		await portal.setEntitlement({
			websiteId,
			merchantId: MERCHANT,
			productSlug: 'catalog',
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
			...(section ? { website: section } : {}),
			resources: [{ kind: 'storage', ref: 'con_storage', status: storage ? 'connected' : 'missing' }],
		});
		await catalog.product.entitlements.refresh(websiteId);
	};
	for (const id of [WEBSITE, WEBSITE_2]) {
		portal.setResource(id, 'database', { uri, dbName }, 365 * DAY);
		portal.setResource(id, 'storage', STORAGE, 365 * DAY);
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

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ body?: unknown, key?: string | null, headers?: Record<string, string>, idempotencyKey?: string | null, raw?: boolean }} [init]
	 */
	const call = async (method, path, { body, key: bearer, headers = {}, idempotencyKey } = {}) => {
		const auth = bearer === undefined ? sk : bearer;
		const response = await handle(
			new Request(`https://catalog.example.com${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(auth ? { authorization: `Bearer ${auth}` } : {}),
					...(auth === pk ? ORIGIN : {}),
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
			json = null;
		}
		return { status: response.status, headers: response.headers, json, text };
	};

	/**
	 * Deliver an event to the product as the Event Hub would (signed POST /.well-known/ss-events).
	 * @param {string} type
	 * @param {Record<string, unknown>} data
	 * @param {{ id?: string, websiteId?: string }} [options]
	 */
	const deliver = async (type, data, { id = createId('evt'), websiteId = WEBSITE } = {}) => {
		const envelope = {
			id,
			type,
			websiteId,
			env: 'live',
			occurredAt: new Date(clock.now()).toISOString(),
			idempotencyKey: id,
			actor: { type: 'system' },
			data,
			context: { source: 'portal' },
		};
		const signed = await portal.signEvent(envelope);
		const response = await handle(
			new Request('https://catalog.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: signed.headers,
				body: signed.body,
			}),
		);
		return { status: response.status, id };
	};

	/** Published events (optionally of one type). @param {string} [type] */
	const published = (type) =>
		portal.published
			.flatMap((/** @type {any} */ b) => b?.events ?? [])
			.filter((/** @type {any} */ e) => type === undefined || e.type === type);

	/**
	 * A dashboard session (`ses_…`, usable as a bearer) of a launch kind.
	 * @param {'merchant' | 'demo' | 'admin'} [kind]
	 * @param {Record<string, unknown>} [extra]
	 */
	const session = async (kind = 'merchant', extra = {}) => {
		const { token } = await portal.issueLaunch(
			/** @type {any} */ ({
				kind,
				subject: 'usr_merchant',
				user: { id: 'usr_merchant' },
				scope: kind === 'demo' ? {} : { merchantId: MERCHANT, websiteId: WEBSITE },
				...extra,
			}),
		);
		const sso = await handle(new Request(`https://catalog.example.com/sso?launch=${encodeURIComponent(token)}`));
		const id = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		if (!id) throw new Error(`no session (${sso.status})`);
		return id;
	};

	const db = client.db(dbName);
	return {
		clock,
		portal,
		app,
		catalog,
		handle,
		call,
		deliver,
		published,
		entitle,
		key,
		session,
		providers,
		sk,
		pk,
		db,
		/** Raw merchant collection. @param {string} name @returns {any} */
		collection: (name) => db.collection(`ss_catalog_${name}`),
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};
