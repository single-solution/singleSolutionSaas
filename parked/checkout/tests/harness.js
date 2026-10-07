/**
 * API test harness: the real product (app-kit `createRequestHandler` over this product's routes) against app-kit's fake
 * Portal, with the merchant database on the test run's MongoMemoryReplSet (`TEST_MONGODB_URI`). The merchant's other
 * products (Coupons, Deals, Loyalty, Catalog), their storage bucket and gateway are mocked behind app-kit's
 * `outboundSend` (every outbound call of the product goes through it).
 */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createRequestHandler, noopLogger } from '@ss/app-kit';
import { createFakePortal } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { generateSigningKey } from '@ss/protocol';
import { createPlatform } from '../adapters/platform.js';
import { buildRoutes, createApplication, wireEvents } from '../api/routes.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PORTAL_URL = 'https://portal.test';
export const APP_ID = 'app_0123456789abcdefghjkmnpq';
export const MERCHANT = 'mer_0123456789abcdefghjkmnpq';
export const WEBSITE = 'web_0123456789abcdefghjkmnpq';
export const WEBSITE_2 = 'web_1123456789abcdefghjkmnpq';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = Object.freeze({ origin: `https://${DOMAIN}` });
export const T0 = Date.parse('2026-10-01T10:00:00Z');
export const HOUR = 3_600_000;
export const ELEMENTS = [
	'cart',
	'checkout_form',
	'place_order',
	'payment_manual',
	'payment_proofs',
	'payment_gateway',
	'offer_apply',
	'loyalty_redeem',
	'success_page',
	'policies_notice',
	'signin_gate',
];
export const URLS = Object.freeze({
	coupons: 'https://coupons.test',
	deals: 'https://deals.test',
	loyalty: 'https://loyalty.test',
	catalog: 'https://catalog.test',
});
/** Settings with every product connected and the manual methods on. */
export const CONNECTED = Object.freeze({
	offer_apply: { coupons_url: URLS.coupons, deals_url: URLS.deals, max_codes: 2 },
	loyalty_redeem: { loyalty_url: URLS.loyalty },
	cart: { catalog_url: URLS.catalog },
	place_order: { orders_per_hour: 1000 },
	payment_manual: {
		bank_transfer_enabled: true,
		cod_enabled: true,
		pickup_pay_enabled: true,
		bank_details: [{ label: 'IBAN', value: 'XX00 0000' }],
	},
	checkout_form: {
		delivery_methods: [
			{ key: 'standard', kind: 'ship', fee: 500, free_over: 10_000, requires_address: true, countries: [] },
			{ key: 'pickup', kind: 'pickup', fee: 0, free_over: 0, requires_address: false, countries: [] },
		],
	},
});

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

/** MongoDB URI of a fresh database on the shared replica set. */
export const mongoUri = (/** @type {string} */ name) => {
	const base = process.env.TEST_MONGODB_URI;
	if (!base) throw new Error('TEST_MONGODB_URI is not set (run through this product vitest config)');
	const url = new URL(base);
	url.pathname = `/${name}`;
	return url.toString();
};

/**
 * Mock of the outside world: handlers by `METHOD host/path` prefix; every call is recorded.
 */
export const createRemote = () => {
	/** @type {Array<{ method: string, url: string, headers: Record<string, string>, body: any }>} */
	const calls = [];
	/** @type {Array<{ match: string, reply: (call: any) => any }>} */
	const routes = [];
	return {
		calls,
		/** @param {string} match e.g. `POST https://coupons.test/v1/quotes` @param {(call: any) => any} reply */
		on: (match, reply) => {
			routes.unshift({ match, reply });
		},
		reset: () => {
			calls.length = 0;
			routes.length = 0;
		},
		/** @param {string} url @param {Record<string, any>} [init] */
		send: async (url, init = {}) => {
			const method = String(init.method ?? 'GET').toUpperCase();
			const text = typeof init.body === 'string' ? init.body : init.body ? Buffer.from(init.body).toString('utf8') : '';
			let body = null;
			try {
				body = text ? JSON.parse(text) : null;
			} catch {
				body = text;
			}
			const call = { method, url, headers: init.headers ?? {}, body };
			calls.push(call);
			const key = `${method} ${url}`;
			const route = routes.find((r) => (r.match.endsWith('$') ? key === r.match.slice(0, -1) : key.startsWith(r.match)));
			if (!route) throw Object.assign(new Error(`no mock for ${method} ${url}`), { code: 'network' });
			const answer = await route.reply(call);
			return {
				status: answer.status,
				headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) },
				body: Buffer.from(
					answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
				),
				url,
			};
		},
	};
};

/**
 * @param {{ config?: Record<string, any>, elements?: Record<string, boolean>, env?: Record<string, string>, website?: Record<string, string> }} [options]
 */
export const createHarness = async ({ config = {}, elements = {}, env = {}, website = { currency: 'EUR' } } = {}) => {
	const clock = createClock();
	const remote = createRemote();
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'checkout-test-1' });
	portal.trustProductKey(publicJwk);
	const dbName = `checkout_${nodeRandomBytes(5).toString('hex')}`;
	const uri = mongoUri(dbName);
	const client = await new MongoClient(uri).connect();
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
			outboundSend: remote.send,
		},
	});
	const application = wireEvents(createApplication(app));
	const handle = createRequestHandler(application.product, buildRoutes(application));

	let version = 0;
	/**
	 * Publish the entitlement of a website (all elements on by default); every call is a newer document version.
	 * @param {{ websiteId?: string, config?: Record<string, any>, elements?: Record<string, boolean>, identity?: any, website?: Record<string, string> }} [input]
	 */
	const entitle = async ({
		websiteId = WEBSITE,
		config: overrides = {},
		elements: switches = {},
		identity,
		website: site = website,
	} = {}) => {
		const merged = { ...config, ...overrides };
		const flags = { ...elements, ...switches };
		await portal.setEntitlement({
			websiteId,
			merchantId: MERCHANT,
			productSlug: 'checkout',
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
			...(site ? { website: site } : {}),
			...(identity ? { identity } : {}),
		});
		await application.product.entitlements.refresh(websiteId);
	};
	const DAY = 24 * HOUR;
	portal.setResource(WEBSITE, 'database', { uri, dbName }, DAY);
	portal.setResource(WEBSITE_2, 'database', { uri, dbName }, DAY);
	portal.setResource(
		WEBSITE,
		'storage',
		{
			provider: 's3',
			bucket: 'proofs',
			region: 'eu-west-1',
			accessKeyId: 'AKIDEXAMPLE',
			secretAccessKey: 'secret-example-key',
			endpoint: 'https://storage.test',
		},
		DAY,
	);
	portal.setResource(
		WEBSITE,
		'payments',
		{ provider: 'test', credentials: { mode: 'action', webhookSecret: 'whsec_test_0123456789' } },
		DAY,
	);
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
			new Request(`https://checkout.example.com${path}`, {
				method,
				headers: {
					...(body === undefined && raw === undefined ? {} : { 'content-type': 'application/json' }),
					...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
					...(bearer?.startsWith('pk_') ? ORIGIN : {}),
					...(method === 'POST' && idempotencyKey !== null ? { 'idempotency-key': idempotencyKey ?? createId('idk') } : {}),
					...headers,
				},
				...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const type = response.headers.get('content-type') ?? '';
		const text = await response.text();
		return {
			status: response.status,
			headers: response.headers,
			text,
			json: text && type.includes('json') ? JSON.parse(text) : null,
		};
	};

	/**
	 * Deliver an event as the Event Hub would (signed POST /.well-known/ss-events).
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
			new Request('https://checkout.example.com/.well-known/ss-events', {
				method: 'POST',
				headers: signed.headers,
				body: signed.body,
			}),
		);
		return { status: response.status, id };
	};

	/**
	 * Put an item through the API (one variant per entry).
	 * @param {string} itemId
	 * @param {Record<string, any>} [body]
	 */
	const item = async (itemId, body = {}) => {
		const result = await call('PUT', `/v1/items/${itemId}`, {
			body: {
				title: `Item ${itemId}`,
				currency: 'EUR',
				variants: [{ variantId: `${itemId}_v`, price: 2500, available: 5 }],
				...body,
			},
		});
		if (result.status !== 200) throw new Error(`item put failed: ${result.status} ${result.text}`);
		return result.json;
	};

	/**
	 * A cart with lines (pk by default).
	 * @param {Array<{ itemId: string, variantId?: string, quantity: number }>} lines
	 * @param {{ key?: string, headers?: Record<string, string> }} [as]
	 */
	const cartWith = async (lines, as = { key: pk }) => {
		const created = await call('POST', '/v1/carts', { body: {}, ...as });
		if (created.status !== 201) throw new Error(`cart create failed: ${created.status} ${created.text}`);
		for (const line of lines) {
			const added = await call('POST', `/v1/carts/${created.json.id}/lines`, { body: line, ...as });
			if (added.status !== 200) throw new Error(`cart add failed: ${added.status} ${added.text}`);
		}
		return /** @type {string} */ (created.json.id);
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
		remote,
		app,
		application,
		handle,
		call,
		deliver,
		item,
		cartWith,
		published,
		entitle,
		key,
		sk,
		pk,
		db,
		/** Raw merchant collection. @param {string} name */
		collection: (name) => db.collection(`ss_checkout_${name}`),
		close: async () => {
			await db.dropDatabase().catch(() => undefined);
			await client.close();
			await app.close();
		},
	};
};

/** The contact / delivery part of a placement body. @param {Record<string, unknown>} [extra] */
export const checkoutBody = (extra = {}) => ({
	contact: { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+441234567890' },
	address: { recipient_name: 'Ada Lovelace', line1: 'Main street 1', city: 'Metropolis' },
	deliveryMethod: 'standard',
	paymentMethod: 'bank_transfer',
	...extra,
});
