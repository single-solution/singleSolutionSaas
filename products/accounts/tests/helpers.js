/**
 * Test harness: Accounts on the kit, connected to the kit's fake Portal (`@ss/app-kit/testing`), with one website, its
 * two tokens, dashboard sessions, a merchant database on the run's MongoDB (`TEST_MONGODB_URI`) and fakes for every
 * outside service: Notifications (records what Accounts sends), other products (permissions, data rights, orders),
 * Google, Apple, Facebook and the breached-password list. No real network call is ever made.
 * @module
 */
import { generateKeyPairSync } from 'node:crypto';
import { createFakePortal, createMemoryStore, createNetwork } from '@ss/app-kit/testing';
import { createProductInstance, manifest } from '../adapters/product.js';
import { createRoutes } from '../api/routes.js';

const BASE = 'https://accounts.example.dev';
const DOMAIN = 'shop.example.com';
export const ORIGIN = `https://${DOMAIN}`;
export const ADMIN_ORIGIN = 'https://admin.shop.example.com';
export const NOTIFY = 'https://notifications.example.dev';
export const SHOP = 'https://ecommerce.example.dev';
export const CHAT = 'https://chat.example.dev';
const SECRET = 'connect-secret-0123456789-abcdefghij';
const ENCRYPTION_KEY = 'encryption-key-0123456789-abcdefghij';
export const ALL = manifest.features.map((feature) => feature.key);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';

let databases = 0;
/** A fresh merchant database URI on the shared MongoDB. */
const merchantDatabase = () => {
	databases += 1;
	const url = new URL(/** @type {string} */ (process.env.TEST_MONGODB_URI));
	url.pathname = `/acc_${process.pid}_${Date.now()}_${databases}`;
	return url.toString();
};

/** @typedef {{ method: string, url: string, headers: Record<string, string>, body: string }} Call */

/** An Apple .p8 key (P-256) for tests. */
export const appleKey = () => {
	const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	return {
		servicesId: 'com.shop.signin',
		teamId: 'TEAM123456',
		keyId: 'KEY1234567',
		privateKey: /** @type {string} */ (privateKey.export({ format: 'pem', type: 'pkcs8' })),
	};
};

/** An unsigned JWT with claims (the providers' ID tokens come straight from their token endpoints). @param {Record<string, unknown>} claims */
export const idToken = (claims) =>
	`${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

/**
 * A connected product with one website.
 * @param {{ start?: number }} [options]
 */
export const setup = async ({ start = Date.parse('2026-10-01T10:00:00Z') } = {}) => {
	let t = start;
	const now = () => t;
	const portal = await createFakePortal({ now });
	/** @type {Call[]} */
	const calls = [];
	/** @type {Map<string, (call: Call) => { status: number, body?: unknown }>} */
	const responders = new Map();
	/** @param {string} origin */
	const fake = (origin) => async (/** @type {Request} */ request) => {
		/** @type {Call} */
		const call = {
			method: request.method,
			url: request.url,
			headers: Object.fromEntries(request.headers.entries()),
			body: await request.text(),
		};
		calls.push(call);
		const path = new URL(request.url).pathname;
		const responder = responders.get(`${origin}${path}`) ?? responders.get(origin);
		const answer = responder ? responder(call) : { status: 200, body: {} };
		return new Response(
			answer.body === undefined ? null : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
			{
				status: answer.status,
				headers: { 'content-type': 'application/json' },
			},
		);
	};
	const origins = [
		NOTIFY,
		SHOP,
		CHAT,
		'https://oauth2.googleapis.com',
		'https://appleid.apple.com',
		'https://graph.facebook.com',
		'https://api.pwnedpasswords.com',
	];
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = { [portal.url]: portal.handle, ...Object.fromEntries(origins.map((origin) => [origin, fake(origin)])) };
	// Notifications sends; the products answer data rights and permissions
	responders.set(NOTIFY, (call) =>
		new URL(call.url).pathname.startsWith('/v1/messages/')
			? { status: 201, body: { id: `msg_${calls.length}`, status: 'sent' } }
			: { status: 200, body: {} },
	);
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
	for (const [productId, baseUrl] of /** @type {const} */ ([
		['notifications', NOTIFY],
		['ecommerce', SHOP],
		['chat', CHAT],
	]))
		portal.addProduct({ productId, baseUrl });
	const browser = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'browser' })).token;
	const server = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'server' })).token;

	let requests = 0;
	/** @type {string | null} */
	let pinnedNetwork = null;

	const flush = async () => {
		while (tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
	};

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string, body?: unknown, raw?: string, cookie?: string, signIn?: string,
	 *   headers?: Record<string, string> }} [init]
	 */
	const call = async (method, path, { token, origin, body, raw, cookie, signIn, headers = {} } = {}) => {
		requests += 1;
		const response = await handler(
			new Request(`${BASE}${path}`, {
				method,
				headers: {
					'user-agent': UA,
					// each request from its own network, unless a test pins one (the rate limits count per network)
					'x-forwarded-for': pinnedNetwork ?? `203.0.113.${requests % 250}, 10.0.0.${requests % 250}`,
					...(token ? { authorization: `Bearer ${token}` } : {}),
					...(origin ? { origin } : {}),
					...(cookie ? { cookie } : {}),
					...(signIn ? { 'ss-sign-in': signIn } : {}),
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(raw === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				...(raw === undefined ? {} : { body: raw }),
			}),
		);
		await flush();
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

	/** A visitor request (browser token from the website's domain). @param {string} method @param {string} path @param {unknown} [body] @param {string} [signIn] */
	const visitor = (method, path, body, signIn) =>
		call(method, path, {
			token: browser,
			origin: ORIGIN,
			...(body === undefined ? {} : { body }),
			...(signIn ? { signIn } : {}),
		});

	/** A server-token request. @param {string} method @param {string} path @param {unknown} [body] */
	const serverCall = (method, path, body) => call(method, path, { token: server, ...(body === undefined ? {} : { body }) });

	/** An admin's dashboard session (Owner by default); returns the cookie. @param {'owner' | 'support'} [role] */
	const adminSession = async (role = 'owner') => {
		const launch = await portal.issueLaunch({ productId: manifest.id, kind: 'admin', role, websiteId });
		const response = await call('GET', `/sso?launch=${launch}`);
		return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
	};

	/** A merchant's dashboard session. */
	const merchantSession = async () => {
		const launch = await portal.issueLaunch({ productId: manifest.id, kind: 'merchant', websiteId });
		const response = await call('GET', `/sso?launch=${launch}`);
		return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
	};

	/** @param {string} cookie @param {string} method @param {string} path @param {unknown} [body] */
	const dashboard = (cookie, method, path, body) =>
		call(method, path, { cookie, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { origin: BASE }) });

	/** Switch features on (admin Features screen → feature report to the Portal). @param {string[]} on */
	const switchOn = async (on) => {
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

	/** Paste another product's server token. @param {string} productId */
	const paste = async (productId) =>
		connect(productId, (await portal.issueToken({ websiteId, productId, kind: 'server' })).token);

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
		if (response.status !== 204) throw new Error(`setting: ${response.status} ${response.text}`);
	};

	/** A ticket for the admin widgets. @param {string[]} [permissions] */
	const ticket = async (permissions = ['users.read', 'users.manage', 'roles.manage']) => {
		const response = await serverCall('POST', '/v1/tickets', {
			user: { id: 'usr_staff', name: 'Sam Staff', email: 'sam@example.com' },
			permissions,
			origin: ADMIN_ORIGIN,
		});
		return /** @type {string} */ (response.json.ticket);
	};

	/** An admin widget request. @param {string} ticketValue @param {string} method @param {string} path @param {unknown} [body] */
	const admin = (ticketValue, method, path, body) =>
		call(method, path, { token: ticketValue, origin: ADMIN_ORIGIN, ...(body === undefined ? {} : { body }) });

	/** Messages Accounts sent through Notifications. */
	const messages = () =>
		calls
			.filter((c) => c.url.startsWith(`${NOTIFY}/v1/messages/`))
			.map((c) => ({ channel: c.url.split('/').pop(), authorization: c.headers.authorization, ...JSON.parse(c.body) }));

	return {
		portal,
		product,
		calls,
		responders,
		websiteId,
		browser,
		server,
		call,
		visitor,
		serverCall,
		dashboard,
		adminSession,
		merchantSession,
		switchOn,
		connect,
		paste,
		setting,
		ticket,
		admin,
		messages,
		flush,
		connectDatabase: () => connect('database', merchantDatabase()),
		/** Pin the network of the next requests (null: a new one each request). @param {string | null} value */
		setNetwork: (value) => {
			pinnedNetwork = value;
		},
		now,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
	};
};
