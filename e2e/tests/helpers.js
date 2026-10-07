/**
 * Shared helpers of the system tests: a controllable clock and databases on the run's MongoMemoryReplSet
 * (`TEST_MONGODB_URI`, started by the `@ss/config` Mongo global setup).
 * @module
 */
import { createServer as createTlsServer } from 'node:https';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createRequestHandler } from '@ss/app-kit';

/**
 * Controllable clock.
 * @param {number} start epoch milliseconds
 */
export const createClock = (start) => {
	let t = start;
	return {
		now: () => t,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
		/** @param {number} ms */
		set: (ms) => {
			t = ms;
		},
	};
};

/**
 * MongoDB URI of a database on the shared replica set.
 * @param {string} name
 */
export const mongoUri = (name) => {
	const base = process.env.TEST_MONGODB_URI;
	if (!base) throw new Error('TEST_MONGODB_URI is not set (run through vitest with the @ss/config Mongo setup)');
	const url = new URL(base);
	url.pathname = `/${name}`;
	return url.toString();
};

/** The `CONNECT_SECRET` the products under test run with. */
export const CONNECT_SECRET = 'e2e-product-connect-secret-0123456789abcdef';

/**
 * Add a product the way staff do: Admin → Apps → Add product with its URL and connect secret (the Portal calls its
 * `/.well-known/ss-connect`, HMAC both ways, and pins its address and key). Answers the app as the admin API shows it,
 * with status 201 once connected.
 * @param {(method: string, path: string, init?: Record<string, any>) => Promise<{ status: number, json: any }>} call in-process Portal call
 * @param {string} staffCookie
 * @param {string} productUrl
 * @param {string} [secret]
 */
export const connectProduct = async (call, staffCookie, productUrl, secret = CONNECT_SECRET) => {
	const connected = await call('POST', '/v1/admin/apps/connect', { cookie: staffCookie, body: { url: productUrl, secret } });
	if (connected.status !== 201) return connected;
	const app = await call('GET', `/v1/admin/apps/${connected.json.appId}`, { cookie: staffCookie });
	return { status: 201, json: app.json };
};

/**
 * A product package's folder (its manifest, schemas and strings: the `root` its `createPlatform` reads).
 * @param {string} pkg e.g. `@ss/product-reviews`
 */
export const productRoot = (pkg) => path.dirname(createRequire(import.meta.url).resolve(`${pkg}/package.json`));

/**
 * Serve a service product the way its Next.js route handler does in production: its own routes through the app-kit
 * request handler, here on a plain node:https server (throw-away certificate) bound to 127.0.0.1.
 * @param {{ product: any, routes: Iterable<any>, close: () => Promise<unknown>, tls: { key: string, cert: string },
 *   port: number, host?: string, handlerOptions?: Record<string, unknown> }} input
 * @returns {Promise<{ url: string, product: any, close: () => Promise<void> }>}
 */
export const startProduct = async ({ product, routes, close, tls, port, host = '127.0.0.1', handlerOptions = {} }) => {
	const handle = createRequestHandler(product, [...routes], handlerOptions);
	/** @type {import('node:http').RequestListener} */
	const listener = async (incoming, outgoing) => {
		const method = incoming.method ?? 'GET';
		/** @type {Record<string, string>} */
		const headers = {};
		for (const [name, value] of Object.entries(incoming.headers))
			if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
		const hasBody = method !== 'GET' && method !== 'HEAD';
		const request = new Request(`https://${incoming.headers.host ?? `${host}:${port}`}${incoming.url ?? '/'}`, {
			method,
			headers,
			...(hasBody ? { body: /** @type {any} */ (Readable.toWeb(incoming)), duplex: 'half' } : {}),
		});
		const response = await handle(request);
		/** @type {Record<string, string | string[]>} */
		const out = {};
		response.headers.forEach((value, name) => {
			if (name !== 'set-cookie') out[name] = value;
		});
		const cookies = response.headers.getSetCookie();
		if (cookies.length > 0) out['set-cookie'] = cookies;
		outgoing.writeHead(response.status, out);
		outgoing.end(Buffer.from(await response.arrayBuffer()));
	};
	const server = createTlsServer({ key: tls.key, cert: tls.cert }, listener);
	await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
	const address = /** @type {import('node:net').AddressInfo} */ (server.address());
	return {
		url: `https://${host}:${address.port}`,
		product,
		close: async () => {
			await new Promise((resolve) => {
				server.close(() => resolve(undefined));
				server.closeAllConnections();
			});
			await close();
		},
	};
};
