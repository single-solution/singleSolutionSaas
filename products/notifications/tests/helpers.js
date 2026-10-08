/**
 * Test harness: Notifications on the kit, connected to the kit's fake Portal (`@ss/app-kit/testing`), with one
 * website, its two tokens, dashboard sessions, a merchant database on the run's MongoDB (`TEST_MONGODB_URI`) and fake
 * providers: every provider call is answered in process (no real network call is ever made).
 * @module
 */
import { createECDH } from 'node:crypto';
import { createFakePortal, createMemoryStore, createNetwork } from '@ss/app-kit/testing';
import { createProductInstance, manifest } from '../adapters/product.js';
import { createRoutes } from '../api/routes.js';

const BASE = 'https://notifications.example.dev';
const DOMAIN = 'shop.example.com';
export const ORIGIN = `https://${DOMAIN}`;
export const ADMIN_ORIGIN = 'https://admin.shop.example.com';
export const PUSH_ORIGIN = 'https://push.example.net';
export const HOOK_URL = 'https://hooks.example.org/ss';
export const GATEWAY_URL = 'https://gateway.example.org/send';
const SECRET = 'connect-secret-0123456789-abcdefghij';
const ENCRYPTION_KEY = 'encryption-key-0123456789-abcdefghij';

let databases = 0;

/** A fresh merchant database URI on the shared MongoDB. */
const merchantDatabase = () => {
	databases += 1;
	const url = new URL(/** @type {string} */ (process.env.TEST_MONGODB_URI));
	url.pathname = `/notif_${process.pid}_${Date.now()}_${databases}`;
	return url.toString();
};

/** @typedef {{ origin: string, method: string, url: string, headers: Record<string, string>, body: string }} ProviderCall */
/** @typedef {(call: ProviderCall) => { status: number, body?: string, headers?: Record<string, string> }} Responder */

/** Provider origins the fakes answer. */
const PROVIDER_ORIGINS = Object.freeze([
	'https://api.resend.com',
	'https://api.sendgrid.com',
	'https://api.mailgun.net',
	'https://api.eu.mailgun.net',
	'https://email.eu-west-1.amazonaws.com',
	'https://api.twilio.com',
	'https://graph.facebook.com',
	'https://gateway.example.org',
	PUSH_ORIGIN,
	'https://hooks.example.org',
]);

/**
 * Fake providers: each origin records its calls and answers 200 `{ id }` unless told otherwise.
 */
const createFakeProviders = () => {
	/** @type {ProviderCall[]} */
	const calls = [];
	/** @type {Map<string, Responder>} */
	const responders = new Map();
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = {};
	for (const origin of PROVIDER_ORIGINS)
		handlers[origin] = async (request) => {
			/** @type {ProviderCall} */
			const call = {
				origin,
				method: request.method,
				url: request.url,
				headers: Object.fromEntries(request.headers.entries()),
				body: Buffer.from(await request.arrayBuffer()).toString(origin === PUSH_ORIGIN ? 'base64' : 'utf8'),
			};
			calls.push(call);
			/** @type {Responder} */
			const fallback = () => ({ status: 200, body: JSON.stringify({ id: `id-${calls.length}` }) });
			const answer = (responders.get(origin) ?? fallback)(call);
			return new Response(answer.body ?? null, { status: answer.status, headers: answer.headers ?? {} });
		};
	return {
		handlers,
		calls,
		/** @param {string} origin @param {Responder} responder */
		respond: (origin, responder) => void responders.set(origin, responder),
		/** @param {string} origin */
		reset: (origin) => void responders.delete(origin),
		/** @param {string} origin */
		callsTo: (origin) => calls.filter((call) => call.origin === origin),
		clear: () => {
			calls.length = 0;
			responders.clear();
		},
	};
};

/** A browser's push subscription (P-256 keys the test keeps to decrypt what was pushed). */
export const browserSubscription = (endpoint = `${PUSH_ORIGIN}/push/abc`) => {
	const ecdh = createECDH('prime256v1');
	ecdh.generateKeys();
	const auth = Buffer.alloc(16, 7);
	return {
		ecdh,
		auth,
		subscription: {
			endpoint,
			keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
		},
	};
};

/** The merchant's push keys (VAPID). */
export const pushKeys = () => {
	const ecdh = createECDH('prime256v1');
	ecdh.generateKeys();
	return {
		publicKey: ecdh.getPublicKey().toString('base64url'),
		privateKey: ecdh.getPrivateKey().toString('base64url'),
		subject: 'mailto:ops@shop.example.com',
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
	const providers = createFakeProviders();
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = { [portal.url]: portal.handle, ...providers.handlers };
	const network = createNetwork(handlers);
	/** @type {Array<{ options: any, mail: any }>} */
	const mails = [];
	const product = createProductInstance({
		config: { mongodbUri: '', connectSecret: SECRET, encryptionKey: ENCRYPTION_KEY },
		store: createMemoryStore({ now }),
		fetch: portal.fetch,
		now,
		nodeEnv: 'test',
		outbound: { allowHosts: ['127.0.0.1', 'localhost'] },
		outboundSend: network.send,
		createTransport: (options) => ({
			sendMail: async (mail) => {
				mails.push({ options, mail });
				return { messageId: `<m${mails.length}@smtp>`, accepted: [mail.to], rejected: [] };
			},
			verify: async () => true,
		}),
	});
	/** @type {Array<() => Promise<unknown>>} */
	const tasks = [];
	const handler = product.handler(createRoutes(product), { after: (task) => tasks.push(task) });
	handlers[BASE] = handler;
	await portal.connect({ handler, baseUrl: BASE, secret: SECRET });
	const websiteId = portal.addWebsite({ domain: DOMAIN });
	const browser = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'browser' })).token;
	const server = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'server' })).token;

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string, body?: unknown, raw?: string, type?: string, cookie?: string,
	 *   headers?: Record<string, string> }} [init]
	 */
	const call = async (method, path, { token, origin, body, raw, type, cookie, headers = {} } = {}) => {
		const response = await handler(
			new Request(`${BASE}${path}`, {
				method,
				headers: {
					...(token ? { authorization: `Bearer ${token}` } : {}),
					...(origin ? { origin } : {}),
					...(cookie ? { cookie } : {}),
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...(raw === undefined ? {} : { 'content-type': type ?? 'application/x-www-form-urlencoded' }),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				...(raw === undefined ? {} : { body: raw }),
			}),
		);
		while (tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
		return response;
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
		if (response.status !== 200) throw new Error(`features: ${response.status} ${await response.text()}`);
	};

	/**
	 * Save a connection (Connections screen; tested live when saved).
	 * @param {string} name @param {unknown} value
	 */
	const connect = async (name, value) => {
		const response = await dashboard(await adminSession(), 'PUT', `/v1/dashboard/websites/${websiteId}/connections/${name}`, {
			value,
		});
		const json = await response.json();
		if (response.status !== 200) throw new Error(`connection ${name}: ${response.status} ${JSON.stringify(json)}`);
		return json;
	};

	/** @param {string} feature @param {string} setting @param {unknown} value */
	const setting = async (feature, setting, value) => {
		const response = await dashboard(
			await adminSession(),
			'PUT',
			`/v1/dashboard/websites/${websiteId}/settings/${feature}.${setting}`,
			{ value },
		);
		if (response.status !== 204) throw new Error(`setting: ${response.status} ${await response.text()}`);
	};

	/** Save a template in the dashboard. @param {Record<string, unknown>} template */
	const template = async (template) => {
		const response = await dashboard(await adminSession(), 'PUT', `/v1/dashboard/websites/${websiteId}/templates`, template);
		if (response.status !== 200) throw new Error(`template: ${response.status} ${await response.text()}`);
	};

	/** Send through the send API (server token). @param {string} channel @param {unknown} body @param {Record<string, string>} [headers] */
	const send = async (channel, body, headers) => {
		const response = await call('POST', `/v1/messages/${channel}`, { token: server, body, ...(headers ? { headers } : {}) });
		return { status: response.status, json: await response.json() };
	};

	/** A ticket for the admin widgets. @param {string[]} [permissions] */
	const ticket = async (permissions = ['log.read', 'templates.edit', 'messages.send', 'push.subscribe']) => {
		const response = await call('POST', '/v1/tickets', {
			token: server,
			body: { user: { id: 'u_1', name: 'Sam Staff', email: 'sam@example.com' }, permissions, origin: ADMIN_ORIGIN },
		});
		return /** @type {{ ticket: string }} */ (await response.json()).ticket;
	};

	return {
		portal,
		product,
		providers,
		mails,
		websiteId,
		browser,
		server,
		call,
		dashboard,
		adminSession,
		switchOn,
		connect,
		setting,
		template,
		send,
		ticket,
		connectDatabase: () => connect('database', merchantDatabase()),
		/** Run the work queued after responses (for example after a notice). */
		flush: async () => {
			while (tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
		},
		now,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
	};
};
