/**
 * Test harness: this product on the kit, connected to the kit's fake Portal (`@ss/app-kit/testing`), with one website,
 * its two tokens, dashboard sessions and a merchant database on the run's MongoDB (`TEST_MONGODB_URI`).
 * @module
 */
import { createFakePortal, createMemoryStore, createNetwork } from '@ss/app-kit/testing';
import { createProductInstance, manifest } from '../adapters/product.js';
import { createRoutes } from '../api/routes.js';

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
	/** @type {Record<string, (request: Request) => Promise<Response>>} */
	const handlers = { [portal.url]: portal.handle };
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
	 * @param {{ token?: string, origin?: string, body?: unknown, cookie?: string }} [init]
	 */
	const call = async (method, path, { token, origin, body, cookie } = {}) => {
		const response = await handler(
			new Request(`${BASE}${path}`, {
				method,
				headers: {
					...(token ? { authorization: `Bearer ${token}` } : {}),
					...(origin ? { origin } : {}),
					...(cookie ? { cookie } : {}),
					...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
			body: { user: { id: 'u_1', name: 'Sam Staff', email: 'sam@example.com' }, permissions, origin: ADMIN_ORIGIN },
		});
		return /** @type {{ ticket: string }} */ (await response.json()).ticket;
	};

	return {
		portal,
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
