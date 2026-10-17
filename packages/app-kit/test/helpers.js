import { manifest as manifestFixture } from '@ss/contracts/testing';
import { MongoClient } from 'mongodb';
import { createProduct, defineRoute } from '../src/index.js';
import { apiChecker, createAccountsDouble, createFakePortal, createMemoryStore, createNetwork } from '../src/testing.js';

export const T0 = Date.parse('2026-10-01T10:00:00Z');
/** The kit's own routes as kit-api.json describes them: every answer of `call()` is checked against it. */
const KIT_API = apiChecker({});
export const BASE = 'https://notes.example.dev';
export const DOMAIN = 'shop.example.com';
export const SECRET = 'connect-secret-0123456789-abcdefghij';
export const ENCRYPTION_KEY = 'encryption-key-0123456789-abcdefghij';
const STRINGS = Object.freeze({
	'form.title': 'Leave a note',
	'form.count': 'You left {count} notes, {name}',
	'inbox.empty': 'No notes',
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

/** Logger that records entries. */
export const createTestLogger = () => {
	/** @type {Array<{ level: string, msg: string, fields?: Record<string, unknown> }>} */
	const entries = [];
	/** @param {string} level */
	const at = (level) => (/** @type {string} */ msg, /** @type {Record<string, unknown>} */ fields) => {
		entries.push({ level, msg, ...(fields ? { fields } : {}) });
	};
	/** @type {any} */
	const logger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
	logger.child = () => logger;
	return { logger, entries };
};

/** @returns {any} the sample manifest (product `notes`) */
export const manifest = () => manifestFixture();

/** A test database URI on the shared MongoDB (`TEST_MONGODB_URI`). @param {string} name */
export const mongoUri = (name) => {
	const url = new URL(/** @type {string} */ (process.env.TEST_MONGODB_URI));
	url.pathname = `/${name}`;
	return url.toString();
};

let databases = 0;
/** A fresh database name per call. @param {string} prefix */
export const freshDb = (prefix) => {
	databases += 1;
	return `${prefix}_${process.pid}_${databases}`;
};

/** Routes of the sample product. */
export const productRoutes = () => [
	defineRoute({ method: 'GET', path: '/docs', auth: 'none', handler: () => ({ docs: true }) }),
	defineRoute({
		method: 'GET',
		path: '/widget.js',
		auth: 'none',
		handler: () => new Response('/* widgets */', { headers: { 'content-type': 'text/javascript' } }),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/notes',
		auth: 'browser',
		feature: 'notes',
		database: false,
		handler: (ctx) => ({ websiteId: ctx.websiteId }),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/notes',
		auth: 'browser',
		feature: 'notes',
		idempotent: true,
		rateLimit: [
			{ limit: 3, windowSeconds: 60 },
			{ limit: 5, windowSeconds: 60, per: 'visitor' },
		],
		handler: async (ctx) => {
			const db = await ctx.data();
			await db.collection('notes').insertOne({ text: String(/** @type {any} */ (ctx.body)?.text ?? '') });
			return { saved: true };
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/server/notes',
		auth: 'server',
		runtime: true,
		feature: 'notes',
		database: false,
		handler: (ctx) => ({ kind: ctx.token.kind }),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/server/open',
		auth: 'server',
		runtime: true,
		database: false,
		handler: () => ({ open: true }),
	}),
	// a staff route: the server token and the sign-in of a staff member whose role grants notes.read
	defineRoute({
		method: 'GET',
		path: '/v1/inbox/open',
		auth: 'server',
		permission: 'notes.read',
		database: false,
		handler: (ctx) => ({ actor: ctx.actor }),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/inbox',
		auth: 'ticket',
		permission: 'notes.read',
		handler: (ctx) => ({ user: ctx.ticket.user }),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/raw',
		auth: 'none',
		rawBody: true,
		maxBodyBytes: 10,
		handler: (ctx) => ({ raw: ctx.rawBody }),
	}),
	defineRoute({ method: 'POST', path: '/v1/echo', auth: 'none', handler: (ctx) => ({ body: ctx.body }) }),
	defineRoute({
		method: 'GET',
		path: '/v1/fail',
		auth: 'none',
		handler: () => {
			throw new Error('boom');
		},
	}),
];

/**
 * A connected product with one website, its tokens and helpers.
 * @param {{ store?: any, connections?: Record<string, any>, hooks?: any, strings?: Record<string, string>, connect?: boolean,
 *   nodeEnv?: string, routes?: any[], manifest?: any, lists?: Record<string, any>, events?: boolean, imports?: any,
 *   sharedSettings?: Record<string, any>, data?: any, messages?: unknown, openapi?: unknown, build?: Record<string, string>,
 *   logger?: any }} [options] `logger`: replaces the recording logger (its `entries` stay empty)
 */
export const setup = async (options = {}) => {
	const clock = createClock();
	const recording = createTestLogger();
	const { entries } = recording;
	const logger = options.logger ?? recording.logger;
	const portal = await createFakePortal({ now: clock.now });
	const accounts = createAccountsDouble({ now: clock.now });
	const notifications = createNotificationsDouble();
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = { [portal.url]: portal.handle, [accounts.url]: accounts.handle, [notifications.url]: notifications.handle };
	const network = createNetwork(handlers);
	const store = options.store ?? createMemoryStore({ now: clock.now });
	const product = createProduct({
		manifest: options.manifest ?? manifest(),
		strings: options.strings ?? { ...STRINGS },
		config: { mongodbUri: '', connectSecret: SECRET, encryptionKey: ENCRYPTION_KEY },
		store,
		fetch: portal.fetch,
		now: clock.now,
		logger,
		nodeEnv: options.nodeEnv ?? 'test',
		outbound: { allowHosts: ['127.0.0.1', 'localhost'] },
		outboundSend: network.send,
		...(options.connections ? { connections: options.connections } : {}),
		...(options.hooks ? { hooks: options.hooks } : {}),
		...(options.lists ? { lists: options.lists } : {}),
		...(options.sharedSettings ? { sharedSettings: options.sharedSettings } : {}),
		...(options.events ? { events: true } : {}),
		...(options.imports ? { imports: options.imports } : {}),
		...(options.data ? { data: options.data } : {}),
		...(options.messages ? { messages: options.messages } : {}),
		...(options.openapi ? { openapi: options.openapi } : {}),
		...(options.build ? { build: options.build } : {}),
	});
	/** @type {Array<() => Promise<unknown>>} */
	const tasks = [];
	const handler = product.handler(options.routes ?? productRoutes(), { after: (task) => tasks.push(task) });
	handlers[BASE] = handler;
	const settle = async () => {
		while (tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
	};
	if (options.connect !== false) await portal.connect({ handler, baseUrl: BASE, secret: SECRET });
	const websiteId = portal.addWebsite({ domain: DOMAIN });
	portal.addProduct({ productId: 'accounts', baseUrl: accounts.url });
	portal.addProduct({ productId: 'notifications', baseUrl: notifications.url });
	const browser = await portal.issueToken({ websiteId, productId: 'notes', kind: 'browser' });
	const server = await portal.issueToken({ websiteId, productId: 'notes', kind: 'server' });

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string | null, body?: unknown, headers?: Record<string, string>, cookie?: string,
	 *   bare?: boolean, staff?: Record<string, any> }} [init] `bare`: the server token alone; `staff`: who is signed in
	 */
	const call = async (method, path, { token, origin, body, headers = {}, cookie, bare = false, staff } = {}) => {
		// the website's server with a staff member signed in (an Owner unless `staff` says who); `bare: true` sends the
		// server token alone
		if (token === server.token && !bare && headers['ss-sign-in'] === undefined && headers['ss-visitor-ip'] === undefined)
			headers = await staffHeaders({ headers, staff });
		const response = await handler(
			new Request(`${BASE}${path}`, {
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
		const json = method !== 'HEAD' && (response.headers.get('content-type') ?? '').startsWith('application/json');
		KIT_API.assert({ method, path, status: response.status, body: json ? await response.clone().json() : null });
		return response;
	};

	let accountsPasted = false;
	/**
	 * The headers of a staff member's call: the website's Accounts token is pasted on first use (the keys of the sign-ins).
	 * @param {{ headers?: Record<string, string>, staff?: Record<string, any> }} [input]
	 */
	const staffHeaders = async ({ headers = {}, staff } = {}) => {
		if (!accountsPasted) {
			accountsPasted = true;
			const token = (await portal.issueToken({ websiteId, productId: 'accounts', kind: 'server' })).token;
			const cookie = await session();
			const pasted = await dash(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/accounts`, { value: token });
			if (pasted.status !== 200) throw new Error(`accounts token failed: ${pasted.status} ${await pasted.text()}`);
		}
		return accounts.staffHeaders({ websiteId, headers, ...(staff ? { staff } : {}) });
	};

	/**
	 * Open the dashboard as a merchant or an admin; returns the session cookie.
	 * @param {{ kind?: 'merchant' | 'admin', role?: 'owner' | 'support', websiteId?: string | null }} [launch]
	 */
	const session = async ({ kind = 'admin', role = 'owner', websiteId: site = websiteId } = {}) => {
		const token = await portal.issueLaunch({ productId: 'notes', kind, role, websiteId: site });
		const response = await call('GET', `/sso?launch=${token}`);
		if (response.status !== 303) throw new Error(`sso failed: ${response.status} ${await response.text()}`);
		await settle();
		return /** @type {string} */ (/** @type {string} */ (response.headers.get('set-cookie')).split(';')[0]);
	};

	/**
	 * A dashboard call (writes carry the product's own Origin).
	 * @param {string} cookie
	 * @param {string} method
	 * @param {string} path
	 * @param {unknown} [body]
	 */
	const dash = (cookie, method, path, body) =>
		call(method, path, { cookie, body, ...(method === 'GET' ? {} : { origin: BASE }) });

	/** Switch features on through the admin Features screen. @param {string[]} on @param {string} [site] */
	const switchOn = async (on, site = websiteId) => {
		const cookie = await session({ websiteId: site });
		const response = await dash(cookie, 'PUT', `/v1/dashboard/websites/${site}/features`, { on });
		if (response.status !== 200) throw new Error(`features failed: ${response.status} ${await response.text()}`);
	};

	/** Connect a merchant database for the website (real MongoDB). @param {string} [site] */
	const connectDatabase = async (site = websiteId) => {
		const cookie = await session({ websiteId: site });
		const dbName = freshDb('merchant');
		const response = await dash(cookie, 'PUT', `/v1/dashboard/websites/${site}/connections/database`, {
			value: mongoUri(dbName),
		});
		if (response.status !== 200) throw new Error(`database failed: ${response.status} ${await response.text()}`);
		return dbName;
	};

	return {
		clock,
		portal,
		accounts,
		notifications,
		network,
		handlers,
		product,
		handler,
		settle,
		tasks,
		websiteId,
		browser,
		server,
		call,
		staffHeaders,
		session,
		dash,
		switchOn,
		connectDatabase,
		store,
		entries,
	};
};

/** Read a merchant database directly. @param {string} dbName */
export const openDb = async (dbName) => {
	const client = await new MongoClient(/** @type {string} */ (process.env.TEST_MONGODB_URI)).connect();
	return { client, db: client.db(dbName) };
};

/** @param {number} status @param {unknown} body */
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** @param {string} base @param {string} code @param {number} status */
const fail = (base, code, status) =>
	new Response(JSON.stringify({ type: `${base}/problems/${code}`, title: code, status }), {
		status,
		headers: { 'content-type': 'application/problem+json' },
	});

/**
 * Notifications as products see it (PLAN 0.3, 0.8.10 K5, K6): `POST /v1/events` (an event to the merchant's webhook
 * URLs; a repeated `Idempotency-Key` answers 409) and `POST /v1/messages/<channel>` (a template to a recipient). It
 * keeps what it was sent; `setFailing(true)` answers 503.
 * @param {{ url?: string }} [options]
 */
const createNotificationsDouble = ({ url = 'https://notifications.test' } = {}) => {
	/** @type {Array<{ token: string, key: string | null, body: any }>} */
	const events = [];
	/** @type {Array<{ token: string, channel: string, body: any }>} */
	const messages = [];
	const keys = new Set();
	let failing = false;

	/** @param {Request} request @returns {Promise<Response>} */
	const handle = async (request) => {
		const token = /^Bearer\s+(\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
		const path = new URL(request.url).pathname;
		if (request.method !== 'POST') return fail(url, 'not_found', 404);
		if (!token) return fail(url, 'invalid_token', 401);
		if (failing) return fail(url, 'unavailable', 503);
		const body = await request.json().catch(() => null);
		if (path === '/v1/events') {
			const key = request.headers.get('idempotency-key');
			if (key && keys.has(key)) return fail(url, 'duplicate_request', 409);
			if (key) keys.add(key);
			events.push({ token, key, body });
			return json(202, { queued: 1 });
		}
		const channel = /^\/v1\/messages\/([a-z-]+)$/.exec(path)?.[1];
		if (!channel) return fail(url, 'not_found', 404);
		messages.push({ token, channel, body });
		return json(202, { id: `msg_${messages.length}`, status: 'queued' });
	};

	return Object.freeze({
		url,
		handle,
		events,
		messages,
		/** @param {boolean} value answer 503 while true */
		setFailing: (value) => {
			failing = value;
		},
	});
};
