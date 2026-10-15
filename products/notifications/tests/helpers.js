/**
 * Test harness: Notifications on the kit, connected to the kit's fake Portal (`@ss/app-kit/testing`), with one
 * website, its two tokens, dashboard sessions, a merchant database on the run's MongoDB (`TEST_MONGODB_URI`), the
 * website's business.json (404 until a test serves one) and fake providers: every provider call is answered in process
 * (no real network call is ever made). Every answer `call()` sees is checked against `schemas/api.json` and the kit's
 * own routes: a test fails when an answer does not fit its description.
 * @module
 */
import { createECDH } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { apiChecker, createFakePortal, createMemoryStore, createNetwork } from '@ss/app-kit/testing';
import apiJson from '../schemas/api.json' with { type: 'json' };
import { createProductInstance, manifest } from '../adapters/product.js';
import { createRoutes } from '../server/routes.js';

/** The API description every answer is checked against. */
const API = apiChecker(apiJson);

export const BASE = 'https://notifications.example.dev';
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

/** The other products the test Portal's directory lists from the start. */
export const OTHER_PRODUCTS = Object.freeze(['accounts', 'chat', 'ecommerce', 'growth', 'payments']);

/**
 * A connected product with one website.
 * @param {{ start?: number }} [options]
 */
export const setup = async ({ start = Date.parse('2026-10-01T10:00:00Z') } = {}) => {
	let t = start;
	const now = () => t;
	const portal = await createFakePortal({ now });
	const providers = createFakeProviders();
	/** The website's business.json, while a test serves one. @type {unknown} */
	let business = null;
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = {
		[portal.url]: portal.handle,
		...providers.handlers,
		[ORIGIN]: async (request) =>
			new URL(request.url).pathname === '/.well-known/business.json' && business !== null
				? new Response(JSON.stringify(business), { headers: { 'content-type': 'application/json' } })
				: new Response('not found', { status: 404 }),
	};
	const network = createNetwork(handlers);
	/** @type {Array<{ options: any, mail: any }>} */
	const mails = [];
	/** Product database reads that fail while a test says so (`<collection>|<id>` prefixes). @type {Set<string>} */
	const failing = new Set();
	const memory = createMemoryStore({ now });
	/** @type {import('@ss/app-kit').Store} */
	const store = Object.freeze({
		...memory,
		get: async (collection, id) => {
			if ([...failing].some((prefix) => `${collection}|${id}`.startsWith(prefix)))
				throw new Error('The database is briefly unreachable.');
			return memory.get(collection, id);
		},
	});
	const product = createProductInstance({
		config: { mongodbUri: '', connectSecret: SECRET, encryptionKey: ENCRYPTION_KEY },
		store,
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
	/** The address of the website's merchant database, once connected. */
	let databaseUri = '';
	const handler = product.handler(createRoutes(product), { after: (task) => tasks.push(task) });
	handlers[BASE] = handler;
	await portal.connect({ handler, baseUrl: BASE, secret: SECRET });
	// the other products connected to this Portal: their template keys are theirs (a product made later is added by
	// the test that needs it)
	for (const productId of OTHER_PRODUCTS) portal.addProduct({ productId, baseUrl: `https://${productId}.example.dev` });
	const websiteId = portal.addWebsite({ domain: DOMAIN });
	const browser = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'browser' })).token;
	const server = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'server' })).token;

	/**
	 * A request, then the work after it (`after: false` leaves that work queued for `flush()`).
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string, body?: unknown, raw?: string, type?: string, cookie?: string,
	 *   headers?: Record<string, string>, after?: boolean }} [init]
	 */
	const call = async (method, path, { token, origin, body, raw, type, cookie, headers = {}, after = true } = {}) => {
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
		while (after && tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
		const text = await response.clone().text();
		/** @type {unknown} */
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		API.assert({ method, path, status: response.status, body: json });
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
		/** The in-process network's origins: a test may add one (for example another product). */
		handlers,
		/** The product database store (the kit's collections). */
		store,
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
		connectDatabase: () => {
			databaseUri = merchantDatabase();
			return connect('database', databaseUri);
		},
		/**
		 * A collection of the website's merchant database, as Notifications keeps it (every field; the kit's tenant guard).
		 * @param {string} name `messages`, `webhook_events` …
		 */
		merchantCollection: async (name) => (await product.data.forWebsite(websiteId)).collection(name),
		/**
		 * The indexes of a collection of the merchant database, as MongoDB lists them.
		 * @param {string} name `messages`, `webhook_events` …
		 */
		merchantIndexes: async (name) => {
			const client = await MongoClient.connect(databaseUri);
			try {
				return await client.db().collection(`ss_notifications_${name}`).indexes();
			} finally {
				await client.close();
			}
		},
		/**
		 * Serve the website's business.json (null: 404) and read it again, as the dashboard's Refresh does.
		 * @param {unknown} value
		 */
		businessJson: async (value) => {
			business = value;
			const response = await dashboard(await adminSession(), 'POST', `/v1/dashboard/websites/${websiteId}/business/refresh`);
			if (response.status !== 200) throw new Error(`business: ${response.status} ${await response.text()}`);
		},
		/**
		 * Make reads of the product database fail (a brief outage), by `<collection>|<id>` prefix; none: they work again.
		 * @param {string} [prefix]
		 */
		failReads: (prefix) => (prefix === undefined ? failing.clear() : void failing.add(prefix)),
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
