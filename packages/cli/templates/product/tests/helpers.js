/**
 * Test harness: this product on the kit, connected to the kit's fake Portal (`@ss/app-kit/testing`), with one website,
 * its two tokens, dashboard sessions, a merchant database on the run's MongoDB (`TEST_MONGODB_URI`) and an Accounts
 * double for the sign-ins of the staff: a staff route of the server token needs the sign-in of a signed-in staff member
 * next to the token, so `call()` signs an Owner in for a server-token call unless `bare: true`. Every answer
 * `call()` sees is checked against `schemas/api.json` (and the kit's own routes): a test fails when an answer does not
 * fit its description.
 * @module
 */
import { apiChecker, createAccountsDouble, createFakePortal, createMemoryStore, createNetwork, staffCaller } from '@ss/app-kit/testing';
import apiJson from '../schemas/api.json' with { type: 'json' };
import { createProductInstance, manifest } from '../adapters/product.js';
import { createRoutes } from '../server/routes.js';

/** The API description every answer is checked against. */
const API = apiChecker(apiJson);

export const BASE = 'https://product.example.dev';
export const DOMAIN = 'shop.example.com';
export const ORIGIN = `https://${DOMAIN}`;
export const ADMIN_ORIGIN = 'https://admin.shop.example.com';
const SECRET = 'connect-secret-0123456789-abcdefghij';
const ENCRYPTION_KEY = 'encryption-key-0123456789-abcdefghij';

let databases = 0;

/** A fresh merchant database URI on the shared MongoDB. */
const merchantDatabase = () => {
	databases += 1;
	const url = new URL(/** @type {string} */ (process.env.TEST_MONGODB_URI));
	url.pathname = `/merchant_${process.pid}_${Date.now()}_${databases}`;
	return url.toString();
};

/**
 * A connected product with one website.
 * @param {{ start?: number }} [options]
 */
export const setup = async ({ start = Date.parse('2026-10-01T10:00:00Z') } = {}) => {
	let t = start;
	const now = () => t;
	const portal = await createFakePortal({ now });
	const accounts = createAccountsDouble({ now });
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = { [portal.url]: portal.handle, [accounts.url]: accounts.handle };
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
	portal.addProduct({ productId: 'accounts', baseUrl: accounts.url });
	const browser = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'browser' })).token;
	const server = (await portal.issueToken({ websiteId, productId: manifest.id, kind: 'server' })).token;

	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ token?: string, origin?: string, body?: unknown, cookie?: string, headers?: Record<string, string>,
	 *   bare?: boolean, staff?: Record<string, any> }} [init] `bare`: the server token alone; `staff`: who is signed in
	 *   (a staff Owner otherwise)
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
		const json = (response.headers.get('content-type') ?? '').startsWith('application/json');
		API.assert({ method, path, status: response.status, body: json ? await response.clone().json() : null });
		return response;
	};

	// the website's Accounts token, pasted through the dashboard on first use: the keys of the staff's sign-ins
	const staffHeaders = staffCaller({
		accounts,
		websiteId,
		paste: async () => {
			const token = (await portal.issueToken({ websiteId, productId: 'accounts', kind: 'server' })).token;
			const cookie = await adminSession();
			const response = await dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/accounts`, {
				value: token,
			});
			if (response.status !== 200) throw new Error(`accounts: ${response.status} ${await response.text()}`);
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

	/** Connect the merchant database (Connections screen; tested live when saved). */
	const connectDatabase = async () => {
		const response = await dashboard(await adminSession(), 'PUT', `/v1/dashboard/websites/${websiteId}/connections/database`, {
			value: merchantDatabase(),
		});
		if (response.status !== 200) throw new Error(`database: ${response.status} ${await response.text()}`);
	};

	/** A ticket for the admin widget. @param {string[]} [permissions] */
	const ticket = async (permissions = ['notes.read']) => {
		const response = await call('POST', '/v1/tickets', {
			token: server,
			staff: { id: 'u_1', name: 'Sam Staff', email: 'sam@example.com' },
			body: { permissions, origin: ADMIN_ORIGIN },
		});
		return /** @type {{ ticket: string }} */ (await response.json()).ticket;
	};

	return {
		portal,
		accounts,
		staffHeaders,
		product,
		websiteId,
		browser,
		server,
		call,
		dashboard,
		adminSession,
		switchOn,
		connectDatabase,
		ticket,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
	};
};
