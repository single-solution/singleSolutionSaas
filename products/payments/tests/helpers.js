/**
 * Test harness: Payments on the kit, connected to the kit's fake Portal (`@ss/app-kit/testing`), with one website, its
 * two tokens, dashboard sessions, a merchant database on the run's MongoDB (`TEST_MONGODB_URI`), a fake Notifications
 * (its `POST /v1/events`), a fake S3 bucket and fake gateways: every gateway call is answered in process (no real
 * network call is ever made).
 * @module
 */
import { createFakePortal, createMemoryStore, createNetwork } from '@ss/app-kit/testing';
import { createProductInstance, manifest } from '../adapters/product.js';
import { createRoutes } from '../server/routes.js';

export const BASE = 'https://payments.example.dev';
export const NOTIFY_BASE = 'https://notifications.example.dev';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = `https://${DOMAIN}`;
export const ADMIN_ORIGIN = 'https://admin.shop.example.com';
export const BUCKET = 'https://bucket.example.org';
const SECRET = 'connect-secret-0123456789-abcdefghij';
const ENCRYPTION_KEY = 'encryption-key-0123456789-abcdefghij';

/** Every feature. */
export const ALL = manifest.features.map((feature) => feature.key);

/** Gateway hosts the fakes answer. */
const GATEWAY_ORIGINS = Object.freeze([
	'https://api.stripe.com',
	'https://api-m.paypal.com',
	'https://api-m.sandbox.paypal.com',
	'https://www.payfast.co.za',
	'https://sandbox.payfast.co.za',
	'https://api.payfast.co.za',
	'https://easypay.easypaisa.com.pk',
	'https://easypaystg.easypaisa.com.pk',
	'https://ipg1.apps.net.pk',
	'https://ipguat.apps.net.pk',
	'https://api.rapidgateway.pk',
	'https://sandbox.api.rapidgateway.pk',
	'https://gateway.example.org',
	BUCKET,
	NOTIFY_BASE,
]);

/** @typedef {{ origin: string, method: string, url: string, path: string, headers: Record<string, string>, body: string }} GatewayCall */
/** @typedef {(call: GatewayCall) => { status: number, body?: string | object, headers?: Record<string, string> } | undefined} Responder */

let databases = 0;

/** A fresh merchant database URI on the shared MongoDB. */
const merchantDatabase = () => {
	databases += 1;
	const url = new URL(/** @type {string} */ (process.env.TEST_MONGODB_URI));
	url.pathname = `/pay_${process.pid}_${Date.now()}_${databases}`;
	return url.toString();
};

/**
 * Fake gateways: each call is recorded; a responder per origin answers (else 200 `{}`).
 */
export const createFakeGateways = () => {
	/** @type {GatewayCall[]} */
	const calls = [];
	/** @type {Map<string, Responder>} */
	const responders = new Map();
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = {};
	for (const origin of GATEWAY_ORIGINS)
		handlers[origin] = async (request) => {
			const url = new URL(request.url);
			/** @type {GatewayCall} */
			const call = {
				origin,
				method: request.method,
				url: request.url,
				path: `${url.pathname}${url.search}`,
				headers: Object.fromEntries(request.headers.entries()),
				body: Buffer.from(await request.arrayBuffer()).toString('utf8'),
			};
			calls.push(call);
			/** @type {{ status: number, body?: string | object, headers?: Record<string, string> }} */
			const answer = responders.get(origin)?.(call) ?? { status: 200, body: {} };
			const body = typeof answer.body === 'string' || answer.body === undefined ? answer.body : JSON.stringify(answer.body);
			return new Response(body ?? null, { status: answer.status, headers: answer.headers ?? {} });
		};
	return {
		handlers,
		calls,
		/** @param {string} origin @param {Responder} responder */
		respond: (origin, responder) => void responders.set(origin, responder),
		/** @param {string} origin */
		callsTo: (origin) => calls.filter((call) => call.origin === origin),
		clear: () => {
			calls.length = 0;
			responders.clear();
		},
	};
};

/**
 * A connected product with one website.
 * @param {{ start?: number }} [options]
 */
export const setup = async ({ start = Date.parse('2026-10-01T10:00:00Z') } = {}) => {
	let t = start;
	const now = () => t;
	const portal = await createFakePortal({ now });
	const gateways = createFakeGateways();
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = { [portal.url]: portal.handle, ...gateways.handlers };
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
	portal.addProduct({ productId: 'notifications', baseUrl: NOTIFY_BASE });
	const websiteId = portal.addWebsite({ domain: DOMAIN });
	const browser = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'browser' })).token;
	const server = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'server' })).token;
	const notificationsToken = (await portal.issueToken({ websiteId, productId: 'notifications', kind: 'server' })).token;

	const flush = async () => {
		while (tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
	};

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string, body?: unknown, form?: Record<string, string> | string, cookie?: string,
	 *   headers?: Record<string, string> }} [init]
	 */
	const call = async (method, path, { token, origin, body, form, cookie, headers = {} } = {}) => {
		const raw = form === undefined ? undefined : typeof form === 'string' ? form : new URLSearchParams(form).toString();
		const response = await handler(
			new Request(path.startsWith('http') ? path : `${BASE}${path}`, {
				method,
				headers: {
					...(token ? { authorization: `Bearer ${token}` } : {}),
					...(origin ? { origin } : {}),
					...(cookie ? { cookie } : {}),
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(raw === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
					...headers,
				},
				...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
				...(raw === undefined ? {} : { body: raw }),
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

	/** @param {string} feature @param {string} name @param {unknown} value */
	const setting = async (feature, name, value) => {
		const response = await dashboard(
			await adminSession(),
			'PUT',
			`/v1/dashboard/websites/${websiteId}/settings/${feature}.${name}`,
			{ value },
		);
		if (response.status !== 204) throw new Error(`setting: ${response.status} ${response.text}`);
	};

	/** Server-token call. @param {string} method @param {string} path @param {unknown} [body] @param {Record<string, string>} [headers] */
	const api = (method, path, body, headers) => call(method, path, { token: server, body, ...(headers ? { headers } : {}) });

	/** A ticket for the admin widgets. @param {string[]} [permissions] */
	const ticket = async (
		permissions = ['payments.read', 'payments.refund', 'payments.confirm', 'subscriptions.read', 'subscriptions.cancel'],
	) => {
		const response = await call('POST', '/v1/tickets', {
			token: server,
			body: { user: { id: 'u_1', name: 'Sam Staff', email: 'sam@example.com' }, permissions, origin: ADMIN_ORIGIN },
		});
		return /** @type {{ ticket: string }} */ (response.json).ticket;
	};

	return {
		portal,
		product,
		gateways,
		websiteId,
		browser,
		server,
		notificationsToken,
		call,
		api,
		dashboard,
		adminSession,
		switchOn,
		connect,
		setting,
		ticket,
		connectDatabase: () => connect('database', merchantDatabase()),
		flush,
		now,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
	};
};
