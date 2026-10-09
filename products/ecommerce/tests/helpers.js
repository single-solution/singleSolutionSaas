/**
 * Test harness: Ecommerce on the kit, connected to the kit's fake Portal (`@ss/app-kit/testing`), with one website,
 * its two tokens, dashboard sessions, a merchant database on the run's MongoDB replica set (`TEST_MONGODB_URI`, so
 * transactions work), the kit's Accounts double (shopper sign-ins and public keys), and fakes for every other address:
 * Notifications, Payments, an S3 bucket, a courier API, an AI provider and the website itself (business.json). Every
 * call to them is recorded and answered in process (no real network call is ever made). `seedProduct` writes catalog
 * records straight into the merchant database in the shape of `core/model.js`, so each part can be tested on its own.
 * @module
 */
import { createId } from '@ss/contracts';
import { createAccountsDouble, createFakePortal, createMemoryStore, createNetwork } from '@ss/app-kit/testing';
import { createProductInstance, manifest } from '../adapters/product.js';
import { createRoutes } from '../server/routes.js';
import { COLLECTIONS } from '../core/model.js';

const BASE = 'https://ecommerce.example.dev';
const ACCOUNTS = 'https://accounts.example.dev';
const NOTIFY = 'https://notifications.example.dev';
export const PAYMENTS = 'https://payments.example.dev';
export const STORAGE = 'https://bucket.example.org';
export const COURIER = 'https://courier.example.org';
export const AI = 'https://ai.example.org';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = `https://${DOMAIN}`;
const ADMIN_ORIGIN = 'https://admin.shop.example.com';
const SECRET = 'connect-secret-0123456789-abcdefghij';
const ENCRYPTION_KEY = 'encryption-key-0123456789-abcdefghij';

/** Every feature. */
export const ALL = manifest.features.map((feature) => feature.key);
/** Every ticket permission. */
export const ALL_PERMISSIONS = (manifest.permissions ?? []).map((permission) => permission.key);

/** @typedef {{ method: string, url: string, path: string, headers: Record<string, string>, body: string }} Call */
/** @typedef {(call: Call) => { status: number, body?: unknown, type?: string, headers?: Record<string, string> }} Responder */

let databases = 0;

/** A fresh merchant database URI on the shared MongoDB. */
const merchantDatabase = () => {
	databases += 1;
	const url = new URL(/** @type {string} */ (process.env.TEST_MONGODB_URI));
	url.pathname = `/shop_${process.pid}_${Date.now()}_${databases}`;
	return url.toString();
};

/**
 * A connected product with one website.
 * @param {{ start?: number }} [options]
 */
export const setup = async ({ start = Date.parse('2026-10-05T10:00:00Z') } = {}) => {
	let t = start;
	const now = () => t;
	const portal = await createFakePortal({ now });
	const accounts = createAccountsDouble({ url: ACCOUNTS, now });
	/** @type {Call[]} */
	const calls = [];
	/** Responders by `<origin><path>` (exact) or `<origin>` (any path). @type {Map<string, Responder>} */
	const responders = new Map();
	/** @param {string} origin */
	const fake = (origin) => async (/** @type {Request} */ request) => {
		const url = new URL(request.url);
		/** @type {Call} */
		const call = {
			method: request.method,
			url: request.url,
			path: `${url.pathname}${url.search}`,
			headers: Object.fromEntries(request.headers.entries()),
			body: await request.text(),
		};
		calls.push(call);
		const responder = responders.get(`${origin}${url.pathname}`) ?? responders.get(origin);
		const answer = responder ? responder(call) : { status: 200, body: {} };
		return new Response(
			answer.body === undefined ? null : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
			{ status: answer.status, headers: { 'content-type': answer.type ?? 'application/json', ...(answer.headers ?? {}) } },
		);
	};
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = {
		[portal.url]: portal.handle,
		[ACCOUNTS]: accounts.handle,
		...Object.fromEntries([NOTIFY, PAYMENTS, STORAGE, COURIER, AI, ORIGIN].map((origin) => [origin, fake(origin)])),
	};
	// Notifications queues every message
	responders.set(NOTIFY, (call) =>
		call.path.startsWith('/v1/messages/')
			? { status: 201, body: { id: `msg_${calls.length}`, status: 'queued' } }
			: { status: 200, body: {} },
	);
	// Payments: a new payment is pending; verify says no until a test says otherwise (payments.paid)
	const paid = new Set();
	responders.set(PAYMENTS, (call) => {
		const path = call.path.split('?')[0] ?? '';
		if (call.method === 'POST' && path === '/v1/payments') {
			const body = JSON.parse(call.body);
			const id = `pay_${String(calls.length).padStart(12, '0')}`;
			return {
				status: 201,
				body: { id, status: 'pending', amount: body.amount, currency: body.currency, checkoutUrl: `${PAYMENTS}/pay/w/${id}` },
			};
		}
		const verify = /^\/v1\/payments\/([^/]+)\/verify$/.exec(path);
		if (verify) {
			const body = JSON.parse(call.body);
			const id = /** @type {string} */ (verify[1]);
			return {
				status: 200,
				body: {
					verified: paid.has(id),
					payment: { id, status: paid.has(id) ? 'paid' : 'pending', amount: body.amount, refunded: 0 },
				},
			};
		}
		const refund = /^\/v1\/payments\/([^/]+)\/refunds$/.exec(path);
		if (refund) {
			const body = JSON.parse(call.body);
			return {
				status: 201,
				body: {
					id: refund[1],
					status: 'partially_refunded',
					refunds: [{ id: `rfd_${refund[1]}_1`, amount: body.amount, manual: false }],
				},
			};
		}
		return { status: 404, body: { code: 'not_found' } };
	});
	responders.set(`${ORIGIN}/.well-known/business.json`, () => ({
		status: 200,
		body: { version: 1, name: 'Shop', email: 'hello@shop.example.com', timeZone: 'UTC' },
	}));
	const network = createNetwork(handlers);
	const product = createProductInstance({
		config: { mongodbUri: '', connectSecret: SECRET, encryptionKey: ENCRYPTION_KEY },
		store: createMemoryStore({ now }),
		fetch: portal.fetch,
		now,
		nodeEnv: 'test',
		outbound: { allowHosts: ['127.0.0.1', 'localhost'] },
		outboundSend: network.send,
	});
	/** @type {Array<() => Promise<unknown>>} */
	const tasks = [];
	const handler = product.handler(createRoutes(product), { after: (task) => tasks.push(task) });
	handlers[BASE] = handler;
	await portal.connect({ handler, baseUrl: BASE, secret: SECRET });
	const websiteId = portal.addWebsite({ domain: DOMAIN });
	portal.addProduct({ productId: 'notifications', baseUrl: NOTIFY });
	portal.addProduct({ productId: 'accounts', baseUrl: ACCOUNTS });
	portal.addProduct({ productId: 'payments', baseUrl: PAYMENTS });
	const browser = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'browser' })).token;
	const server = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'server' })).token;

	const flush = async () => {
		while (tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
	};

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string, body?: unknown, cookie?: string, headers?: Record<string, string> }} [init]
	 */
	const call = async (method, path, { token, origin, body, cookie, headers = {} } = {}) => {
		const response = await handler(
			new Request(path.startsWith('http') ? path : `${BASE}${path}`, {
				method,
				headers: {
					...(token ? { authorization: `Bearer ${token}` } : {}),
					...(origin ? { origin } : {}),
					...(cookie ? { cookie } : {}),
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...headers,
				},
				...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		await flush();
		/** @type {any} */
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		return { status: response.status, headers: response.headers, json, text };
	};

	/** An admin's dashboard session (Owner by default); returns the cookie. @param {'owner' | 'support'} [role] */
	const adminSession = async (role = 'owner') => {
		const launch = await portal.issueLaunch({ productId: manifest.id, kind: 'admin', role, websiteId });
		const response = await call('GET', `/sso?launch=${launch}`);
		return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
	};

	/** @param {string} cookie @param {string} method @param {string} path @param {unknown} [body] */
	const dashboard = (cookie, method, path, body) =>
		call(method, path, { cookie, body, ...(method === 'GET' ? {} : { origin: BASE }) });

	/** Switch features on (admin Features screen → feature report to the Portal). @param {string[]} [on] default: all */
	const switchOn = async (on = ALL) => {
		const response = await dashboard(await adminSession(), 'PUT', `/v1/dashboard/websites/${websiteId}/features`, { on });
		if (response.status !== 200) throw new Error(`features: ${response.status} ${response.text}`);
	};

	/** Save a connection (tested live when saved). @param {string} name @param {unknown} value */
	const connect = async (name, value) => {
		const response = await dashboard(await adminSession(), 'PUT', `/v1/dashboard/websites/${websiteId}/connections/${name}`, {
			value,
		});
		if (response.status !== 200) throw new Error(`connection ${name}: ${response.status} ${response.text}`);
		return response.json;
	};

	/** Paste another product's server token (accounts, payments, notifications). @param {string} productId */
	const paste = async (productId) =>
		connect(productId, (await portal.issueToken({ websiteId, productId, kind: 'server' })).token);

	/** Connect the fake bucket. */
	const connectStorage = () =>
		connect('storage', {
			endpoint: STORAGE,
			region: 'auto',
			bucket: 'shop',
			accessKeyId: 'AKIAEXAMPLE',
			secretAccessKey: 'secret-access-key-0123456789',
		});

	/** @param {string} feature @param {string} name @param {unknown} value */
	const setting = async (feature, name, value) => {
		const response = await dashboard(
			await adminSession(),
			'PUT',
			`/v1/dashboard/websites/${websiteId}/settings/${feature}.${name}`,
			{
				value,
			},
		);
		if (response.status !== 204) throw new Error(`setting ${feature}.${name}: ${response.status} ${response.text}`);
	};

	/** Save a list setting (order_flow, couriers, delivery_zones, tax_rules, grades, booking_hours). @param {string} name @param {unknown} value */
	const list = async (name, value) => {
		const response = await dashboard(await adminSession(), 'PUT', `/v1/dashboard/websites/${websiteId}/lists/${name}`, {
			value,
		});
		if (response.status !== 200) throw new Error(`list ${name}: ${response.status} ${response.text}`);
		return response.json.value;
	};

	/** Server-token call. @param {string} method @param {string} path @param {unknown} [body] @param {Record<string, string>} [headers] */
	const api = (method, path, body, headers) => call(method, path, { token: server, body, ...(headers ? { headers } : {}) });

	/**
	 * A shopper's Accounts sign-in (the double signs it like Accounts does).
	 * @param {{ id?: string, name?: string, email?: string, phone?: string }} [user]
	 */
	const signIn = async ({
		id = 'usr_shopper0000001',
		name = 'Sara Shopper',
		email = 'sara@example.com',
		phone = '+15550001111',
	} = {}) => accounts.signIn({ websiteId, sub: id, name, email, email_verified: true, phone, phone_verified: true });

	/**
	 * A visitor request with the browser token from the website's origin, signed in when `signIn` is given.
	 * @param {string} method @param {string} path
	 * @param {{ body?: unknown, signIn?: string, key?: string, origin?: string }} [init] `key`: Idempotency-Key
	 */
	const visitor = (method, path, { body, signIn: token, key, origin = ORIGIN } = {}) =>
		call(method, path, {
			token: browser,
			origin,
			body,
			headers: { ...(token ? { 'ss-sign-in': token } : {}), ...(key ? { 'idempotency-key': key } : {}) },
		});

	/** A ticket for the admin widgets. @param {string[]} [permissions] @param {{ id: string, name: string, email: string }} [user] */
	const ticket = async (
		permissions = ALL_PERMISSIONS,
		user = { id: 'usr_staff0000001', name: 'Sam Staff', email: 'sam@shop.example.com' },
	) => {
		const response = await api('POST', '/v1/tickets', { user, permissions, origin: ADMIN_ORIGIN });
		if (response.status !== 201 && response.status !== 200) throw new Error(`ticket: ${response.status} ${response.text}`);
		return /** @type {string} */ (response.json.ticket);
	};

	/** An admin widget request. @param {string} ticketValue @param {string} method @param {string} path @param {unknown} [body] */
	const admin = (ticketValue, method, path, body) =>
		call(method, path, { token: ticketValue, origin: ADMIN_ORIGIN, ...(body === undefined ? {} : { body }) });

	/** The website's guarded merchant database (connect it first). */
	const db = () => product.data.forWebsite(websiteId);

	/**
	 * Write an active product straight into the merchant database (`core/model.js` shape). One variant unless `variants`
	 * is given; `stock` and `price` fill the single variant.
	 * @param {Partial<import('../core/model.js').ProductRecord> & { stock?: number, sku?: string }} [input]
	 * @returns {Promise<import('../core/model.js').ProductRecord>}
	 */
	const seedProduct = async (input = {}) => {
		const id = input.id ?? createId('prd');
		const { stock = 10, sku = '', ...rest } = input;
		const variants = input.variants ?? [
			{
				id: createId('var'),
				sku,
				options: {},
				price: input.price ?? 1000,
				compareAtPrice: null,
				cost: null,
				stock,
				locations: {},
				grade: null,
				active: true,
			},
		];
		const active = variants.filter((variant) => variant.active);
		/** @type {import('../core/model.js').ProductRecord} */
		const record = {
			slug: `product-${id.slice(4, 12)}`,
			name: 'Phone',
			kind: 'physical',
			status: 'active',
			summary: '',
			description: '',
			categoryIds: [],
			brandId: null,
			tags: [],
			media: [],
			specs: {},
			options: [],
			trackStock: true,
			serialized: false,
			digital: null,
			booking: null,
			seo: { title: '', description: '' },
			sold: 0,
			rating: { average: 0, count: 0 },
			publishedAt: new Date(t),
			createdAt: new Date(t),
			updatedAt: new Date(t),
			returnDays: null,
			warrantyDays: null,
			...rest,
			id,
			variants,
			price: active.length > 0 ? Math.min(...active.map((variant) => variant.price)) : 0,
			inStock: active.some((variant) => !(rest.trackStock ?? true) || variant.stock > 0),
		};
		await (await db()).collection(COLLECTIONS.products).insertOne({ ...record });
		return record;
	};

	/** Messages sent through Notifications. */
	const messages = () =>
		calls
			.filter((c) => c.url.startsWith(`${NOTIFY}/v1/messages/`))
			.map((c) => ({ channel: c.url.split('/').pop(), authorization: c.headers.authorization, ...JSON.parse(c.body) }));

	/** @param {string} origin */
	const callsTo = (origin) => calls.filter((c) => c.url.startsWith(origin));

	return {
		portal,
		accounts,
		product,
		calls,
		callsTo,
		responders,
		messages,
		websiteId,
		browser,
		server,
		call,
		api,
		visitor,
		admin,
		dashboard,
		adminSession,
		switchOn,
		connect,
		paste,
		connectStorage,
		connectDatabase: () => connect('database', merchantDatabase()),
		setting,
		list,
		ticket,
		signIn,
		db,
		seedProduct,
		/** Mark a fake payment paid (Payments' verify then answers verified). @param {string} id */
		payPayment: (id) => void paid.add(id),
		flush,
		now,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
	};
};

/**
 * A ready shop: every feature on, the merchant database, storage, and the Accounts, Payments and Notifications
 * tokens connected.
 * @param {{ start?: number, features?: string[] }} [options]
 */
export const readyShop = async ({ start, features = ALL } = {}) => {
	const shop = await setup(start === undefined ? {} : { start });
	await shop.switchOn(features);
	await shop.connectDatabase();
	await shop.connectStorage();
	for (const productId of ['accounts', 'payments', 'notifications']) await shop.paste(productId);
	return shop;
};
