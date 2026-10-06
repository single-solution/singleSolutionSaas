/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal, with the merchant database on the test run's MongoMemoryReplSet (`TEST_MONGODB_URI`, started by the
 * vitest global setup), the merchant's website (crawled sources) replaced by an in-memory `outboundSend`, and —
 * optionally — Atlas Search replaced by the simulator in `atlas-sim.js` (mongodb-memory-server has no `$search`).
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createSearchApp, wireEvents } from '../api/routes.js';

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
export const ELEMENTS = ['index', 'sources', 'ranking', 'suggestions', 'overlay', 'analytics'];

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

/** The merchant's public website: `pages.set(url, { status?, type?, body })`; every request is recorded. */
export const createWebsite = () => {
	/** @type {Map<string, { status?: number, type?: string, body: string }>} */
	const pages = new Map();
	/** @type {Array<{ url: string, init: any }>} */
	const requests = [];
	/**
	 * @param {string} url
	 * @param {any} [init]
	 */
	const send = async (url, init = {}) => {
		requests.push({ url, init });
		const page = pages.get(url);
		if (!page) return { status: 404, headers: {}, body: Buffer.alloc(0), url };
		if (page.status === 599) throw Object.assign(new Error('timeout'), { code: 'timeout' });
		return {
			status: page.status ?? 200,
			headers: { 'content-type': page.type ?? 'text/html; charset=utf-8' },
			body: Buffer.from(page.body),
			url,
		};
	};
	return { pages, requests, send };
};

/**
 * @param {{ config?: Record<string, any>, elements?: Record<string, boolean>, website?: Record<string, string>,
 *   atlas?: { atlasRunner?: any, atlasProbe?: any } }} [options]
 */
export const createHarness = async ({ config = {}, elements = {}, website = { timeZone: 'UTC' }, atlas = {} } = {}) => {
	const clock = createClock();
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'search-test-1' });
	portal.trustProductKey(publicJwk);
	const dbName = `search_${nodeRandomBytes(5).toString('hex')}`;
	const uri = mongoUri(dbName);
	const client = await new MongoClient(uri).connect();
	const site = createWebsite();
	const app = await createPlatform({
		env: {},
		root: ROOT,
		overrides: { portalUrl: PORTAL_URL, appId: APP_ID, signingKey: `${privateJwk.kid}:${privateJwk.d}`, fetch: portal.fetch, now: clock.now, logger: noopLogger, outboundSend: site.send },
	});
	const search = wireEvents(createSearchApp(app, atlas));
	const handle = createRequestHandler(search.product, buildRoutes(search), {
		maxBodyBytes: 8_000_000,
	});

	let version = 0;
	/**
	 * Publish the entitlement of a website (all elements on by default); every call is a newer document version.
	 * @param {{ websiteId?: string, config?: Record<string, any>, elements?: Record<string, boolean>, website?: Record<string, string> | null }} [input]
	 */
	const entitle = async ({
		websiteId = WEBSITE,
		config: overrides = {},
		elements: switches = {},
		website: section = website,
	} = {}) => {
		const merged = { ...config, ...overrides };
		const flags = { ...elements, ...switches };
		await portal.setEntitlement({
			websiteId,
			merchantId: MERCHANT,
			productSlug: 'search',
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
		});
		await search.product.entitlements.refresh(websiteId);
		search.engines.forget(websiteId);
		search.search.forget(websiteId);
	};
	for (const id of [WEBSITE, WEBSITE_2]) portal.setResource(id, 'database', { uri, dbName }, 365 * DAY);
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
	const call = async (method, path, { body, key: bearer, headers = {}, idempotencyKey } = {}) => {
		const auth = bearer === undefined ? sk : bearer;
		const response = await handle(
			new Request(`https://search.example.com${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(auth ? { authorization: `Bearer ${auth}` } : {}),
					...(auth && auth.startsWith('pk_') ? ORIGIN : {}),
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
			new Request('https://search.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: signed.headers,
				body: signed.body,
			}),
		);
		return { status: response.status, id };
	};

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
		const sso = await handle(new Request(`https://search.example.com/sso?launch=${encodeURIComponent(token)}`));
		const id = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		if (!id) throw new Error(`no session (${sso.status})`);
		return id;
	};

	/** Index documents through the API (sk_). @param {Array<Record<string, unknown>>} docs */
	const index = async (docs) => {
		for (const doc of docs) {
			const result = await call('POST', '/v1/documents', { body: doc });
			if (result.status !== 201 && result.status !== 200) throw new Error(`index failed ${result.status} ${result.text}`);
		}
	};

	const db = client.db(dbName);
	return {
		clock,
		portal,
		app,
		search,
		handle,
		call,
		deliver,
		entitle,
		key,
		session,
		index,
		site,
		sk,
		pk,
		db,
		/** Raw merchant collection. @param {string} name @returns {any} */
		collection: (name) => db.collection(`ss_search_${name}`),
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};
