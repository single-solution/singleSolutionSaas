/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal, with the merchant database on the test run's MongoMemoryReplSet (`TEST_MONGODB_URI`, started by the root
 * vitest global setup) and a fake messaging gateway behind the merchant's messaging connector (app-kit `outboundSend`).
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createSignups, wireEvents } from '../api/routes.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PORTAL_URL = 'https://portal.test';
export const APP_ID = 'app_0123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const WEBSITE_2 = 'web_1123456789abcdefghjkmnpq';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = { origin: `https://${DOMAIN}` };
export const SEAL_SECRET = 'seal-secret-0123456789abcdefghijklmnopqrstuvwxyz';
export const T0 = Date.parse('2026-10-01T10:00:00Z');
export const ELEMENTS = ['profile', 'sessions', 'otp', 'magic_link', 'account_pages', 'widget', 'risk', 'consent', 'data_rights'];
export const GATEWAY = 'https://gateway.example.net';

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
 * A fake messaging gateway (what app-kit's connector posts to the merchant's provider).
 */
export const createGateway = () => {
	/** @type {Array<Record<string, any>>} */
	const messages = [];
	/** @type {Array<{ status: number, body?: unknown } | 'throw'>} */
	const queued = [];
	/** @type {(url: string, init?: any) => Promise<any>} */
	const send = async (url, init = {}) => {
		const next = queued.shift();
		if (next === 'throw') throw Object.assign(new Error('network'), { code: 'network' });
		const message = JSON.parse(String(init.body ?? '{}'));
		messages.push({ ...message, _url: url, _auth: init.headers?.authorization ?? null });
		const status = next?.status ?? 202;
		return { status, headers: {}, url, body: Buffer.from(JSON.stringify(next?.body ?? { id: `msg_${messages.length}` })) };
	};
	return {
		send,
		messages,
		/** @param {{ status: number, body?: unknown } | 'throw'} response */
		failNext: (response) => queued.push(response),
		/** The last message sent to `to`. @param {string} to */
		last: (to) => [...messages].reverse().find((m) => m.to === to),
		/** The code in the last message to `to`. @param {string} to */
		code: (to) => String([...messages].reverse().find((m) => m.to === to)?.variables?.code ?? ''),
		/** The magic-link token in the last message to `to`. @param {string} to */
		linkToken: (to) => {
			const link = String([...messages].reverse().find((m) => m.to === to)?.variables?.link ?? '');
			return decodeURIComponent(link.split('#ss_magic=')[1] ?? '');
		},
	};
};

/**
 * @param {{ config?: Record<string, any>, elements?: Record<string, boolean>, env?: Record<string, string>, messaging?: boolean }} [options]
 */
export const createHarness = async (
	/** @type {{ config?: Record<string, any>, elements?: Record<string, boolean>, env?: Record<string, string>, messaging?: boolean }} */ {
		config = {},
		elements = {},
		env = {},
		messaging = true,
	} = {},
) => {
	const clock = createClock();
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const gateway = createGateway();
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'signups-test-1' });
	portal.trustProductKey(publicJwk);
	const dbName = `signups_${nodeRandomBytes(5).toString('hex')}`;
	const uri = mongoUri(dbName);
	const client = await new MongoClient(uri).connect();
	const app = await createPlatform({
		env: {
			...env,
		},
		root: ROOT,
		overrides: { portalUrl: PORTAL_URL, appId: APP_ID, signingKey: `${privateJwk.kid}:${privateJwk.d}`, fetch: portal.fetch, now: clock.now, logger: noopLogger, outboundSend: gateway.send },
	});
	const signups = wireEvents(createSignups(app));
	const handle = createRequestHandler(signups.product, buildRoutes(signups));

	let version = 0;
	/**
	 * Publish the entitlement of a website (all elements on by default); every call is a newer document version.
	 * @param {{ websiteId?: string, config?: Record<string, any>, elements?: Record<string, boolean>,
	 *   identity?: import('@ss/contracts').IdentitySection, allowSubdomains?: boolean }} [input]
	 */
	const entitle = async ({
		websiteId = WEBSITE,
		config: overrides = {},
		elements: switches = {},
		identity,
		allowSubdomains,
	} = {}) => {
		const merged = { ...config, ...overrides };
		const flags = { ...elements, ...switches };
		await portal.setEntitlement({
			websiteId,
			merchantId: MERCHANT,
			productSlug: 'signups',
			domain: DOMAIN,
			version: (version += 1),
			validForMs: 3_600_000,
			...(allowSubdomains === undefined ? {} : { allowSubdomains }),
			elements: Object.fromEntries(
				ELEMENTS.map((key) => [
					key,
					flags[key] === false ? { enabled: false, reason: 'merchant_disabled' } : { enabled: true },
				]),
			),
			config: Object.fromEntries(ELEMENTS.map((key) => [key, merged[key] ?? {}])),
			...(identity ? { identity } : {}),
		});
		await signups.product.entitlements.refresh(websiteId);
	};
	for (const id of [WEBSITE, WEBSITE_2]) {
		portal.setResource(id, 'database', { uri, dbName }, 24 * 3_600_000);
		if (messaging)
			portal.setResource(
				id,
				'messaging',
				{ provider: 'generic-http', baseUrl: GATEWAY, apiKey: 'gw-key-123' },
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
	 * @param {{ body?: unknown, key?: string | null, headers?: Record<string, string>, idempotencyKey?: string | null, token?: string }} [init]
	 */
	const call = async (method, path, { body, key: bearer = pk, headers = {}, idempotencyKey, token } = {}) => {
		const response = await handle(
			new Request(`https://signups.example.com${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
					...(bearer === pk
						? { ...ORIGIN, 'x-forwarded-for': '203.0.113.7', 'user-agent': 'Mozilla/5.0 (Android 14) Firefox/130.0' }
						: {}),
					...(method === 'POST' && idempotencyKey !== null ? { 'idempotency-key': idempotencyKey ?? createId('idk') } : {}),
					...(token ? { 'ss-identity': token } : {}),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
	};

	/**
	 * Sign in with a one-time code end to end (the clock first moves past any resend cooldown); returns the verify answer.
	 * @param {string} to
	 * @param {{ channel?: string, deviceId?: string, consents?: Array<{ key: string, version: string }>, headers?: Record<string, string> }} [options]
	 */
	const signIn = async (to, { channel = 'email', deviceId, consents, headers } = {}) => {
		clock.advance(61_000);
		const sent = await call('POST', '/v1/otp', {
			body: { channel, to, ...(deviceId ? { deviceId } : {}) },
			...(headers ? { headers } : {}),
		});
		if (sent.status !== 202) throw new Error(`otp request answered ${sent.status}: ${JSON.stringify(sent.json)}`);
		const destination = sent.json.destination;
		const message = gateway.messages.at(-1);
		const verified = await call('POST', `/v1/otp/${sent.json.challengeId}/verify`, {
			body: {
				code: String(message?.variables?.code ?? ''),
				...(deviceId ? { deviceId } : {}),
				...(consents ? { consents } : {}),
			},
			...(headers ? { headers } : {}),
		});
		return { ...verified, challengeId: sent.json.challengeId, destination };
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
			new Request('https://signups.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: signed.headers,
				body: signed.body,
			}),
		);
		return { status: response.status, id };
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
		gateway,
		app,
		signups,
		handle,
		call,
		signIn,
		deliver,
		published,
		entitle,
		key,
		sk,
		pk,
		db,
		/** Raw merchant collection. @param {string} name */
		collection: (name) => db.collection(`ss_signups_${name}`),
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};
