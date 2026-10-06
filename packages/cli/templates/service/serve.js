/**
 * Plain node:http server for the product (no Next.js): `node serve.js [port]`. Handy for `ss certify` in CI and for
 * local runs; production deploys use the Next.js routes in app/, which share the same router.
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createRequestHandler } from '@ss/app-kit';
import { createPlatform } from './adapters/platform.js';
import { buildRoutes, wireEvents } from './api/routes.js';
import { jobRoutes, wireJobs } from './jobs/index.js';

/**
 * @param {{ port?: number, host?: string, env?: Record<string, string | undefined>, root?: string, overrides?: Record<string, unknown> }} [options]
 * @returns {Promise<{ url: string, product: any, close: () => Promise<void> }>}
 */
export const startServer = async ({
	port = 3000,
	host = '127.0.0.1',
	env = process.env,
	root = process.cwd(),
	overrides = {},
} = {}) => {
	const product = wireJobs(wireEvents(await createPlatform({ env, root, overrides })));
	const handle = createRequestHandler(product, [
		...buildRoutes(product),
		...jobRoutes(product, { cronSecret: env.CRON_SECRET }),
	]);
	const server = createServer(async (incoming, outgoing) => {
		const url = `http://${incoming.headers.host ?? `${host}:${port}`}${incoming.url ?? '/'}`;
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
	});
	await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
	const address = /** @type {import('node:net').AddressInfo} */ (server.address());
	return {
		url: `http://${host}:${address.port}`,
		product,
		close: async () => {
			await new Promise((resolve) => {
				server.close(() => resolve(undefined));
				server.closeAllConnections();
			});
			await product.close?.();
		},
	};
};

if (import.meta.url === `file://${process.argv[1]}`) {
	const { url } = await startServer({ port: Number(process.argv[2] ?? process.env.PORT ?? 3000) });
	process.stdout.write(`{{name}} listening on ${url}\n`);
}
