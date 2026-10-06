/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal, with the merchant database on the test run's MongoMemoryReplSet (`TEST_MONGODB_URI`, started by the
 * @ss/config vitest global setup), and the merchant's S3-compatible storage replaced by an in-memory `outboundSend`.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createGrades, wireEvents } from '../api/routes.js';

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
export const ELEMENTS = ['tiers', 'showcase', 'filters', 'warranty', 'mapping', 'inspection'];
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

/** The merchant's S3-compatible bucket: objects put with `upload`, HEAD and DELETE answered from memory. */
export const createStorage = () => {
	/** @type {Map<string, { size: number, type: string }>} */
	const objects = new Map();
	let failing = false;
	/**
	 * @param {string} url
	 * @param {{ method?: string }} [init]
	 */
	const send = async (url, init = {}) => {
		const method = (init.method ?? 'GET').toUpperCase();
		const parsed = new URL(url);
		if (parsed.hostname === 's3.example.com') {
			if (failing) return { status: 500, headers: {}, body: Buffer.alloc(0), url };
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
		return { status: 404, headers: {}, body: Buffer.alloc(0), url };
	};
	return {
		send,
		objects,
		/** Put an object as a browser would through the presigned URL. @param {string} key @param {number} size @param {string} type */
		upload: (key, size, type) => objects.set(key, { size, type }),
		/** @param {boolean} value */
		fail: (value) => {
			failing = value;
		},
	};
};

/**
 * @param {{ config?: Record<string, Record<string, unknown>>, elements?: Record<string, boolean>, storage?: boolean }} [options]
 */
export const createHarness = async ({ config = {}, elements = {}, storage = true } = {}) => {
	const clock = createClock();
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'grades-test-1' });
	portal.trustProductKey(publicJwk);
	const dbName = `grades_${nodeRandomBytes(5).toString('hex')}`;
	const uri = mongoUri(dbName);
	const client = await new MongoClient(uri).connect();
	const bucket = createStorage();
	const app = await createPlatform({
		env: {
			PORTAL_URL,
			APP_ID,
			SIGNING_KEY: `${privateJwk.kid}:${privateJwk.d}`,
			REGISTRATION_TOKEN_HASH: hashRegistrationToken('rt_grades_api_tests_0123456789'),
		},
		root: ROOT,
		overrides: { fetch: portal.fetch, now: clock.now, logger: noopLogger, outboundSend: bucket.send },
	});
	const grades = wireEvents(createGrades(app));
	const handle = createRequestHandler(grades.product, buildRoutes(grades));

	let version = 0;
	/**
	 * Publish the entitlement of a website (all elements on by default); every call is a newer document version.
	 * @param {{ websiteId?: string, config?: Record<string, any>, elements?: Record<string, boolean>, website?: Record<string, string> }} [input]
	 */
	const entitle = async ({ websiteId = WEBSITE, config: overrides = {}, elements: switches = {}, website } = {}) => {
		const merged = { ...config, ...overrides };
		const flags = { ...elements, ...switches };
		await portal.setEntitlement({
			websiteId,
			merchantId: MERCHANT,
			productSlug: 'grades',
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
			...(website ? { website } : {}),
		});
		await grades.product.entitlements.refresh(websiteId);
	};
	for (const website of [WEBSITE, WEBSITE_2]) {
		portal.setResource(website, 'database', { uri, dbName }, 365 * DAY);
		if (storage) portal.setResource(website, 'storage', STORAGE, 365 * DAY);
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
	const call = async (method, path, { body, key: bearer = sk, headers = {}, idempotencyKey } = {}) => {
		const response = await handle(
			new Request(`https://grades.example.com${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
					...(bearer === pk ? ORIGIN : {}),
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
			new Request('https://grades.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: signed.headers,
				body: signed.body,
			}),
		);
		return { status: response.status, id };
	};

	/**
	 * A dashboard session (`ses_…`) from a launch exchanged at /sso.
	 * @param {'merchant' | 'demo' | 'admin' | 'impersonate'} [kind]
	 * @param {Record<string, unknown>} [extra]
	 */
	const session = async (kind = 'merchant', extra = {}) => {
		const { token } = await portal.issueLaunch({
			kind,
			subject: 'usr_merchant',
			user: { id: 'usr_merchant' },
			scope: kind === 'demo' ? {} : { merchantId: MERCHANT, websiteId: WEBSITE },
			...extra,
		});
		const sso = await handle(new Request(`https://grades.example.com/sso?launch=${encodeURIComponent(token)}`));
		const id = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		if (!id) throw new Error(`no session (${sso.status})`);
		return id;
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
		grades,
		handle,
		call,
		deliver,
		session,
		published,
		entitle,
		key,
		bucket,
		sk,
		pk,
		db,
		/** Raw merchant collection. @param {string} name */
		collection: (name) => db.collection(`ss_grades_${name}`),
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};
