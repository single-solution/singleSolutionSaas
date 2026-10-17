/**
 * Test harness: Ecommerce on the kit, connected to the kit's fake Portal (`@ss/app-kit/testing`), with one website,
 * its two tokens, dashboard sessions, a merchant database on the run's MongoDB replica set (`TEST_MONGODB_URI`, so
 * transactions work), the kit's Accounts double (shopper sign-ins and public keys), and fakes for every other address:
 * Notifications, Payments, an S3 bucket, a courier API, an AI provider and the website itself (business.json). Every
 * call to them is recorded and answered in process (no real network call is ever made). `seedProduct` writes catalog
 * records straight into the merchant database in the shape of `core/model.js`, so each part can be tested on its own.
 * Every answer `call()` sees is checked against `schemas/api.json` and the kit's own routes: a test fails when an
 * answer does not fit its description (feeds, sitemaps, llms.txt and CSV files are text: only their status is checked).
 * @module
 */
import { createId } from '@ss/contracts';
import {
	apiChecker,
	createAccountsDouble,
	createFakePortal,
	createMemoryStore,
	createNetwork,
	staffCaller,
} from '@ss/app-kit/testing';
import apiJson from '../schemas/api.json' with { type: 'json' };
import { createProductInstance, manifest } from '../adapters/product.js';
import { createRoutes } from '../server/routes.js';
import { summarize } from '../core/catalog.js';
import { EMPTY_SEO } from '../core/catalog-content.js';
import { checkAttribute, checkBrand, checkCategory } from '../core/catalog-taxonomy.js';
import { COLLECTIONS } from '../core/model.js';
import { derivedFacts } from '../core/facts.js';

/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */
/** What a test may leave out of a variant. @typedef {'attributes' | 'media' | 'soldOut' | 'warrantyTime'} VariantExtras */

export const BASE = 'https://ecommerce.example.dev';
export const ACCOUNTS = 'https://accounts.example.dev';
export const NOTIFY = 'https://notifications.example.dev';
export const PAYMENTS = 'https://payments.example.dev';
export const STORAGE = 'https://bucket.example.org';
export const COURIER = 'https://courier.example.org';
export const AI = 'https://ai.example.org';
export const GROWTH = 'https://growth.example.dev';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = `https://${DOMAIN}`;
const ADMIN_ORIGIN = 'https://admin.shop.example.com';
const SECRET = 'connect-secret-0123456789-abcdefghij';
const ENCRYPTION_KEY = 'encryption-key-0123456789-abcdefghij';

/** The API description every answer is checked against. */
const API = apiChecker(apiJson);

/** Every feature. */
export const ALL = manifest.features.map((feature) => feature.key);
/** Every ticket permission. */
export const ALL_PERMISSIONS = (manifest.permissions ?? []).map((permission) => permission.key);

/**
 * Item types whose items number their units (dynamic model §1), for `shop.list('item_types', UNIT_TYPES)`: `numbered`
 * picks them from units in stock when packing; `typed` takes them typed at packing or later, needed before dispatch.
 * Neither names unit fields (plain serial numbers).
 */
export const UNIT_TYPES = Object.freeze([
	{
		key: 'numbered',
		name: 'Numbered item',
		kind: 'physical',
		elements: { variants: true, grades: true, chart: true, parcel: true, warranty: true, units: { capture: 'stock' } },
	},
	{
		key: 'typed',
		name: 'Typed item',
		kind: 'physical',
		elements: {
			variants: true,
			grades: true,
			chart: true,
			parcel: true,
			warranty: true,
			units: { capture: 'packing', requiredBefore: 'shipped' },
		},
	},
]);

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
 * The fields a record's check stores, from its name, or the check's problems as an error.
 * @param {{ ok: true, value: Record<string, any> } | { ok: false, errors: unknown[] }} checked
 */
const storedFields = (checked) => {
	if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
	return checked.value;
};

/**
 * A category as every write stores it (the fields of `checkCategory`, its place in the tree, image and earlier slugs),
 * with the given fields on top, for tests that put records straight into the database.
 * @param {{ id: string, name: string } & Record<string, unknown>} given
 */
export const storedCategory = (given) => ({
	...storedFields(checkCategory({ name: given.name }, null)),
	path: [],
	image: null,
	previousSlugs: [],
	...given,
});

/**
 * A brand as every write stores it (the fields of `checkBrand` and its logo), with the given fields on top.
 * @param {{ id: string, name: string } & Record<string, unknown>} given
 */
export const storedBrand = (given) => ({ ...storedFields(checkBrand({ name: given.name }, null)), logo: null, ...given });

/**
 * A unit as every write stores it (its values by unit field and its unique keys; a plain serial number has none), with
 * the given fields on top, for tests that put units straight into the database.
 * @param {{ id: string, serial: string } & Record<string, unknown>} given
 */
export const storedUnit = (given) => ({
	values: {},
	keys: [`num:${given.serial}`],
	orderId: null,
	lineId: null,
	locationId: null,
	...given,
});

/**
 * An order as every write stores it, for tests that put orders straight into the database: its payments log (what its
 * Payments payment took, as the confirmation writes it), an empty refunds log, no staff who opened it and its facts (as
 * an import writes them, from its flags), unless given.
 * @template {{ role: import('../core/model.js').StatusRole, stockHeld: boolean, lines: ReadonlyArray<{ serials?: string[] }>,
 *   payment: { paymentId?: string | null, paid: number }, placedAt?: Date }} T
 * @param {T} given
 */
export const storedOrder = (given) => ({
	payments:
		given.payment.paymentId && given.payment.paid > 0
			? [
					{
						id: createId('opy'),
						method: 'payments',
						amount: given.payment.paid,
						reference: given.payment.paymentId,
						proofKey: null,
						note: '',
						by: { kind: 'system', id: 'payments', name: 'Payments' },
						at: given.placedAt ?? new Date(0),
					},
				]
			: [],
	refunds: [],
	seenBy: [],
	facts: derivedFacts(given),
	...given,
});

/**
 * An attribute as every write stores it (the fields of `checkAttribute`), with the given fields on top.
 * @param {{ id: string, name: string, slug: string } & Record<string, unknown>} given
 */
export const storedAttribute = (given) => {
	const base = storedFields(checkAttribute({ name: given.name, ...(given.on ? { on: given.on } : {}) }, null));
	// the places given change where it shows; the others stay as a new field of its kind has them
	return { ...base, ...given, show: { ...base.show, .../** @type {object} */ (given.show ?? {}) } };
};

/**
 * A connected product with one website.
 * @param {{ start?: number, business?: Record<string, unknown>,
 *   store?: (store: import('@ss/app-kit').Store) => import('@ss/app-kit').Store }} [options] `business`: more fields of
 *   the website's business.json (its country …); `store` wraps the product database (a test can make a read fail)
 */
export const setup = async ({
	start = Date.parse('2026-10-05T10:00:00Z'),
	business = {},
	store = (/** @type {import('@ss/app-kit').Store} */ given) => given,
} = {}) => {
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
		// the Accounts double, except for paths a test answers itself (`responders`)
		[ACCOUNTS]: (/** @type {Request} */ request) =>
			responders.has(`${ACCOUNTS}${new URL(request.url).pathname}`) ? fake(ACCOUNTS)(request) : accounts.handle(request),
		...Object.fromEntries([NOTIFY, PAYMENTS, STORAGE, COURIER, AI, ORIGIN, GROWTH].map((origin) => [origin, fake(origin)])),
	};
	// Notifications queues every message, and refuses its reserved value names as the real one does (MS-2)
	responders.set(NOTIFY, (call) =>
		call.path.startsWith('/v1/messages/')
			? 'unsubscribeUrl' in (JSON.parse(call.body).values ?? {})
				? { status: 422, body: { type: 'https://errors.example/validation_failed' } }
				: { status: 201, body: { id: `msg_${calls.length}`, status: 'queued' } }
			: { status: 200, body: {} },
	);
	// Payments: a new payment is pending; verify says no until a test says otherwise (payments.paid); a canceled
	// payment is voided, unless it was paid (409 already_paid); money for a voided payment is flagged refundDue (P4)
	const paid = new Set();
	const voided = new Set();
	/** @type {Map<string, { amount: number, currency: string }>} */
	const amounts = new Map();
	/** @param {string} id */
	const paymentOf = (id) => ({
		id,
		status: paid.has(id) ? 'paid' : voided.has(id) ? 'voided' : 'pending',
		refundDue: paid.has(id) && voided.has(id),
		amount: amounts.get(id)?.amount ?? 0,
		currency: amounts.get(id)?.currency ?? 'USD',
		refunded: 0,
	});
	responders.set(PAYMENTS, (call) => {
		const path = call.path.split('?')[0] ?? '';
		if (call.method === 'POST' && path === '/v1/payments') {
			const body = JSON.parse(call.body);
			const id = `pay_${String(calls.length).padStart(12, '0')}`;
			amounts.set(id, { amount: body.amount, currency: body.currency });
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
					verified: paid.has(id) && !voided.has(id),
					payment: { id, status: paid.has(id) ? 'paid' : 'pending', amount: body.amount, refunded: 0 },
				},
			};
		}
		const cancel = /^\/v1\/payments\/([^/]+)\/cancel$/.exec(path);
		if (cancel) {
			const id = /** @type {string} */ (cancel[1]);
			if (paid.has(id))
				return {
					status: 409,
					type: 'application/problem+json',
					body: { type: 'https://errors.example/already_paid', status: 409, payment: paymentOf(id) },
				};
			voided.add(id);
			return { status: 200, body: paymentOf(id) };
		}
		const read = /^\/v1\/payments\/([^/]+)$/.exec(path);
		if (read && call.method === 'GET') return { status: 200, body: paymentOf(/** @type {string} */ (read[1])) };
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
		body: { version: 1, name: 'Shop', email: 'hello@shop.example.com', timeZone: 'UTC', ...business },
	}));
	const network = createNetwork(handlers);
	const product = createProductInstance({
		config: { mongodbUri: '', connectSecret: SECRET, encryptionKey: ENCRYPTION_KEY },
		store: store(createMemoryStore({ now })),
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
	portal.addProduct({ productId: 'growth', baseUrl: GROWTH });
	const browser = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'browser' })).token;
	const server = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'server' })).token;

	const flush = async () => {
		while (tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
	};

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string, body?: unknown, cookie?: string, headers?: Record<string, string>,
	 *   bare?: boolean, staff?: Record<string, any> }} [init] `bare`: the server token alone; `staff`: who is signed in (the
	 *   website's server with a staff Owner signed in otherwise)
	 */
	const call = async (method, path, { token, origin, body, cookie, headers = {}, bare = false, staff } = {}) => {
		if (token === server && !bare && headers['ss-sign-in'] === undefined && headers['ss-visitor-ip'] === undefined)
			// eslint-disable-next-line no-param-reassign -- the harness signs the staff member in
			headers = await staffHeaders({ headers, staff });
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
		// the bytes as sent (a CSV's byte order mark is in them; the decoded text, like `Response.text()`, leaves it out)
		const bytes = new Uint8Array(await response.arrayBuffer());
		const text = new TextDecoder().decode(bytes);
		await flush();
		/** @type {any} */
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		// a text answer (CSV, XML, plain text) has no JSON body to check: its status is checked, unless its route also
		// answers JSON (the reports with format=csv), whose description is of the JSON answer
		const isText = text !== '' && !/json/.test(response.headers.get('content-type') ?? '');
		const described = API.described(method, path);
		const entry = described ? /** @type {Record<string, { response?: unknown }>} */ (apiJson)[described] : undefined;
		if (!isText || entry?.response === undefined)
			API.assert({ method, path, status: response.status, body: isText ? null : json });
		return { status: response.status, headers: response.headers, json, text, bytes };
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

	// the website's Accounts token, pasted on first use: the keys of the staff's sign-ins
	const staffHeaders = staffCaller({ accounts, websiteId, paste: () => paste('accounts') });

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

	/** Save a website text (Settings → Texts). @param {string} key @param {string} value */
	const text = async (key, value) => {
		const response = await dashboard(await adminSession(), 'PUT', `/v1/dashboard/websites/${websiteId}/texts/${key}`, {
			value,
		});
		if (response.status !== 204) throw new Error(`text ${key}: ${response.status} ${response.text}`);
	};

	/** Save a list setting (order_flow, couriers, delivery_zones, tax_rules, grades, booking_schedules). @param {string} name @param {unknown} value */
	const list = async (name, value) => {
		const response = await dashboard(await adminSession(), 'PUT', `/v1/dashboard/websites/${websiteId}/lists/${name}`, {
			value,
		});
		if (response.status !== 200) throw new Error(`list ${name}: ${response.status} ${response.text}`);
		return response.json.value;
	};

	/**
	 * Change payment methods of the saved list (or of today's four, E2): each key's method gets its patch merged in;
	 * `order` (keys) puts them in that order first. @param {Record<string, Record<string, unknown>>} patches
	 * @param {string[]} [order]
	 */
	const methods = async (patches, order = []) => {
		const read = await dashboard(await adminSession(), 'GET', `/v1/dashboard/websites/${websiteId}/lists/payment_methods`);
		/** @type {any[]} */
		const saved = read.json.value.map((/** @type {any} */ method) => ({ ...method, ...(patches[method.key] ?? {}) }));
		const rank = (/** @type {any} */ method) => (order.includes(method.key) ? order.indexOf(method.key) : order.length);
		return list(
			'payment_methods',
			[...saved].sort((x, y) => rank(x) - rank(y)),
		);
	};

	/**
	 * Change the saved order flow (its options, triggers, starts …): `change` gets a copy of the flow as it reads and
	 * returns the flow to save. @param {(flow: any) => any} change
	 */
	const flow = async (change) => {
		const read = await dashboard(await adminSession(), 'GET', `/v1/dashboard/websites/${websiteId}/lists/order_flow`);
		return list('order_flow', change(structuredClone(read.json.value)));
	};

	/**
	 * Set options of one move of the saved order flow (`{}` puts its options back to their defaults).
	 * @param {string} from @param {string} to @param {Record<string, unknown>} options
	 * @param {Record<string, unknown>} [rest] more fields of the move (who, needs, permission)
	 */
	const moveOptions = (from, to, options, rest = {}) =>
		flow((value) => ({
			...value,
			moves: value.moves.map((/** @type {any} */ move) =>
				move.from === from && move.to === to
					? { from, to, ...(Object.keys(options).length > 0 ? { options: { ...move.options, ...options } } : {}), ...rest }
					: move,
			),
		}));

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
		const response = await call('POST', '/v1/tickets', {
			token: server,
			staff: user,
			body: { permissions, origin: ADMIN_ORIGIN },
		});
		if (response.status !== 201 && response.status !== 200) throw new Error(`ticket: ${response.status} ${response.text}`);
		return /** @type {string} */ (response.json.ticket);
	};

	/** An admin widget request. @param {string} ticketValue @param {string} method @param {string} path @param {unknown} [body] */
	const admin = (ticketValue, method, path, body) =>
		call(method, path, { token: ticketValue, origin: ADMIN_ORIGIN, ...(body === undefined ? {} : { body }) });

	/** The website's guarded merchant database (connect it first). */
	const db = () => product.data.forWebsite(websiteId);

	/**
	 * Write an active product straight into the merchant database in the whole shape every write stores
	 * (`core/model.js`). One variant unless `variants` is given; `stock` and `price` fill the single variant, and a
	 * variant given without its attributes, photos, sold-out mark or warranty gets none.
	 * @param {Omit<Partial<import('../core/model.js').ProductRecord>, 'variants'> & { stock?: number, sku?: string,
	 *   variants?: Array<Omit<VariantRecord, VariantExtras> & Partial<Pick<VariantRecord, VariantExtras>>> }} [input]
	 * @returns {Promise<import('../core/model.js').ProductRecord>}
	 */
	const seedProduct = async (input = {}) => {
		const id = input.id ?? createId('prd');
		const { stock = 10, sku = '', variants: given, ...rest } = input;
		/** @type {VariantRecord[]} */
		const variants = (
			given ?? [
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
			]
		).map((variant) => ({ attributes: {}, media: [], soldOut: false, warrantyTime: null, ...variant }));
		const active = variants.filter((variant) => variant.active);
		const { stockState, grades, priceMax } = summarize(variants, rest.trackStock ?? true);
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
			typeKey: null,
			digital: null,
			booking: null,
			seo: { ...EMPTY_SEO },
			sold: 0,
			ordered: 0,
			rating: { average: 0, count: 0 },
			publishedAt: new Date(t),
			contentUpdatedAt: new Date(t),
			createdAt: new Date(t),
			updatedAt: new Date(t),
			returnTime: null,
			warrantyTime: null,
			featured: false,
			stockState,
			grades,
			priceMax,
			descriptionHtml: '',
			video: null,
			sizeChartId: null,
			hideSizeGuide: false,
			attributeSetup: [],
			faqs: [],
			previousSlugs: [],
			replacedBy: null,
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
		staffHeaders,
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
		methods,
		list,
		flow,
		moveOptions,
		ticket,
		signIn,
		db,
		seedProduct,
		text,
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
 * @param {{ start?: number, features?: string[], business?: Record<string, unknown> }} [options]
 */
export const readyShop = async ({ start, features = ALL, business } = {}) => {
	const shop = await setup({ ...(start === undefined ? {} : { start }), ...(business ? { business } : {}) });
	await shop.switchOn(features);
	await shop.connectDatabase();
	await shop.connectStorage();
	for (const productId of ['accounts', 'payments', 'notifications']) await shop.paste(productId);
	return shop;
};
