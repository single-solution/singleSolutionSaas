/**
 * Plain node:http(s) server for the product (no Next.js): `node serve.js [port]`. Handy for `ss certify` in CI and for
 * local runs; production deploys use the Next.js routes in app/, which share the same router.
 */
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { Readable } from 'node:stream';
import { createRequestHandler } from '@ss/app-kit';
import { createPlatform } from './adapters/platform.js';
import { buildRoutes, createReviews, wireEvents } from './api/routes.js';
import { cronRoutes } from './jobs/requests.js';

/**
 * @param {{ port?: number, host?: string, env?: Record<string, string | undefined>, root?: string,
 *   overrides?: Record<string, unknown>, tls?: { key: string, cert: string } }} [options]
 * @returns {Promise<{ url: string, product: any, reviews: import('./api/routes.js').Reviews, close: () => Promise<void> }>}
 */
export const startServer = async ({
	port = 3000,
	host = '127.0.0.1',
	env = process.env,
	root = process.cwd(),
	overrides = {},
	tls,
} = {}) => {
	const reviews = wireEvents(createReviews(await createPlatform({ env, root, overrides })));
	const { product } = reviews;
	const handle = createRequestHandler(product, [...buildRoutes(reviews), ...cronRoutes(reviews)]);
	/** @type {import('node:http').RequestListener} */
	const listener = async (incoming, outgoing) => {
		const scheme = tls ? 'https' : 'http';
		const url = `${scheme}://${incoming.headers.host ?? `${host}:${port}`}${incoming.url ?? '/'}`;
		const method = incoming.method ?? 'GET';
		/** @type {Record<string, string>} */
		const headers = {};
		for (const [name, value] of Object.entries(incoming.headers))
			if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
		const hasBody = method !== 'GET' && method !== 'HEAD';
		const request = new Request(url, {
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
	const server = tls ? createTlsServer({ key: tls.key, cert: tls.cert }, listener) : createServer(listener);
	await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
	const address = /** @type {import('node:net').AddressInfo} */ (server.address());
	return {
		url: `${tls ? 'https' : 'http'}://${host}:${address.port}`,
		product,
		reviews,
		close: async () => {
			await new Promise((resolve) => {
				server.close(() => resolve(undefined));
				server.closeAllConnections();
			});
			await reviews.app.close();
		},
	};
};

/* v8 ignore start -- process entry point */
if (import.meta.url === `file://${process.argv[1]}`) {
	const { url } = await startServer({ port: Number(process.argv[2] ?? process.env.PORT ?? 3000) });
	process.stdout.write(`Reviews & Ratings listening on ${url}\n`);
}
/* v8 ignore stop */
