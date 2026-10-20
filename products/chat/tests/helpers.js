/**
 * Test harness: Chat on the kit, connected to the kit's fake Portal (`@ss/app-kit/testing`), with one website, its two
 * tokens, dashboard sessions, a merchant database on the run's MongoDB (`TEST_MONGODB_URI`) and fakes for every outside
 * service: the AI provider (OpenAI-compatible answers queued by the test), Notifications (records what Chat sends), the
 * Accounts double (sign-ins and public keys; other Accounts answers set per test with `responders`), Ecommerce (answers set per test with `responders`), S3 storage, the merchant's tool and booking endpoints, and the website
 * (pages) and the website's settings in the Portal (saved by a test). No real network call is ever made. Every answer `call()` sees is checked against
 * `schemas/api.json` and the kit's own routes: a test fails when an answer does not fit its description.
 * @module
 */
import {
	apiChecker,
	createAccountsDouble,
	createFakePortal,
	createMemoryStore,
	createNetwork,
	portalConnector,
	portalSectionsOf,
	staffCaller,
} from '@ss/app-kit/testing';
import { emptyWebsiteSettings } from '@ss/contracts/website-settings';
import apiJson from '../schemas/api.json' with { type: 'json' };
import { createProductInstance, manifest } from '../adapters/product.js';
import { createRoutes } from '../server/routes.js';

/** The API description every answer is checked against (tests that send their own requests check with it too). */
export const API = apiChecker(apiJson);

export const BASE = 'https://chat.example.dev';
const DOMAIN = 'shop.example.com';
export const ORIGIN = `https://${DOMAIN}`;
export const ADMIN_ORIGIN = 'https://admin.shop.example.com';
const NOTIFY = 'https://notifications.example.dev';
export const ACCOUNTS = 'https://accounts.example.dev';
export const AI = 'https://api.openai.com';
const STORAGE = 'https://s3.example.dev';
export const TOOLS = 'https://tools.example.dev';
export const ECOMMERCE = 'https://ecommerce.example.dev';
const SECRET = 'connect-secret-0123456789-abcdefghij';
const ENCRYPTION_KEY = 'encryption-key-0123456789-abcdefghij';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15';
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
 * @param {{ start?: number, store?: (store: import('@ss/app-kit').Store) => import('@ss/app-kit').Store }} [options]
 *   `store` wraps the product database (a test can make a read fail)
 */
export const setup = async ({ start = Date.parse('2026-10-05T10:00:00Z'), store = (given) => given } = {}) => {
	let t = start;
	const now = () => t;
	const portal = await createFakePortal({ now });
	const accounts = createAccountsDouble({ url: ACCOUNTS, now });
	/** @type {Call[]} */
	const calls = [];
	/** @type {AiAnswer[]} */
	const aiAnswers = [];
	/** @typedef {{ status: number, body?: unknown, type?: string }} Answer */
	/** @type {Map<string, (call: Call) => Answer | Promise<Answer>>} */
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
		// a responder may answer later (a promise), so a test can hold a call until it lets it go
		const answer = responder ? await responder(call) : { status: 200, body: {} };
		return new Response(
			answer.body === undefined ? null : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
			{ status: answer.status, headers: { 'content-type': answer.type ?? 'application/json' } },
		);
	};
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = {
		[portal.url]: portal.handle,
		// the Accounts double, and the answers a test sets for other Accounts paths (for example its roles)
		[ACCOUNTS]: (request) =>
			responders.has(`${ACCOUNTS}${new URL(request.url).pathname}`) ? fake(ACCOUNTS)(request) : accounts.handle(request),
		...Object.fromEntries([NOTIFY, AI, STORAGE, TOOLS, ECOMMERCE, ORIGIN].map((origin) => [origin, fake(origin)])),
	};
	responders.set(NOTIFY, (call) =>
		new URL(call.url).pathname.startsWith('/v1/messages/')
			? { status: 201, body: { id: `msg_${calls.length}`, status: 'queued' } }
			: { status: 200, body: {} },
	);
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
		store: store(createMemoryStore({ now })),
		fetch: portal.fetch,
		now,
		nodeEnv: 'test',
		outbound: { allowHosts: ['127.0.0.1', 'localhost'] },
		outboundSend: network.send,
	});
	/** @type {Array<() => Promise<unknown>>} */
	const tasks = [];
	const routes = createRoutes(product);
	const handler = product.handler(routes, { after: (task) => tasks.push(task) });
	handlers[BASE] = handler;
	await portal.connect({ handler, baseUrl: BASE, secret: SECRET });
	const websiteId = portal.addWebsite({ domain: DOMAIN });
	// what the merchant saved in the Portal's Website settings: the business, the pages and the alert team of the shop
	const empty = emptyWebsiteSettings(websiteId);
	const site = {
		...portalSectionsOf(websiteId, { name: 'Shop', email: 'hello@shop.example.com', country: 'GB', timeZone: 'UTC' }),
		pages: empty.pages,
		team: empty.team,
	};
	portal.setWebsiteSettings(websiteId, site);
	portal.addProduct({ productId: 'notifications', baseUrl: NOTIFY });
	portal.addProduct({ productId: 'accounts', baseUrl: ACCOUNTS });
	portal.addProduct({ productId: 'ecommerce', baseUrl: ECOMMERCE });
	const browser = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'browser' })).token;
	const server = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'server' })).token;

	let requests = 0;
	const flush = async () => {
		while (tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
	};

	/**
	 * A request, then the work after it (`after: false` leaves that work queued for `flush()`).
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string, body?: unknown, cookie?: string, headers?: Record<string, string>, network?: string,
	 *   after?: boolean, bare?: boolean, staff?: Record<string, any> }} [init] `bare`: the server token alone; `staff`: who is
	 *   signed in (the website's server with a staff Owner signed in otherwise)
	 */
	const call = async (
		method,
		path,
		{ token, origin, body, cookie, headers = {}, network: ip, after = true, bare = false, staff } = {},
	) => {
		requests += 1;
		if (token === server && !bare && headers['ss-sign-in'] === undefined && headers['ss-visitor-ip'] === undefined)
			// eslint-disable-next-line no-param-reassign -- the harness signs the staff member in
			headers = await staffHeaders({ headers, staff });
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
		if (after) await flush();
		const text = await response.text();
		/** @type {any} */
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = text;
		}
		API.assert({ method, path, status: response.status, body: json });
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

	/**
	 * A server-token request (a staff Owner signed in unless `staff` says who).
	 * @param {string} method @param {string} path @param {unknown} [body] @param {Record<string, any>} [staff]
	 */
	const serverCall = (method, path, body, staff) =>
		call(method, path, { token: server, ...(body === undefined ? {} : { body }), ...(staff ? { staff } : {}) });

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

	/** What the merchant does in the Portal (the database, the storage, the AI key, the links to other products). */
	const viaPortal = portalConnector({
		portal,
		websiteId,
		manifest,
		product,
		drain: flush,
		view: async (name) =>
			(await dashboard(await adminSession(), 'GET', `/v1/dashboard/websites/${websiteId}/connections`)).json.connections.find(
				(/** @type {{ name: string }} */ item) => item.name === name,
			),
	});

	/**
	 * Save a connection: the database, the storage, the main AI key and the links through the Portal (the product fetches
	 * them), the backup provider key on the Connections screen (tested live when saved).
	 * @param {string} name @param {unknown} [value]
	 */
	const connect = async (name, value) => {
		const delivered = await viaPortal(name, value);
		if (delivered !== null) return delivered;
		const response = await dashboard(await adminSession(), 'PUT', `/v1/dashboard/websites/${websiteId}/connections/${name}`, {
			value,
		});
		if (response.status !== 200) throw new Error(`connection ${name}: ${response.status} ${response.text}`);
		return response.json;
	};

	/** The Portal links this product to another one of the website. @param {string} productId */
	const paste = async (productId) => connect(productId, null);

	// the website's Accounts token, pasted on first use: the keys of the staff's sign-ins
	const staffHeaders = staffCaller({ accounts, websiteId, paste: () => paste('accounts') });

	/**
	 * The merchant saves website settings in the Portal (Website settings): the product is told and fetches them.
	 * @param {Partial<Pick<import('@ss/contracts').WebsiteSettings, 'business' | 'brand' | 'region' | 'pages' | 'team'>>} sections
	 */
	const setWebsite = async (sections) => {
		Object.assign(site, sections);
		t += 1000; // a second notice at the same second would read as a replay
		await portal.saveWebsiteSettings(websiteId, site);
		await flush();
	};

	/** The business facts in the Portal. @param {Parameters<typeof portalSectionsOf>[1]} info */
	const setBusiness = (info) => setWebsite(portalSectionsOf(websiteId, info));

	/**
	 * What used to be a Chat setting and is now the website's in the Portal: the alert team (people, phone channel, staff
	 * push), the sign-in page and the default language.
	 * @type {Record<string, (value: any) => Parameters<typeof setWebsite>[0]>}
	 */
	const PORTAL_SETTINGS = {
		'staff_alerts.recipients': (value) => ({
			team: {
				...site.team,
				recipients: /** @type {string[]} */ (value).map((entry) =>
					entry.includes('@') ? { name: '', email: entry, phone: '' } : { name: '', email: '', phone: entry },
				),
			},
		}),
		'staff_alerts.phoneChannel': (value) => ({ team: { ...site.team, phoneChannel: value } }),
		'staff_alerts.staffPush': (value) => ({ team: { ...site.team, staffPush: value } }),
		'signed_in_chat.signInUrl': (value) => ({ pages: { ...site.pages, signIn: value } }),
		'language_lock.defaultLanguage': (value) => ({ region: { ...site.region, language: value } }),
	};

	/** @param {string} feature @param {string} name @param {unknown} value */
	const setting = async (feature, name, value) => {
		const portalSetting = PORTAL_SETTINGS[`${feature}.${name}`];
		if (portalSetting) return setWebsite(portalSetting(value));
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

	/** Save a widget text (Settings → Texts). @param {string} key @param {string} value */
	const text = async (key, value) => {
		const response = await dashboard(await adminSession(), 'PUT', `/v1/dashboard/websites/${websiteId}/texts/${key}`, {
			value,
		});
		if (response.status !== 204) throw new Error(`text: ${response.status} ${response.text}`);
	};

	/** Save a list setting. @param {string} list @param {unknown[]} value */
	const list = async (list, value) => {
		const response = await dashboard(await adminSession(), 'PUT', `/v1/dashboard/websites/${websiteId}/lists/${list}`, {
			value,
		});
		if (response.status !== 200) throw new Error(`list: ${response.status} ${response.text}`);
		return response.json;
	};

	/** A ticket for the admin widgets. @param {string[]} [permissions] @param {{ id: string, name: string, email: string }} [user] */
	const ticket = async (
		permissions = ['inbox.read', 'inbox.reply', 'inbox.manage', 'knowledge.edit', 'reports.read'],
		user = { id: 'usr_sam', name: 'Sam Staff', email: 'sam@shop.example.com' },
	) => {
		const response = await serverCall('POST', '/v1/tickets', { permissions, origin: ADMIN_ORIGIN }, user);
		return /** @type {string} */ (response.json.ticket);
	};

	/** An admin widget request. @param {string} ticketValue @param {string} method @param {string} path @param {unknown} [body] */
	const admin = (ticketValue, method, path, body) =>
		call(method, path, { token: ticketValue, origin: ADMIN_ORIGIN, ...(body === undefined ? {} : { body }) });

	/**
	 * Follow an attachment link (Chat's own, CH-8): where it sends the browser.
	 * @param {string} url
	 */
	const open = async (url) => {
		const response = await call('GET', new URL(url).pathname);
		return { status: response.status, location: response.headers.get('location') ?? '' };
	};

	/** Messages Chat sent through Notifications. */
	const messages = () =>
		calls
			.filter((c) => c.url.startsWith(`${NOTIFY}/v1/messages/`))
			.map((c) => ({ channel: c.url.split('/').pop(), authorization: c.headers.authorization, ...JSON.parse(c.body) }));

	/** Requests Chat made to Ecommerce. */
	const shopCalls = () => calls.filter((c) => c.url.startsWith(ECOMMERCE));

	/** Requests to the AI provider (POST completions only). */
	const aiCalls = () => calls.filter((c) => c.url.startsWith(AI) && c.method === 'POST').map((c) => JSON.parse(c.body));

	return {
		portal,
		accounts,
		/** The product's routes (to look at what each one declares). */
		routes,
		staffHeaders,
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
		setWebsite,
		setBusiness,
		text,
		list,
		ticket,
		admin,
		messages,
		open,
		shopCalls,
		aiCalls,
		flush,
		/** Queue answers of the fake AI. @param {...AiAnswer} answers */
		ai: (...answers) => {
			aiAnswers.push(...answers);
		},
		connectDatabase: () => connect('database', merchantDatabase()),
		/** The keys the Portal gave this product for other products, by their ids. */
		linkTokens: viaPortal.tokens,
		/** The Portal ends this product's link to another one (or removes the storage). */
		disconnect: viaPortal.disconnect,
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
