import { manifest as manifestFixture } from '@ss/contracts/testing';
import { MongoClient } from 'mongodb';
import { createProduct, defineRoute } from '../src/index.js';
import { createAccountsDouble, createFakePortal, createMemoryStore, createNetwork } from '../src/testing.js';

export const T0 = Date.parse('2026-10-01T10:00:00Z');
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
		feature: 'notes',
		database: false,
		handler: (ctx) => ({ kind: ctx.token.kind }),
	}),
	defineRoute({ method: 'GET', path: '/v1/server/open', auth: 'server', database: false, handler: () => ({ open: true }) }),
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
 *   nodeEnv?: string, routes?: any[] }} [options]
 */
export const setup = async (options = {}) => {
	const clock = createClock();
	const { logger, entries } = createTestLogger();
	const portal = await createFakePortal({ now: clock.now });
	const accounts = createAccountsDouble({ now: clock.now });
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = { [portal.url]: portal.handle, [accounts.url]: accounts.handle };
	const network = createNetwork(handlers);
	const store = options.store ?? createMemoryStore({ now: clock.now });
	const product = createProduct({
		manifest: manifest(),
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
	const browser = await portal.issueToken({ websiteId, productId: 'notes', kind: 'browser' });
	const server = await portal.issueToken({ websiteId, productId: 'notes', kind: 'server' });

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string | null, body?: unknown, headers?: Record<string, string>, cookie?: string }} [init]
	 */
	const call = async (method, path, { token, origin, body, headers = {}, cookie } = {}) =>
		handler(
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
