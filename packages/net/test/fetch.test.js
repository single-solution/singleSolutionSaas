import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOutboundPolicy, jsonOf, safeFetch, textOf } from '../src/index.js';

/** @type {import('node:http').Server} */
let server;
let port = 0;
/** @type {Array<{ method: string, url: string, headers: import('node:http').IncomingHttpHeaders, body: string }>} */
const seen = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		/** @type {Buffer[]} */
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const body = Buffer.concat(chunks).toString('utf8');
			seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
			const url = new URL(req.url ?? '/', 'http://x');
			const host = req.headers.host ?? '';
			switch (url.pathname) {
				case '/json':
					res.setHeader('set-cookie', ['a=1', 'b=2']);
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ ok: true, host }));
					return;
				case '/echo':
					res.writeHead(201);
					res.end(`${req.method} ${body} ${req.headers['content-length']} ${req.headers['user-agent']}`);
					return;
				case '/empty':
					res.writeHead(204);
					res.end();
					return;
				case '/redirect': {
					const to = url.searchParams.get('to') ?? '/json';
					const status = Number(url.searchParams.get('status') ?? '302');
					res.writeHead(status, { location: to });
					res.end();
					return;
				}
				case '/no-location':
					res.writeHead(302);
					res.end();
					return;
				case '/big-declared':
					res.writeHead(200, { 'content-length': '5000' });
					res.end('x'.repeat(5000));
					return;
				case '/big-chunked':
					res.writeHead(200);
					res.write('x'.repeat(3000));
					res.end('y'.repeat(3000));
					return;
				case '/hang':
					return; // never answers
				default:
					res.writeHead(404);
					res.end('missing');
			}
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(() => resolve(undefined)));
});

const LOOPBACK = [{ address: '127.0.0.1', family: 4 }];

/**
 * Policy whose resolver pins every name to the local test server.
 * @param {import('../src/index.js').OutboundPolicyOptions} [options]
 */
const local = (options = {}) => {
	let resolutions = 0;
	const policy = createOutboundPolicy({
		allowHosts: ['app.test', 'other.test'],
		resolve: async () => {
			resolutions += 1;
			return LOOPBACK;
		},
		...options,
	});
	return { policy, count: () => resolutions };
};

describe('safeFetch', () => {
	it('fetches through the pinned, vetted address and returns status, headers and body', async () => {
		const { policy, count } = local();
		const res = await safeFetch(`http://app.test:${port}/json`, {}, policy);
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toBe('application/json');
		expect(res.headers['set-cookie']).toBe('a=1, b=2');
		expect(jsonOf(res)).toEqual({ ok: true, host: `app.test:${port}` });
		expect(res.url).toBe(`http://app.test:${port}/json`);
		expect(count()).toBe(1);
	});

	it('sends bodies with content-length and a default user agent', async () => {
		const { policy } = local();
		const res = await safeFetch(
			new URL(`http://app.test:${port}/echo`),
			{ method: 'post', body: 'héllo', headers: { 'X-Custom': 'v' } },
			policy,
		);
		expect(res.status).toBe(201);
		expect(textOf(res)).toBe('POST héllo 6 ss-net/1');
		const bytes = await safeFetch(`http://app.test:${port}/echo`, { method: 'PUT', body: new Uint8Array([104, 105]) }, policy);
		expect(textOf(bytes)).toBe('PUT hi 2 ss-net/1');
		const empty = await safeFetch(`http://app.test:${port}/empty`, { method: 'HEAD' }, policy);
		expect(empty.status).toBe(204);
		expect(jsonOf(empty)).toBeNull();
	});

	it('follows same-origin redirects up to maxRedirects', async () => {
		const { policy, count } = local();
		const res = await safeFetch(
			`http://app.test:${port}/redirect?to=/redirect%3Fto%3D/json%26status%3D308&status=301`,
			{},
			policy,
		);
		expect(res.status).toBe(200);
		expect(res.url).toBe(`http://app.test:${port}/json`);
		expect(count()).toBe(3);
		const one = local({ maxRedirects: 1 }).policy;
		await expect(safeFetch(`http://app.test:${port}/redirect?to=/redirect%3Fto%3D/json`, {}, one)).rejects.toMatchObject({
			code: 'redirect_refused',
			reason: 'too_many',
		});
		const none = local({ maxRedirects: 0 }).policy;
		await expect(safeFetch(`http://app.test:${port}/redirect`, {}, none)).rejects.toMatchObject({
			code: 'redirect_refused',
			reason: 'too_many',
		});
	});

	it('refuses cross-origin redirects unless allowed, and drops credentials when following them', async () => {
		const { policy } = local();
		await expect(
			safeFetch(`http://app.test:${port}/redirect?to=http://other.test:${port}/json`, {}, policy),
		).rejects.toMatchObject({ code: 'redirect_refused', reason: 'cross_origin' });
		const open = local({ sameHostRedirectsOnly: false }).policy;
		seen.length = 0;
		const res = await safeFetch(
			`http://app.test:${port}/redirect?to=http://other.test:${port}/json`,
			{ headers: { authorization: 'Bearer secret', cookie: 'c=1', 'x-keep': 'yes' } },
			open,
		);
		expect(jsonOf(res)).toEqual({ ok: true, host: `other.test:${port}` });
		expect(seen[0]?.headers.authorization).toBe('Bearer secret');
		expect(seen[1]?.headers.authorization).toBeUndefined();
		expect(seen[1]?.headers.cookie).toBeUndefined();
		expect(seen[1]?.headers['x-keep']).toBe('yes');
		// a redirect is re-checked against the policy: a private literal is refused
		await expect(
			safeFetch(`http://app.test:${port}/redirect?to=http://127.0.0.1:${port}/json`, {}, open),
		).rejects.toMatchObject({ code: 'ssrf_blocked', reason: 'loopback_address' });
		await expect(
			safeFetch(`http://app.test:${port}/redirect?to=https://169.254.169.254/latest/meta-data`, {}, open),
		).rejects.toMatchObject({ code: 'ssrf_blocked', reason: 'metadata_address' });
	});

	it('handles redirect modes, methods and bad locations', async () => {
		const { policy } = local();
		const manual = await safeFetch(`http://app.test:${port}/redirect`, { redirect: 'manual' }, policy);
		expect(manual).toMatchObject({ status: 302, headers: { location: '/json' } });
		await expect(safeFetch(`http://app.test:${port}/redirect`, { redirect: 'error' }, policy)).rejects.toMatchObject({
			code: 'redirect_refused',
			reason: 'redirect_mode',
		});
		await expect(
			safeFetch(`http://app.test:${port}/redirect?status=307`, { method: 'POST', body: 'x' }, policy),
		).rejects.toMatchObject({ code: 'redirect_refused', reason: 'method' });
		await expect(safeFetch(`http://app.test:${port}/redirect?to=http://%5B::1`, {}, policy)).rejects.toMatchObject({
			code: 'redirect_refused',
			reason: 'invalid_location',
		});
		expect((await safeFetch(`http://app.test:${port}/no-location`, {}, policy)).status).toBe(302);
		expect((await safeFetch(`http://app.test:${port}/nothing`, {}, policy)).status).toBe(404);
	});

	it('caps the response size (declared and streamed)', async () => {
		const { policy } = local({ maxBytes: 4096 });
		await expect(safeFetch(`http://app.test:${port}/big-declared`, {}, policy)).rejects.toMatchObject({
			code: 'too_large',
			reason: 'declared_length',
		});
		await expect(safeFetch(`http://app.test:${port}/big-chunked`, {}, policy)).rejects.toMatchObject({
			code: 'too_large',
			reason: 'body_length',
		});
		const ok = await safeFetch(`http://app.test:${port}/big-chunked`, { maxBytes: 6000 }, policy);
		expect(ok.body.length).toBe(6000);
	});

	it('enforces the deadline and abort signals', async () => {
		const { policy } = local({ timeoutMs: 100 });
		await expect(safeFetch(`http://app.test:${port}/hang`, {}, policy)).rejects.toMatchObject({ code: 'timeout' });
		await expect(safeFetch(`http://app.test:${port}/hang`, { timeoutMs: 50 }, local().policy)).rejects.toMatchObject({
			code: 'timeout',
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 30);
		await expect(
			safeFetch(`http://app.test:${port}/hang`, { signal: controller.signal }, local().policy),
		).rejects.toMatchObject({ code: 'aborted' });
		await expect(
			safeFetch(`http://app.test:${port}/json`, { signal: AbortSignal.abort() }, local().policy),
		).rejects.toMatchObject({ code: 'aborted' });
		// a deadline that fires while DNS resolution is still pending
		const slowDns = createOutboundPolicy({
			allowHosts: ['app.test'],
			timeoutMs: 30,
			resolve: () => new Promise((resolve) => setTimeout(() => resolve(LOOPBACK), 80)),
		});
		await expect(safeFetch(`http://app.test:${port}/json`, {}, slowDns)).rejects.toMatchObject({ code: 'timeout' });
	});

	it('refuses private destinations before connecting (resolver answers checked)', async () => {
		seen.length = 0;
		let resolved = 0;
		const policy = createOutboundPolicy({
			resolve: async () => {
				resolved += 1;
				return [{ address: '93.184.216.34', family: 4 }, LOOPBACK[0] ?? { address: '127.0.0.1', family: 4 }];
			},
		});
		await expect(safeFetch('https://evil.example.com/', {}, policy)).rejects.toMatchObject({
			code: 'ssrf_blocked',
			reason: 'loopback_address',
		});
		expect(resolved).toBe(1);
		expect(seen).toHaveLength(0);
	});

	it('rejects bad URLs and policy violations', async () => {
		await expect(safeFetch('http://example.com/')).rejects.toMatchObject({ code: 'ssrf_blocked', reason: 'https_required' });
		await expect(safeFetch('https://u:p@example.com/')).rejects.toMatchObject({ code: 'bad_url', reason: 'userinfo' });
		await expect(safeFetch('nope')).rejects.toMatchObject({ code: 'bad_url' });
		await expect(safeFetch('https://example.com/', { method: 'GE T' })).rejects.toMatchObject({
			code: 'bad_url',
			reason: 'invalid_method',
		});
		await expect(safeFetch('https://[::1]/')).rejects.toMatchObject({ code: 'ssrf_blocked', reason: 'loopback_address' });
	});

	it('maps connection and TLS failures to network errors', async () => {
		const closed = createServer();
		await new Promise((resolve) => closed.listen(0, '127.0.0.1', () => resolve(undefined)));
		const closedPort = /** @type {import('node:net').AddressInfo} */ (closed.address()).port;
		await new Promise((resolve) => closed.close(() => resolve(undefined)));
		await expect(safeFetch(`http://app.test:${closedPort}/`, {}, local().policy)).rejects.toMatchObject({
			code: 'network',
			reason: 'request_failed',
			detail: 'ECONNREFUSED',
		});
		// TLS to a plain HTTP server
		await expect(safeFetch(`https://app.test:${port}/json`, {}, local().policy)).rejects.toMatchObject({
			code: 'network',
			reason: 'tls_failed',
		});
		const dnsDown = createOutboundPolicy({
			allowHosts: ['app.test'],
			resolve: async () => {
				throw Object.assign(new Error('x'), { code: 'EAI_AGAIN' });
			},
		});
		await expect(safeFetch(`http://app.test:${port}/json`, {}, dnsDown)).rejects.toMatchObject({
			code: 'network',
			reason: 'dns_failed',
			detail: 'EAI_AGAIN',
		});
	});
});
