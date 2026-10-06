/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal, with the merchant database on the test run's MongoMemoryReplSet (`SS_TEST_MONGO_URI`, started by the root
 * vitest global setup) and scripted outbound HTTP (AI provider, knowledge pages, webhook tools).
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createLogger, createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createChatbot, wireEvents } from '../api/routes.js';
import { createNetwork } from './helpers.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PORTAL_URL = 'https://portal.test';
export const APP_ID = 'app_0123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const WEBSITE_2 = 'web_1123456789abcdefghjkmnpq';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = `https://${DOMAIN}`;
export const T0 = Date.parse('2026-10-01T10:00:00Z');
export const ELEMENTS = [
	'window',
	'launcher',
	'ai_replies',
	'knowledge',
	'flows',
	'tools',
	'inbox',
	'handoff',
	'proactive',
	'lead_capture',
	'csat',
	'transcripts',
	'moderation',
];
export const AI_DESCRIPTOR = {
	provider: 'openai',
	baseUrl: 'https://ai.test/v1',
	apiKey: 'sk-merchant-test-key',
	authScheme: 'bearer',
	model: 'gpt-test',
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

/**
 * @param {{ config?: Record<string, any>, elements?: Record<string, boolean>, env?: Record<string, string>, ai?: boolean }} [options]
 */
export const createHarness = async ({ config = {}, elements = {}, env = {}, ai = true } = {}) => {
	const clock = createClock();
	const network = createNetwork();
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'chatbot-test-1' });
	portal.trustProductKey(publicJwk);
	const dbName = `chatbot_${nodeRandomBytes(5).toString('hex')}`;
	const uri = mongoUri(dbName);
	const client = await new MongoClient(uri).connect();
	const app = await createPlatform({
		env: {
			SS_PORTAL_URL: PORTAL_URL,
			SS_APP_ID: APP_ID,
			SS_APP_SIGNING_KEY: JSON.stringify(privateJwk),
			SS_REGISTRATION_TOKEN_HASH: hashRegistrationToken('rt_chatbot_api_tests_0123456789'),
			...env,
		},
		root: ROOT,
		overrides: {
			fetch: portal.fetch,
			now: clock.now,
			// CHATBOT_TEST_LOG=1 prints the product's JSON logs (errors included) while debugging a test
			logger: process.env.CHATBOT_TEST_LOG
				? createLogger({ level: 'warn', write: (line) => process.stderr.write(`${line}\n`) })
				: noopLogger,
			outboundSend: network.send,
		},
	});
	const chatbot = wireEvents(createChatbot(app));
	const handle = createRequestHandler(chatbot.product, buildRoutes(chatbot));

	let version = 0;
	/**
	 * Publish the entitlement of a website (all elements on by default); every call is a newer document version.
	 * @param {{ websiteId?: string, config?: Record<string, any>, elements?: Record<string, boolean>, identity?: any }} [input]
	 */
	const entitle = async ({ websiteId = WEBSITE, config: overrides = {}, elements: switches = {}, identity } = {}) => {
		const merged = { ...config, ...overrides };
		const flags = { ...elements, ...switches };
		await portal.setEntitlement({
			websiteId,
			merchantId: MERCHANT,
			productSlug: 'chatbot',
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
		await chatbot.product.entitlements.refresh(websiteId);
	};
	portal.setResource(WEBSITE, 'database', { uri, dbName }, 24 * 3_600_000);
	portal.setResource(WEBSITE_2, 'database', { uri, dbName }, 24 * 3_600_000);
	if (ai) portal.setResource(WEBSITE, 'ai', AI_DESCRIPTOR, 24 * 3_600_000);
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
	 * @param {{ body?: unknown, key?: string | null, headers?: Record<string, string>, idempotencyKey?: string | null, identity?: string | null }} [init]
	 */
	const call = async (method, path, { body, key: bearer = sk, headers = {}, idempotencyKey, identity = null } = {}) => {
		const response = await handle(
			new Request(`https://chatbot.example.com${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
					...(bearer && bearer.startsWith('pk_') ? { origin: ORIGIN } : {}),
					...(identity ? { 'ss-identity': identity } : {}),
					...(method === 'POST' && idempotencyKey !== null ? { 'idempotency-key': idempotencyKey ?? createId('idk') } : {}),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		/** @type {any} */
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = text;
		}
		return { status: response.status, headers: response.headers, json, text };
	};
	/** Browser call (pk_ from the bound origin). @param {string} method @param {string} path @param {Parameters<typeof call>[2]} [init] */
	const browser = (method, path, init = {}) => call(method, path, { key: pk, ...init });

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
			new Request('https://chatbot.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: signed.headers,
				body: signed.body,
			}),
		);
		return { status: response.status, id };
	};

	/** Published events of a type. @param {string} type */
	const published = (type) =>
		portal.published.flatMap((/** @type {any} */ b) => b?.events ?? []).filter((/** @type {any} */ e) => e.type === type);

	const db = client.db(dbName);
	return {
		clock,
		portal,
		network,
		app,
		chatbot,
		handle,
		call,
		browser,
		deliver,
		published,
		entitle,
		key,
		sk,
		pk,
		db,
		/** Raw merchant collection. @param {string} name */
		collection: (name) => db.collection(`ss_chatbot_${name}`),
		/** Usage records the product queued (flushed to the fake Portal). */
		usage: async () => {
			await chatbot.product.usage.flush();
			return [...portal.usage.values()];
		},
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};
