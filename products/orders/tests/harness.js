/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal, with the merchant database on the test run's MongoMemoryReplSet (`SS_TEST_MONGO_URI`) and the merchant's
 * messaging provider replaced by an in-memory `outboundSend`.
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal, createTestIdentityIssuer } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createOrders, wireEvents } from '../api/routes.js';
import { cronRoutes, wireJobs } from '../jobs/sweep.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PORTAL_URL = 'https://portal.test';
export const APP_ID = 'app_0123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const WEBSITE_2 = 'web_1123456789abcdefghjkmnpq';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = { origin: `https://${DOMAIN}` };
export const CRON_SECRET = 'cron-secret-0123456789abcdef';
export const PROVIDER = 'https://messages.example.com';
export const T0 = Date.parse('2026-10-01T10:00:00Z');
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const ELEMENTS = [
	'lifecycle',
	'fulfilment',
	'serials',
	'invoices',
	'print',
	'bulk',
	'risk',
	'customer_updates',
	'ledger',
	'inbound_api',
];

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
	const base = process.env.SS_TEST_MONGO_URI;
	if (!base) throw new Error('SS_TEST_MONGO_URI is not set (run through this product vitest config)');
	const url = new URL(base);
	url.pathname = `/${name}`;
	return url.toString();
};

/** A fake messaging provider: records every request; `fail(n, status)` makes the next n sends answer `status`. */
export const createFakeProvider = () => {
	/** @type {Array<{ url: string, headers: Record<string, string>, body: any, accepted: boolean }>} */
	const requests = [];
	let failures = 0;
	let failStatus = 503;
	return {
		requests,
		get sent() {
			return requests.filter((r) => r.accepted).map((r) => r.body);
		},
		/** @param {number} n @param {number} [status] */
		fail: (n, status = 503) => {
			failures = n;
			failStatus = status;
		},
		/** @param {string} url @param {{ headers?: Record<string, string>, body?: string }} [init] */
		send: async (url, init = {}) => {
			const body = init.body ? JSON.parse(String(init.body)) : null;
			const accepted = failures === 0;
			requests.push({ url, headers: init.headers ?? {}, body, accepted });
			if (!accepted) {
				failures -= 1;
				return { status: failStatus, headers: {}, body: Buffer.from('{}'), url };
			}
			return { status: 202, headers: {}, body: Buffer.from(JSON.stringify({ id: `prov_${requests.length}` })), url };
		},
	};
};

export const issuer = createTestIdentityIssuer({ alg: 'ES256', audience: 'shop-web' });

/**
 * @param {{ config?: Record<string, any>, elements?: Record<string, boolean>, website?: Record<string, string>, messaging?: boolean }} [options]
 */
export const createHarness = async ({
	config = {},
	elements = {},
	website = { currency: 'EUR', language: 'en' },
	messaging = true,
} = {}) => {
	const clock = createClock();
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'orders-test-1' });
	portal.trustProductKey(publicJwk);
	const dbName = `orders_${nodeRandomBytes(5).toString('hex')}`;
	const uri = mongoUri(dbName);
	const client = await new MongoClient(uri).connect();
	const provider = createFakeProvider();
	const app = await createPlatform({
		env: {
			SS_PORTAL_URL: PORTAL_URL,
			SS_APP_ID: APP_ID,
			SS_APP_SIGNING_KEY: JSON.stringify(privateJwk),
			SS_REGISTRATION_TOKEN_HASH: hashRegistrationToken('rt_orders_api_tests_0123456789'),
			CRON_SECRET,
		},
		root: ROOT,
		overrides: { fetch: portal.fetch, now: clock.now, logger: noopLogger, outboundSend: provider.send },
	});
	const orders = wireJobs(wireEvents(createOrders(app)));
	const handle = createRequestHandler(orders.product, [...buildRoutes(orders), ...cronRoutes(orders)], {
		maxBodyBytes: 16_000_000,
	});

	let version = 0;
	/**
	 * Publish the entitlement of a website (all elements on by default); every call is a newer document version.
	 * @param {{ websiteId?: string, config?: Record<string, any>, elements?: Record<string, boolean>, website?: Record<string, string> | null, identity?: boolean }} [input]
	 */
	const entitle = async ({
		websiteId = WEBSITE,
		config: overrides = {},
		elements: switches = {},
		website: section = website,
		identity = true,
	} = {}) => {
		const merged = { ...config, ...overrides };
		const flags = { ...elements, ...switches };
		await portal.setEntitlement({
			websiteId,
			merchantId: MERCHANT,
			productSlug: 'orders',
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
			...(identity ? { identity: issuer.section } : {}),
		});
		await orders.product.entitlements.refresh(websiteId);
	};
	for (const id of [WEBSITE, WEBSITE_2]) {
		portal.setResource(id, 'database', { uri, dbName }, 365 * DAY);
		if (messaging)
			portal.setResource(
				id,
				'messaging',
				{ provider: 'generic-http', baseUrl: PROVIDER, apiKey: 'msg_test_key', authScheme: 'bearer' },
				365 * DAY,
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
	 * A customer login token of the website's own issuer.
	 * @param {Record<string, unknown>} claims
	 */
	const login = (claims) => {
		const now = Math.floor(clock.now() / 1000);
		return issuer.sign({ iss: issuer.section.issuer, aud: 'shop-web', iat: now, exp: now + 900, ...claims });
	};

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ body?: unknown, key?: string | null, headers?: Record<string, string>, idempotencyKey?: string | null, identity?: string }} [init]
	 */
	const call = async (method, path, { body, key: bearer, headers = {}, idempotencyKey, identity } = {}) => {
		const auth = bearer === undefined ? sk : bearer;
		const response = await handle(
			new Request(`https://orders.example.com${path}`, {
				method,
				headers: {
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(auth ? { authorization: `Bearer ${auth}` } : {}),
					...(auth === pk ? ORIGIN : {}),
					...(identity ? { 'ss-identity': identity } : {}),
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
	 * @param {{ id?: string, websiteId?: string, context?: Record<string, unknown> }} [options]
	 */
	const deliver = async (type, data, { id = createId('evt'), websiteId = WEBSITE, context = { source: 'portal' } } = {}) => {
		const envelope = {
			id,
			type,
			websiteId,
			env: 'live',
			occurredAt: new Date(clock.now()).toISOString(),
			idempotencyKey: id,
			actor: { type: 'system' },
			data,
			context,
		};
		const signed = await portal.signEvent(envelope);
		const response = await handle(
			new Request('https://orders.example.com/.well-known/ss-events', {
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
	 */
	const session = async (kind = 'merchant') => {
		const { token } = await portal.issueLaunch(
			/** @type {any} */ ({
				kind,
				subject: 'usr_merchant',
				user: { id: 'usr_merchant' },
				scope: kind === 'demo' ? {} : { merchantId: MERCHANT, websiteId: WEBSITE },
			}),
		);
		const sso = await handle(new Request(`https://orders.example.com/sso?launch=${encodeURIComponent(token)}`));
		const sid = /ss_session=(ses_[^;]+)/.exec(sso.headers.get('set-cookie') ?? '')?.[1];
		if (!sid) throw new Error(`no session (${sso.status})`);
		return sid;
	};

	/**
	 * Create an order through the inbound API.
	 * @param {Record<string, any>} [overrides]
	 */
	const order = async (overrides = {}) => {
		const result = await call('POST', '/v1/inbound-orders', {
			body: {
				currency: 'EUR',
				customer: { customerId: 'cus_1', email: 'ada@example.com', phone: '+44 20 7946 0000', name: 'Ada' },
				shipping: { name: 'Ada', line1: '1 Main St', city: 'Springfield', country: 'Freedonia' },
				payment: { method: 'bank_transfer' },
				lines: [
					{ itemId: 'itm_1', sku: 'LAMP-1', title: 'Desk lamp', quantity: 2, unitAmount: 2500, warranty: { days: 365 } },
					{ itemId: 'itm_2', sku: 'CABLE-1', title: 'Cable', quantity: 1, unitAmount: 500, warranty: { days: 0 } },
				],
				...overrides,
			},
		});
		if (result.status !== 201 && result.status !== 200) throw new Error(`order: ${result.status} ${result.text}`);
		return result.json;
	};

	const db = client.db(dbName);
	return {
		clock,
		portal,
		app,
		orders,
		handle,
		call,
		deliver,
		published,
		entitle,
		key,
		session,
		login,
		order,
		provider,
		sk,
		pk,
		db,
		/** Raw merchant collection. @param {string} name @returns {any} */
		collection: (name) => db.collection(`ss_orders_${name}`),
		/** The site of the main website. */
		site: async () => /** @type {any} */ (await orders.siteFor(WEBSITE)),
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};
