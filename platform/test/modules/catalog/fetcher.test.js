import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSafeFetch, isFetchError } from '../../../src/modules/catalog/fetcher.js';

/** @type {import('node:http').Server} */
let server;
/** @type {string} */
let base;
/** @type {number} */
let port;
/** @type {string[]} */
const hits = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		const chunks = /** @type {Buffer[]} */ ([]);
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			switch (req.url) {
				case '/json':
					res.writeHead(200, { 'content-type': 'application/json', 'x-multi': ['a', 'b'] });
					return void res.end('{"ok":true}');
				case '/echo':
					res.writeHead(200, { 'content-type': 'application/json' });
					return void res.end(
						JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString(), ua: req.headers['user-agent'] }),
					);
				case '/big-declared':
					res.writeHead(200, { 'content-length': String(4096) });
					return void res.end('x'.repeat(4096));
				case '/big-chunked':
					res.writeHead(200, { 'transfer-encoding': 'chunked' });
					for (let i = 0; i < 8; i += 1) res.write('y'.repeat(512));
					return void res.end();
				case '/redirect-same':
					res.writeHead(302, { location: '/json' });
					return void res.end();
				case '/redirect-loop':
					res.writeHead(301, { location: '/redirect-loop' });
					return void res.end();
				case '/redirect-other':
					res.writeHead(302, { location: `http://localhost:${port}/json` });
					return void res.end();
				case '/redirect-bad':
					res.writeHead(302, { location: 'http://[bad' });
					return void res.end();
				case '/redirect-none':
					res.writeHead(302);
					return void res.end();
				case '/slow':
					return; // never answers
				default:
					res.writeHead(404);
					return void res.end();
			}
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
	base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(() => resolve(undefined)));
});

/**
 * @param {Promise<unknown>} promise
 * @param {string} code
 */
const rejectsWith = async (promise, code) => {
	const error = await promise.then(
		() => null,
		(e) => e,
	);
	expect(isFetchError(error), String(error)).toBe(true);
	expect(error.code).toBe(code);
	return error;
};

describe('SSRF-safe fetch', () => {
	const dev = createSafeFetch({ allowlist: ['127.0.0.1', 'localhost'], maxBytes: 1024, timeoutMs: 1000 });

	it('fetches allowlisted local targets and follows same-host redirects', async () => {
		const res = await dev(`${base}/json`);
		expect(res).toMatchObject({ status: 200, text: '{"ok":true}', headers: { 'x-multi': 'a, b' } });
		const followed = await dev(`${base}/redirect-same`);
		expect(followed).toMatchObject({ status: 200, url: `${base}/json` });
		const echoed = await dev(`${base}/echo`, {
			method: 'POST',
			body: '{"a":1}',
			headers: { 'content-type': 'application/json' },
		});
		expect(JSON.parse(echoed.text)).toEqual({ method: 'POST', body: '{"a":1}', ua: 'ss-portal-catalog/1' });
		expect((await dev(`${base}/missing`)).status).toBe(404);
	});

	it('refuses 127.0.0.1 without the allowlist (http and loopback)', async () => {
		const prod = createSafeFetch();
		const before = hits.length;
		await rejectsWith(prod(`${base}/json`), 'target_refused');
		await rejectsWith(prod(`https://127.0.0.1:${port}/json`), 'target_refused');
		expect(hits.length).toBe(before); // nothing reached the server
	});

	it('refuses cloud metadata and private literals before connecting', async () => {
		const prod = createSafeFetch();
		const error = await rejectsWith(prod('https://169.254.169.254/latest/meta-data/'), 'target_refused');
		expect(error.message).toMatch(/169\.254/);
		await rejectsWith(prod('https://10.0.0.7/'), 'target_refused');
		await rejectsWith(prod('https://[fd00:ec2::254]/'), 'target_refused');
	});

	it('refuses names that resolve to private addresses (every answer is checked)', async () => {
		/** @type {Record<string, Array<{ address: string, family: number }>>} */
		const dns = {
			'internal.example.com': [{ address: '10.1.2.3', family: 4 }],
			'mixed.example.com': [
				{ address: '93.184.216.34', family: 4 },
				{ address: '192.168.0.10', family: 4 },
			],
			'mapped.example.com': [{ address: '::ffff:127.0.0.1', family: 6 }],
			'meta.example.com': [{ address: '169.254.169.254', family: 4 }],
			'empty.example.com': [],
		};
		const prod = createSafeFetch({
			resolveHost: async (host) => {
				if (host === 'nx.example.com') throw new Error('ENOTFOUND');
				return dns[host] ?? [];
			},
		});
		await rejectsWith(prod('https://internal.example.com/'), 'target_refused');
		await rejectsWith(prod('https://mixed.example.com/'), 'target_refused');
		await rejectsWith(prod('https://mapped.example.com/'), 'target_refused');
		await rejectsWith(prod('https://meta.example.com/'), 'target_refused');
		await rejectsWith(prod('https://empty.example.com/'), 'network');
		await rejectsWith(prod('https://nx.example.com/'), 'network');
	});

	it('connects to the vetted address only (no second lookup)', async () => {
		let lookups = 0;
		const pinned = createSafeFetch({
			allowlist: ['product.test'],
			resolveHost: async () => {
				lookups += 1;
				return [{ address: '127.0.0.1', family: 4 }];
			},
		});
		const res = await pinned(`http://product.test:${port}/json`);
		expect(res.status).toBe(200);
		expect(lookups).toBe(1);
	});

	it('refuses redirects to other hosts, loops, bad locations and POST redirects', async () => {
		await rejectsWith(dev(`${base}/redirect-other`), 'redirect_refused');
		await rejectsWith(dev(`${base}/redirect-loop`), 'redirect_refused');
		await rejectsWith(dev(`${base}/redirect-bad`), 'redirect_refused');
		await rejectsWith(dev(`${base}/redirect-none`), 'redirect_refused');
		await rejectsWith(dev(`${base}/redirect-same`, { method: 'POST', body: '' }), 'redirect_refused');
	});

	it('caps response sizes (declared and streamed)', async () => {
		await rejectsWith(dev(`${base}/big-declared`), 'too_large');
		await rejectsWith(dev(`${base}/big-chunked`), 'too_large');
		expect((await dev(`${base}/big-chunked`, { maxBytes: 8192 })).text).toHaveLength(4096);
	});

	it('times out', async () => {
		await rejectsWith(dev(`${base}/slow`, { timeoutMs: 100 }), 'timeout');
	});

	it('reports connection failures', async () => {
		const closed = createServer();
		await new Promise((resolve) => closed.listen(0, '127.0.0.1', () => resolve(undefined)));
		const deadPort = /** @type {import('node:net').AddressInfo} */ (closed.address()).port;
		await new Promise((resolve) => closed.close(() => resolve(undefined)));
		await rejectsWith(dev(`http://127.0.0.1:${deadPort}/`), 'network');
		expect(isFetchError(new Error('x'))).toBe(false);
	});
});
