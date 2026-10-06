/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal, with the merchant database on the test run's MongoMemoryReplSet (`TEST_MONGODB_URI`, started by the
 * vitest global setup).
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createConfiguratorApp, wireEvents } from '../api/routes.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PORTAL_URL = 'https://portal.test';
export const APP_ID = 'app_0123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const WEBSITE_2 = 'web_1123456789abcdefghjkmnpq';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = `https://${DOMAIN}`;
export const T0 = Date.parse('2026-10-01T10:00:00Z');
export const ELEMENTS = ['schema', 'resolver', 'price_deltas', 'url_sync', 'widget', 'api'];

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

/**
 * @param {{ config?: Record<string, Record<string, unknown>>, elements?: Record<string, boolean>,
 *   website?: Record<string, string> }} [options]
 */
export const createHarness = async ({ config = {}, elements = {}, website } = {}) => {
	const clock = createClock();
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'configurator-test-1' });
	portal.trustProductKey(publicJwk);
	const dbName = `configurator_${nodeRandomBytes(5).toString('hex')}`;
	const uri = mongoUri(dbName);
	const client = await new MongoClient(uri).connect();
	const app = await createPlatform({
		env: {},
		root: ROOT,
		overrides: {
			portalUrl: PORTAL_URL,
			appId: APP_ID,
			signingKey: `${privateJwk.kid}:${privateJwk.d}`,
			fetch: portal.fetch,
			now: clock.now,
			logger: noopLogger,
		},
	});
	const configurator = wireEvents(createConfiguratorApp(app));
	const handle = createRequestHandler(configurator.product, buildRoutes(configurator));

	let version = 0;
	/**
	 * Publish the entitlement of a website (all elements on by default); every call is a newer document version.
	 * @param {{ websiteId?: string, config?: Record<string, any>, elements?: Record<string, boolean>, website?: Record<string, string> }} [input]
	 */
	const entitle = async ({
		websiteId = WEBSITE,
		config: overrides = {},
		elements: switches = {},
		website: settings = website,
	} = {}) => {
		const merged = { ...config, ...overrides };
		const flags = { ...elements, ...switches };
		await portal.setEntitlement({
			websiteId,
			merchantId: MERCHANT,
			productSlug: 'configurator',
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
			...(settings ? { website: settings } : {}),
		});
		await configurator.product.entitlements.refresh(websiteId);
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
		const browser = bearer !== null && bearer === pk;
		const response = await handle(
			new Request(`https://configurator.example.com${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
					...(browser ? { origin: ORIGIN } : {}),
					...(method === 'POST' && idempotencyKey !== null ? { 'idempotency-key': idempotencyKey ?? createId('idk') } : {}),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
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
			new Request('https://configurator.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: signed.headers,
				body: signed.body,
			}),
		);
		return { status: response.status, id, envelope };
	};

	/**
	 * A dashboard session cookie of a launch.
	 * @param {{ kind?: string, scope?: Record<string, unknown> }} [input]
	 */
	const session = async ({ kind = 'merchant', scope = { merchantId: MERCHANT, websiteId: WEBSITE } } = {}) => {
		const { token } = await portal.issueLaunch(
			/** @type {any} */ ({
				kind,
				subject: 'usr_merchant',
				user: { id: 'usr_merchant' },
				scope: kind === 'demo' ? {} : scope,
			}),
		);
		const response = await handle(new Request(`https://configurator.example.com/sso?launch=${encodeURIComponent(token)}`));
		const id = /ss_session=(ses_[^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
		if (!id) throw new Error(`no session (${response.status})`);
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
		configurator,
		handle,
		call,
		deliver,
		session,
		published,
		entitle,
		key,
		sk,
		pk,
		db,
		/** Raw merchant collection. @param {string} name */
		collection: (name) => db.collection(`ss_configurator_${name}`),
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};
