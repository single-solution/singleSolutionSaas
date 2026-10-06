/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal and a fake messaging provider (app-kit `outboundSend`), with the merchant database on the test run's
 * MongoMemoryReplSet (`SS_TEST_MONGO_URI`, started by the @ss/config Mongo global setup).
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal, createTestIdentityIssuer } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createAlerts, wireEvents } from '../api/routes.js';
import { cronRoutes, scheduleDispatch } from '../jobs/dispatch.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PORTAL_URL = 'https://portal.test';
export const APP_ID = 'app_0123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const WEBSITE_2 = 'web_1123456789abcdefghjkmnpq';
export const DOMAIN = 'shop.example.com';
export const CRON_SECRET = 'cron-secret-0123456789abcdef';
export const PROVIDER = 'https://msg.example.com';
export const T0 = Date.parse('2026-10-01T10:00:00Z');
export const ELEMENTS = ['triggers', 'types', 'capture', 'dispatch', 'waitlist_priority', 'unsubscribe', 'analytics'];

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

/**
 * A fake messaging provider behind app-kit's outbound `send`: records every request; `fail(n, status)` makes the next
 * n sends answer `status`; `throwNext(n)` makes them fail at the network level.
 */
export const createFakeProvider = () => {
	/** @type {Array<{ url: string, headers: Record<string, string>, body: any, accepted: boolean }>} */
	const requests = [];
	let failures = 0;
	let failStatus = 503;
	let throws = 0;
	/** @type {Array<() => Promise<void>>} */
	const gates = [];
	return {
		requests,
		/** Messages accepted (2xx). */
		get sent() {
			return requests.filter((request) => request.accepted).map((request) => request.body);
		},
		/** @param {number} n @param {number} [status] */
		fail: (n, status = 503) => {
			failures = n;
			failStatus = status;
		},
		/** @param {number} n */
		throwNext: (n) => {
			throws = n;
		},
		/** Hold the next send until the returned function is called. */
		hold: () => {
			/** @type {() => void} */
			let release = () => {};
			const wait = new Promise((resolve) => {
				release = () => resolve(undefined);
			});
			gates.push(() => /** @type {Promise<void>} */ (wait));
			return release;
		},
		/**
		 * @param {string} url
		 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [init]
		 */
		send: async (url, init = {}) => {
			const gate = gates.shift();
			if (gate) await gate();
			if (throws > 0) {
				throws -= 1;
				throw Object.assign(new Error('network down'), { code: 'network', name: 'NetError' });
			}
			const body = init.body ? JSON.parse(String(init.body)) : null;
			const accepted = failures === 0;
			requests.push({ url, headers: init.headers ?? {}, body, accepted });
			if (!accepted) {
				failures -= 1;
				return { status: failStatus, headers: {}, body: Buffer.from('{"error":"unavailable"}'), url };
			}
			return { status: 202, headers: {}, body: Buffer.from(JSON.stringify({ id: `prov_${requests.length}` })), url };
		},
	};
};

/**
 * @param {{ config?: Record<string, Record<string, unknown>>, elements?: Record<string, boolean>, env?: Record<string, string>,
 *   identity?: boolean, messaging?: boolean }} [options]
 */
export const createHarness = async ({ config = {}, elements = {}, env = {}, identity = false, messaging = true } = {}) => {
	const clock = createClock();
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'alerts-test-1' });
	portal.trustProductKey(publicJwk);
	const provider = createFakeProvider();
	const dbName = `alerts_${nodeRandomBytes(5).toString('hex')}`;
	const uri = mongoUri(dbName);
	const client = await new MongoClient(uri).connect();
	const app = await createPlatform({
		env: {
			SS_PORTAL_URL: PORTAL_URL,
			SS_APP_ID: APP_ID,
			SS_APP_SIGNING_KEY: JSON.stringify(privateJwk),
			SS_REGISTRATION_TOKEN_HASH: hashRegistrationToken('rt_alerts_api_tests_0123456789'),
			CRON_SECRET,
			...env,
		},
		root: ROOT,
		overrides: { fetch: portal.fetch, now: clock.now, logger: noopLogger, outboundSend: provider.send },
	});
	const alerts = scheduleDispatch(wireEvents(createAlerts(app)));
	const handle = createRequestHandler(alerts.product, [...buildRoutes(alerts), ...cronRoutes(alerts)]);
	const issuer = identity
		? await createTestIdentityIssuer({
				issuer: 'https://login.shop.example.com',
				claimMap: { subject: 'sub', email: 'email', phone: 'phone_number' },
			})
		: null;

	let version = 0;
	/**
	 * Publish the entitlement of a website (all elements on by default); every call is a newer document version.
	 * @param {{ websiteId?: string, config?: Record<string, any>, elements?: Record<string, boolean> }} [input]
	 */
	const entitle = async ({ websiteId = WEBSITE, config: overrides = {}, elements: switches = {} } = {}) => {
		const merged = { ...config, ...overrides };
		const flags = { ...elements, ...switches };
		await portal.setEntitlement({
			websiteId,
			merchantId: MERCHANT,
			productSlug: 'alerts',
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
			...(issuer ? { identity: issuer.section } : {}),
		});
		await alerts.product.entitlements.refresh(websiteId);
	};
	for (const websiteId of [WEBSITE, WEBSITE_2]) {
		portal.setResource(websiteId, 'database', { uri, dbName }, 24 * 3_600_000);
		if (messaging)
			portal.setResource(
				websiteId,
				'messaging',
				{ provider: 'generic-http', baseUrl: PROVIDER, apiKey: 'msg_test_key', authScheme: 'bearer' },
				24 * 3_600_000,
			);
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
	 * @param {{ body?: unknown, key?: string | null, headers?: Record<string, string>, idempotencyKey?: string | null, raw?: string }} [init]
	 */
	const call = async (method, path, { body, key: bearer = sk, headers = {}, idempotencyKey, raw } = {}) => {
		const response = await handle(
			new Request(`https://alerts.example.com${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
					...(bearer && bearer.startsWith('pk_') ? { origin: `https://${DOMAIN}` } : {}),
					...(method === 'POST' && idempotencyKey !== null ? { 'idempotency-key': idempotencyKey ?? createId('idk') } : {}),
					...headers,
				},
				...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
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
	 * @param {{ id?: string, websiteId?: string, occurredAt?: number, actor?: { type: string, id?: string } }} [options]
	 */
	const deliver = async (
		type,
		data,
		{ id = createId('evt'), websiteId = WEBSITE, occurredAt = clock.now(), actor = { type: 'merchant' } } = {},
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
			new Request('https://alerts.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: signed.headers,
				body: signed.body,
			}),
		);
		return { status: response.status, id, envelope, signed };
	};

	/**
	 * Subscribe through the API.
	 * @param {Record<string, unknown>} [body]
	 * @param {{ key?: string, headers?: Record<string, string> }} [options]
	 */
	const subscribe = async (body = {}, { key: bearer = sk, headers = {} } = {}) =>
		call('POST', '/v1/subscriptions', {
			key: bearer,
			headers,
			body: { type: 'back_in_stock', itemId: 'itm_1', channel: 'email', email: 'jane@example.com', consent: true, ...body },
		});

	/** Published events of a type. @param {string} type */
	const published = (type) =>
		portal.published
			.flatMap((/** @type {any} */ body) => body?.events ?? [])
			.filter((/** @type {any} */ event) => event.type === type);

	/** Site of the main website. */
	const site = async (websiteId = WEBSITE) => /** @type {import('../api/service.js').Site} */ (await alerts.siteFor(websiteId));

	/**
	 * A customer login token of the website's own issuer.
	 * @param {Record<string, unknown>} claims
	 */
	const login = async (claims) => {
		if (!issuer) throw new Error('createHarness({ identity: true }) first');
		return issuer.sign({
			iss: 'https://login.shop.example.com',
			iat: Math.floor(clock.now() / 1000),
			exp: Math.floor(clock.now() / 1000) + 3600,
			...claims,
		});
	};

	const db = client.db(dbName);
	return {
		clock,
		portal,
		provider,
		app,
		alerts,
		handle,
		call,
		deliver,
		subscribe,
		published,
		entitle,
		site,
		login,
		key,
		sk,
		pk,
		db,
		/** Raw merchant collection. @param {string} name */
		collection: (name) => db.collection(`ss_alerts_${name}`),
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};
