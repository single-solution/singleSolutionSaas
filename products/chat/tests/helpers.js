/**
 * Test harness: Chat on the kit, connected to the kit's fake Portal (`@ss/app-kit/testing`), with one website, its two
 * tokens, dashboard sessions, a merchant database on the run's MongoDB (`TEST_MONGODB_URI`) and fakes for every outside
 * service: the AI provider (OpenAI-compatible answers queued by the test), Notifications (records what Chat sends), the
 * Accounts double (sign-ins and public keys), S3 storage, the merchant's tool and booking endpoints, and the website
 * (business.json and pages). No real network call is ever made.
 * @module
 */
import { createAccountsDouble, createFakePortal, createMemoryStore, createNetwork } from '@ss/app-kit/testing';
import { createProductInstance, manifest } from '../adapters/product.js';
import { createRoutes } from '../api/routes.js';

export const BASE = 'https://chat.example.dev';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = `https://${DOMAIN}`;
export const ADMIN_ORIGIN = 'https://admin.shop.example.com';
export const NOTIFY = 'https://notifications.example.dev';
export const ACCOUNTS = 'https://accounts.example.dev';
export const AI = 'https://api.openai.com';
export const STORAGE = 'https://s3.example.dev';
export const TOOLS = 'https://tools.example.dev';
const SECRET = 'connect-secret-0123456789-abcdefghij';
const ENCRYPTION_KEY = 'encryption-key-0123456789-abcdefghij';
export const ALL = manifest.features.map((feature) => feature.key);
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
export const AI_KEY = { provider: 'openai', apiKey: 'sk-test-0123456789', model: 'gpt-4.1-mini' };
export const STORAGE_KEY = {
	endpoint: STORAGE,
	region: 'auto',
	bucket: 'chat',
	accessKeyId: 'AKIDTEST',
	secretAccessKey: 'secret-test-key-0123',
};

let databases = 0;
/** A fresh merchant database URI on the shared MongoDB. */
const merchantDatabase = () => {
	databases += 1;
	const url = new URL(/** @type {string} */ (process.env.TEST_MONGODB_URI));
	url.pathname = `/chat_${process.pid}_${Date.now()}_${databases}`;
	return url.toString();
};

/** @typedef {{ method: string, url: string, headers: Record<string, string>, body: string }} Call */
/**
 * An answer the fake AI gives: text, tool calls, or a failure status.
 * @typedef {{ text?: string, tools?: Array<{ name: string, arguments: Record<string, unknown> }>, status?: number, tokens?: number }} AiAnswer
 */

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
	/** @type {AiAnswer[]} */
	const aiAnswers = [];
	/** @type {Map<string, (call: Call) => { status: number, body?: unknown, type?: string }>} */
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
			{ status: answer.status, headers: { 'content-type': answer.type ?? 'application/json' } },
		);
	};
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = {
		[portal.url]: portal.handle,
		[ACCOUNTS]: accounts.handle,
		...Object.fromEntries([NOTIFY, AI, STORAGE, TOOLS, ORIGIN].map((origin) => [origin, fake(origin)])),
	};
	responders.set(NOTIFY, (call) =>
		new URL(call.url).pathname.startsWith('/v1/messages/')
			? { status: 201, body: { id: `msg_${calls.length}`, status: 'queued' } }
			: { status: 200, body: {} },
	);
	responders.set(`${ORIGIN}/.well-known/business.json`, () => ({
		status: 200,
		body: { version: 1, name: 'Shop', email: 'hello@shop.example.com', timeZone: 'UTC' },
	}));
	responders.set(AI, (call) => {
		if (call.method === 'GET') return { status: 200, body: { data: [] } };
		const next = aiAnswers.shift() ?? { text: 'Hello from the AI.' };
		if (next.status) return { status: next.status, body: { error: 'no' } };
		return {
			status: 200,
			body: {
				choices: [
					{
						message: {
							role: 'assistant',
							content: next.text ?? '',
							tool_calls: (next.tools ?? []).map((tool, i) => ({
								id: `call_${i}`,
								type: 'function',
								function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
							})),
						},
						finish_reason: next.tools ? 'tool_calls' : 'stop',
					},
				],
				usage: { prompt_tokens: next.tokens ?? 100, completion_tokens: 20 },
			},
		};
	});
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
	portal.addProduct({ productId: 'ecommerce', baseUrl: 'https://ecommerce.example.dev' });
	const browser = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'browser' })).token;
	const server = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'server' })).token;

	let requests = 0;
	const flush = async () => {
		while (tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
	};

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string, body?: unknown, cookie?: string, headers?: Record<string, string>, network?: string }} [init]
	 */
	const call = async (method, path, { token, origin, body, cookie, headers = {}, network: ip } = {}) => {
		requests += 1;
		const response = await handler(
			new Request(`${BASE}${path}`, {
				method,
				headers: {
					'user-agent': UA,
					'x-forwarded-for': ip ?? `203.0.113.${requests % 250}`,
					...(token ? { authorization: `Bearer ${token}` } : {}),
					...(origin ? { origin } : {}),
					...(cookie ? { cookie } : {}),
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

	/**
	 * A visitor: the browser token from the website's domain, with a guest key and/or a sign-in it keeps.
	 * @param {{ guestKey?: string | null, signIn?: string | null, network?: string }} [init]
	 */
	const visitor = (init = {}) => {
		const state = { guestKey: init.guestKey ?? null, signIn: init.signIn ?? null };
		/** @param {string} method @param {string} path @param {unknown} [body] */
		const request = async (method, path, body) => {
			const response = await call(method, path, {
				token: browser,
				origin: ORIGIN,
				...(body === undefined ? {} : { body }),
				...(init.network ? { network: init.network } : {}),
				headers: {
					...(state.guestKey ? { 'ss-guest': state.guestKey } : {}),
					...(state.signIn ? { 'ss-sign-in': state.signIn } : {}),
				},
			});
			if (typeof response.json?.guestKey === 'string') state.guestKey = response.json.guestKey;
			return response;
		};
		return Object.assign(request, { state });
	};

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

	/** Save a list setting. @param {string} list @param {unknown[]} items */
	const list = async (list, items) => {
		const response = await dashboard(await adminSession(), 'PUT', `/v1/dashboard/websites/${websiteId}/lists/${list}`, {
			items,
		});
		if (response.status !== 200) throw new Error(`list: ${response.status} ${response.text}`);
		return response.json;
	};

	/** A ticket for the admin widgets. @param {string[]} [permissions] @param {{ id: string, name: string, email: string }} [user] */
	const ticket = async (
		permissions = ['inbox.read', 'inbox.reply', 'inbox.manage', 'knowledge.edit', 'reports.read'],
		user = { id: 'usr_sam', name: 'Sam Staff', email: 'sam@shop.example.com' },
	) => {
		const response = await serverCall('POST', '/v1/tickets', { user, permissions, origin: ADMIN_ORIGIN });
		return /** @type {string} */ (response.json.ticket);
	};

	/** An admin widget request. @param {string} ticketValue @param {string} method @param {string} path @param {unknown} [body] */
	const admin = (ticketValue, method, path, body) =>
		call(method, path, { token: ticketValue, origin: ADMIN_ORIGIN, ...(body === undefined ? {} : { body }) });

	/** Messages Chat sent through Notifications. */
	const messages = () =>
		calls
			.filter((c) => c.url.startsWith(`${NOTIFY}/v1/messages/`))
			.map((c) => ({ channel: c.url.split('/').pop(), authorization: c.headers.authorization, ...JSON.parse(c.body) }));

	/** Requests to the AI provider (POST completions only). */
	const aiCalls = () => calls.filter((c) => c.url.startsWith(AI) && c.method === 'POST').map((c) => JSON.parse(c.body));

	return {
		portal,
		accounts,
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
		list,
		ticket,
		admin,
		messages,
		aiCalls,
		flush,
		/** Queue answers of the fake AI. @param {...AiAnswer} answers */
		ai: (...answers) => {
			aiAnswers.push(...answers);
		},
		connectDatabase: () => connect('database', merchantDatabase()),
		now,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
	};
};

/** A website with the database connected and features switched on. @param {string[]} on */
export const ready = async (on) => {
	const sys = await setup();
	await sys.switchOn(on);
	await sys.connectDatabase();
	return sys;
};
