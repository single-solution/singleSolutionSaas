/**
 * Test harness: Growth on the kit, connected to the kit's fake Portal (`@ss/app-kit/testing`), with one website, its
 * two tokens, dashboard sessions, a merchant database on the run's MongoDB (`TEST_MONGODB_URI`) and a faked web: the
 * merchant's site (pages, robots.txt, sitemap) and the IndexNow endpoint are answered in process (no real network call
 * is ever made).
 * @module
 */
import { MongoClient } from 'mongodb';
import { createFakePortal, createMemoryStore, createNetwork } from '@ss/app-kit/testing';
import { createProductInstance, manifest } from '../adapters/product.js';
import { createRoutes } from '../api/routes.js';

export const BASE = 'https://growth.example.dev';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = `https://${DOMAIN}`;
export const ADMIN_ORIGIN = 'https://admin.shop.example.com';
const SECRET = 'connect-secret-0123456789-abcdefghij';
const ENCRYPTION_KEY = 'encryption-key-0123456789-abcdefghij';

export const ALL = manifest.features.map((feature) => feature.key);

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
 * The merchant's site and IndexNow, faked: `pages[path]` answers, everything else 404; IndexNow answers 200 unless
 * told otherwise.
 */
export const createFakeWeb = () => {
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
				const page = pages[new URL(request.url).pathname];
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
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = { [portal.url]: portal.handle, ...web.handlers };
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
	const browser = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'browser' })).token;
	const server = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'server' })).token;

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string, body?: unknown, cookie?: string, headers?: Record<string, string> }} [init]
	 */
	const call = async (method, path, { token, origin, body, cookie, headers = {} } = {}) => {
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
	const ticket = async (permissions = ['analytics.read', 'seo.check', 'indexnow.submit']) => {
		const response = await call('POST', '/v1/tickets', {
			token: server,
			body: { user: { id: 'u_1', name: 'Sam Staff', email: 'sam@example.com' }, permissions, origin: ADMIN_ORIGIN },
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
