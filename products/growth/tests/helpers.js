/**
 * Test harness: Growth on the kit, connected to the kit's fake Portal (`@ss/app-kit/testing`), with one website, its
 * two tokens, dashboard sessions, a merchant database on the run's MongoDB (`TEST_MONGODB_URI`) and a faked web: the
 * merchant's site (pages, robots.txt, sitemap) and the IndexNow endpoint are answered in process (no real network call
 * is ever made). Every command sent to the merchant database is kept, so a test can count the operations of a request.
 * Every answer `call()` sees is checked against `schemas/api.json` and the kit's own routes: a test fails when an
 * answer does not fit its description.
 * @module
 */
import { MongoClient } from 'mongodb';
import { validateValue } from '@ss/app-kit/api';
import { apiChecker, createAccountsDouble, createFakePortal, createMemoryStore, createNetwork, staffCaller } from '@ss/app-kit/testing';
import apiJson from '../schemas/api.json' with { type: 'json' };
import { createProductInstance, manifest } from '../adapters/product.js';
import { keyOf } from '../adapters/store.js';
import { createRoutes } from '../server/routes.js';

export const BASE = 'https://growth.example.dev';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = `https://${DOMAIN}`;
export const ADMIN_ORIGIN = 'https://admin.shop.example.com';
const SECRET = 'connect-secret-0123456789-abcdefghij';
const ENCRYPTION_KEY = 'encryption-key-0123456789-abcdefghij';

export const ALL = manifest.features.map((feature) => feature.key);

/** The API description every answer is checked against. */
const API = apiChecker(apiJson);

/**
 * Check an answer against `schemas/api.json` and the kit's own routes (throws when it does not fit). Only a JSON answer
 * has a body (robots.txt, the IndexNow key and CSV files are text). A JSON `null` (`GET /v1/notice` while no notice
 * shows) is checked against the described answer here, as the checker reads null as no body; so is a 204 with no body
 * from a route that answers 200 with a body otherwise (`GET /v1/redirects/match` with no rule): its description must
 * say so.
 * @param {string} method
 * @param {string} path
 * @param {Response} response
 */
export const checkAnswer = async (method, path, response) => {
	const text = /json/.test(response.headers.get('content-type') ?? '') ? await response.clone().text() : '';
	/** @type {unknown} */
	const body = text ? JSON.parse(text) : null;
	if (response.status === 204) {
		const key = API.described(method, path);
		const entry =
			key === null ? undefined : /** @type {Record<string, { status?: number, description?: string }>} */ (apiJson)[key];
		if (entry && (entry.status ?? 200) !== 204) {
			if (!/\b204\b/.test(entry.description ?? ''))
				throw new Error(`the answer does not fit schemas/api.json:\n${method} ${path}: answered 204, not described`);
			return;
		}
	}
	if (text.trim() === 'null' && response.status >= 200 && response.status < 300) {
		const key = API.described(method, path);
		const entry = key === null ? undefined : /** @type {Record<string, { response?: object }>} */ (apiJson)[key];
		const problems = entry?.response
			? validateValue(entry.response, null, { schemas: apiJson.$schemas })
			: [{ path: '', message: 'answered null, but the description has no response' }];
		if (problems.length > 0)
			throw new Error(`the answer does not fit schemas/api.json:\n${method} ${path}: ${problems[0]?.message}`);
		return;
	}
	API.assert({ method, path, status: response.status, body });
};

let databases = 0;

/** A fresh merchant database URI on the shared MongoDB. */
const merchantDatabase = () => {
	databases += 1;
	const url = new URL(/** @type {string} */ (process.env.TEST_MONGODB_URI));
	url.pathname = `/growth_${process.pid}_${Date.now()}_${databases}`;
	return url.toString();
};

/** @typedef {{ status: number, body?: string, headers?: Record<string, string> }} Page */

/**
 * The daily totals in the merchant database as rows `{ day, part, merchantId, metric, key, count, sum }` (each day's
 * documents taken apart).
 * @param {import('mongodb').Db} db
 */
export const dailyRows = async (db) =>
	(await db.collection('ss_growth_totals').find({}).toArray()).flatMap((doc) =>
		Object.entries(doc.totals ?? {}).flatMap(([metric, keys]) =>
			Object.entries(/** @type {Record<string, { c: number, s?: number }>} */ (keys)).map(([field, total]) => ({
				day: doc.day,
				part: doc.part,
				merchantId: doc.merchantId,
				metric,
				key: keyOf(field),
				count: total.c,
				sum: total.s ?? 0,
			})),
		),
	);

/**
 * Database operations as MongoDB Atlas counts them for its free tier's limit: each insert, read or delete command
 * once (a bulk insert is one operation) and each statement of an update command once; index builds aside.
 * @param {Array<{ commandName: string, command: Record<string, any> }>} commands
 */
export const operationsOf = (commands) => {
	const counted = commands.filter((entry) =>
		/^(insert|update|delete|find|aggregate|count|getMore|findAndModify)$/.test(entry.commandName),
	);
	return {
		total: counted.reduce((sum, entry) => sum + (entry.commandName === 'update' ? entry.command.updates.length : 1), 0),
		names: counted.map((entry) => `${entry.commandName} ${String(entry.command[entry.commandName])}`),
	};
};

/**
 * The merchant's site and IndexNow, faked: `pages[path]` answers (the path with its query string first, then without),
 * everything else 404; IndexNow answers 200 unless told otherwise.
 */
const createFakeWeb = () => {
	/** @type {Record<string, Page>} */
	const pages = {};
	/** @type {Array<{ url: string, method: string, body: string }>} */
	const calls = [];
	let indexNowStatus = 200;
	let siteDown = false;
	return {
		pages,
		calls,
		/** @param {number} status */
		indexNowAnswers: (status) => {
			indexNowStatus = status;
		},
		/** @param {boolean} value */
		siteDown: (value) => {
			siteDown = value;
		},
		handlers: {
			/** @param {Request} request */
			[ORIGIN]: async (request) => {
				calls.push({ url: request.url, method: request.method, body: '' });
				if (siteDown) throw new Error('down');
				const url = new URL(request.url);
				const page = pages[`${url.pathname}${url.search}`] ?? pages[url.pathname];
				return page
					? new Response(page.body ?? '', { status: page.status, headers: page.headers ?? {} })
					: new Response('not here', { status: 404 });
			},
			/** @param {Request} request */
			'https://api.indexnow.org': async (request) => {
				calls.push({ url: request.url, method: request.method, body: await request.text() });
				return new Response(null, { status: indexNowStatus });
			},
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
	const web = createFakeWeb();
	const accounts = createAccountsDouble({ now });
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = { [portal.url]: portal.handle, [accounts.url]: accounts.handle, ...web.handlers };
	const network = createNetwork(handlers);
	/** @type {Array<{ commandName: string, command: Record<string, any> }>} the merchant database's commands */
	const commands = [];
	const product = createProductInstance({
		data: {
			createClient: (uri, options) => {
				const client = new MongoClient(uri, { ...options, monitorCommands: true });
				client.on('commandStarted', ({ commandName, command }) => commands.push({ commandName, command }));
				return client;
			},
		},
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
	portal.addProduct({ productId: 'accounts', baseUrl: accounts.url });
	const browser = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'browser' })).token;
	const server = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'server' })).token;

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string, body?: unknown, cookie?: string, headers?: Record<string, string>,
	 *   bare?: boolean, staff?: Record<string, any> }} [init] `bare`: the server token alone; `staff`: who is signed in
	 *   (the website's server with a staff Owner signed in otherwise)
	 */
	const call = async (method, path, { token, origin, body, cookie, headers = {}, bare = false, staff } = {}) => {
		if (token === server && !bare && headers['ss-sign-in'] === undefined && headers['ss-visitor-ip'] === undefined)
			// eslint-disable-next-line no-param-reassign -- the harness signs the staff member in
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
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		while (tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
		await checkAnswer(method, path, response);
		return response;
	};

	// the website's Accounts token, pasted through the dashboard on first use
	const staffHeaders = staffCaller({
		accounts,
		websiteId,
		paste: async () => {
			const token = (await portal.issueToken({ websiteId, productId: 'accounts', kind: 'server' })).token;
			const launch = await portal.issueLaunch({ productId: manifest.id, kind: 'admin', role: 'owner', websiteId });
			const sso = await call('GET', `/sso?launch=${launch}`);
			const cookie = (sso.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
			const response = await call('PUT', `/v1/dashboard/websites/${websiteId}/connections/accounts`, {
				cookie,
				origin: BASE,
				body: { value: token },
			});
			if (response.status !== 200) throw new Error(`accounts token: ${response.status} ${await response.text()}`);
		},
	});

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

	/** @param {string} feature @param {string} name @param {unknown} value */
	const setting = async (feature, name, value) => {
		const response = await dashboard(
			await adminSession(),
			'PUT',
			`/v1/dashboard/websites/${websiteId}/settings/${feature}.${name}`,
			{ value },
		);
		if (response.status !== 204) throw new Error(`setting: ${response.status} ${await response.text()}`);
	};

	/** A ticket for the admin widgets. @param {string[]} [permissions] */
	const ticket = async (permissions = ['analytics.read', 'seo.check', 'indexnow.submit', 'redirects.edit']) => {
		const response = await call('POST', '/v1/tickets', {
			token: server,
			staff: { id: 'u_1', name: 'Sam Staff', email: 'sam@example.com' },
			body: { permissions, origin: ADMIN_ORIGIN },
		});
		return /** @type {{ ticket: string }} */ (await response.json()).ticket;
	};

	/** The page script's events (browser token from the website). @param {unknown[]} events @param {Record<string, string>} [headers] */
	const collect = (events, headers) =>
		call('POST', '/v1/collect', { token: browser, origin: ORIGIN, body: { events }, headers });

	/** @type {string | null} */
	let databaseUri = null;
	/** @type {MongoClient | null} */
	let client = null;

	return {
		portal,
		accounts,
		staffHeaders,
		product,
		web,
		websiteId,
		browser,
		server,
		call,
		dashboard,
		adminSession,
		switchOn,
		setting,
		ticket,
		collect,
		/**
		 * The merchant database operations of a piece of work.
		 * @param {() => Promise<unknown>} work
		 */
		operationsDuring: async (work) => {
			const from = commands.length;
			await work();
			return operationsOf(commands.slice(from));
		},
		connectDatabase: async () => {
			databaseUri = merchantDatabase();
			const response = await dashboard(
				await adminSession(),
				'PUT',
				`/v1/dashboard/websites/${websiteId}/connections/database`,
				{
					value: databaseUri,
				},
			);
			if (response.status !== 200) throw new Error(`database: ${response.status} ${await response.text()}`);
		},
		/** The merchant database, read directly. */
		merchantDb: async () => {
			client ??= await new MongoClient(/** @type {string} */ (databaseUri)).connect();
			return client.db();
		},
		/** Run the work queued after responses (for example after a notice). */
		flush: async () => {
			while (tasks.length > 0) await /** @type {() => Promise<unknown>} */ (tasks.shift())();
		},
		now,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
		close: async () => {
			await product.close();
			await client?.close();
		},
	};
};
