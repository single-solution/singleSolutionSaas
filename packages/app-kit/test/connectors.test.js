import { describe, expect, it } from 'vitest';
import { createConnectors, createHttpConnector, createS3Storage, presignUrl, signHeaders } from '../src/index.js';
import { WEBSITE, createTestLogger, setup } from './helpers.js';

const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const AWS_NOW = Date.parse('2013-05-24T00:00:00Z');

describe('SigV4 (AWS reference vectors)', () => {
	it('presigns a GET exactly like the AWS documentation example', () => {
		const url = presignUrl({
			method: 'GET',
			url: 'https://examplebucket.s3.amazonaws.com/test.txt',
			credentials: AWS,
			region: 'us-east-1',
			now: AWS_NOW,
			expiresIn: 86400,
		});
		expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe(
			'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
		);
	});

	it('signs a GET with headers exactly like the AWS documentation example', () => {
		const headers = signHeaders({
			method: 'GET',
			url: 'https://examplebucket.s3.amazonaws.com/test.txt',
			credentials: AWS,
			region: 'us-east-1',
			now: AWS_NOW,
			headers: { range: 'bytes=0-9' },
		});
		expect(headers.authorization).toBe(
			'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
		);
		expect(headers).not.toHaveProperty('host');
	});

	it('adds the session token and validates expiry', () => {
		const url = presignUrl({
			method: 'PUT',
			url: 'https://b.s3.amazonaws.com/a%20b',
			credentials: { ...AWS, sessionToken: 'tok' },
			region: 'eu-west-1',
			now: AWS_NOW,
			expiresIn: 60,
			query: { x: "it's" },
		});
		expect(new URL(url).searchParams.get('X-Amz-Security-Token')).toBe('tok');
		expect(url).toContain('x=it%27s');
		expect(() =>
			presignUrl({ method: 'GET', url: 'https://b/x', credentials: AWS, region: 'r', now: 0, expiresIn: 0 }),
		).toThrow(RangeError);
		const signed = signHeaders({
			method: 'PUT',
			url: 'https://b.s3.amazonaws.com/k?uploads=1',
			credentials: { ...AWS, sessionToken: 't' },
			region: 'r',
			now: 0,
			body: 'x',
		});
		expect(signed['x-amz-security-token']).toBe('t');
	});
});

describe('S3 storage adapter', () => {
	const descriptor = { bucket: 'merchant-bucket', region: 'eu-central-1', ...AWS, prefix: 'site/' };

	it('scopes keys to <prefix><slug>/<websiteId>/ and presigns PUT/GET', () => {
		const storage = createS3Storage({ descriptor, websiteId: WEBSITE, slug: 'coupon-box', fetch, now: () => AWS_NOW });
		const put = storage.presignPut({ key: 'img/a b.png', contentType: 'image/png', expiresIn: 120 });
		expect(put.key).toBe(`site/coupon-box/${WEBSITE}/img/a b.png`);
		expect(
			put.url.startsWith(`https://merchant-bucket.s3.eu-central-1.amazonaws.com/site/coupon-box/${WEBSITE}/img/a%20b.png?`),
		).toBe(true);
		expect(new URL(put.url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
		expect(put.headers).toEqual({ 'content-type': 'image/png' });
		expect(put.expiresAt).toBe('2013-05-24T00:02:00.000Z');
		const get = storage.presignGet({ key: 'img/a.png', downloadName: 'a"b.png' });
		expect(new URL(get.url).searchParams.get('response-content-disposition')).toBe('attachment; filename="a_b.png"');
		for (const key of ['', '/abs', 'a/../b', 'a//b', './a', 'a\\b', 'a\u0000b', 'x'.repeat(901)]) {
			expect(() => storage.keyFor(key)).toThrow();
		}
		expect(() => storage.presignGet({ key: 'a', expiresIn: 10 ** 7 })).toThrow();
	});

	it('supports custom endpoints (path and virtual-hosted style)', () => {
		const path = createS3Storage({
			descriptor: { ...descriptor, endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto' },
			websiteId: WEBSITE,
			slug: 's',
			fetch,
			now: () => 0,
		});
		expect(path.presignGet({ key: 'k' }).url.startsWith('https://acc.r2.cloudflarestorage.com/merchant-bucket/site/s/')).toBe(
			true,
		);
		const vhost = createS3Storage({
			descriptor: { ...descriptor, endpoint: 'https://storage.example.com', forcePathStyle: false },
			websiteId: WEBSITE,
			slug: 's',
			fetch,
			now: () => 0,
		});
		expect(vhost.presignGet({ key: 'k' }).url.startsWith('https://merchant-bucket.storage.example.com/site/s/')).toBe(true);
		const aws = createS3Storage({
			descriptor: { ...descriptor, forcePathStyle: true },
			websiteId: WEBSITE,
			slug: 's',
			fetch,
			now: () => 0,
		});
		expect(aws.presignGet({ key: 'k' }).url.startsWith('https://s3.eu-central-1.amazonaws.com/merchant-bucket/')).toBe(true);
		expect(() =>
			createS3Storage({
				descriptor: { ...descriptor, endpoint: 'http://storage.example.com' },
				websiteId: WEBSITE,
				slug: 's',
				fetch,
				now: () => 0,
			}),
		).toThrow();
		expect(
			createS3Storage({
				descriptor: { ...descriptor, endpoint: 'http://localhost:9000' },
				websiteId: WEBSITE,
				slug: 's',
				fetch,
				now: () => 0,
			}).bucket,
		).toBe('merchant-bucket');
		expect(() => createS3Storage({ descriptor: { bucket: 'b' }, websiteId: WEBSITE, slug: 's', fetch, now: () => 0 })).toThrow(
			/region/,
		);
	});

	it('heads and deletes objects with signed requests', async () => {
		/** @type {Request[]} */
		const seen = [];
		const statuses = [200, 404, 500, 204, 404, 403];
		/** @type {any} */
		const fakeFetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
			seen.push(new Request(url, init));
			return new Response(null, {
				status: statuses.shift(),
				headers: { 'content-length': '12', 'content-type': 'image/png', etag: '"e"' },
			});
		};
		const storage = createS3Storage({ descriptor, websiteId: WEBSITE, slug: 's', fetch: fakeFetch, now: () => AWS_NOW });
		expect(await storage.headObject({ key: 'k' })).toEqual({ exists: true, size: 12, contentType: 'image/png', etag: '"e"' });
		expect(await storage.headObject({ key: 'k' })).toEqual({ exists: false });
		await expect(storage.headObject({ key: 'k' })).rejects.toMatchObject({ code: 'upstream_error' });
		expect(await storage.deleteObject({ key: 'k' })).toEqual({ deleted: true });
		expect(await storage.deleteObject({ key: 'k' })).toEqual({ deleted: true });
		await expect(storage.deleteObject({ key: 'k' })).rejects.toMatchObject({ code: 'upstream_error' });
		expect(seen[0]?.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA/);
	});
});

describe('HTTP connectors', () => {
	/** @param {(url: URL, init: RequestInit) => Response} respond */
	const fetchWith = (respond) =>
		/** @type {any} */ (async (/** @type {URL} */ url, /** @type {RequestInit} */ init) => respond(url, init));

	it('sends authenticated JSON only under the provider base URL', async () => {
		/** @type {Array<{ url: string, headers: any, body: any }>} */
		const seen = [];
		const http = createHttpConnector({
			descriptor: { baseUrl: 'https://api.provider.test/v2/', apiKey: 'sk-secret', headers: { 'x-version': '1' } },
			kind: 'ai',
			fetch: fetchWith((url, init) => {
				seen.push({ url: String(url), headers: init.headers, body: init.body });
				return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
			}),
		});
		expect(await http.request({ path: '/things', body: { a: 1 } })).toEqual({ ok: true, status: 200, body: { ok: 1 } });
		expect(seen[0]).toMatchObject({
			url: 'https://api.provider.test/v2/things',
			headers: { authorization: 'Bearer sk-secret', 'x-version': '1', 'content-type': 'application/json' },
		});
		for (const path of ['things', '//evil.test/x', '/../x', '/a b', '/a\\b']) {
			await expect(http.request({ path })).rejects.toMatchObject({ code: 'invalid_argument' });
		}
		const header = createHttpConnector({
			descriptor: { baseUrl: 'http://localhost:8080', apiKey: 'k', authScheme: 'header', authHeader: 'X-Api-Key' },
			kind: 'messaging',
			fetch: fetchWith((_url, init) => new Response(String(/** @type {any} */ (init.headers)['x-api-key']), { status: 500 })),
		});
		expect(await header.request({ method: 'GET', path: '/' })).toEqual({ ok: false, status: 500, body: 'k' });
		const empty = createHttpConnector({
			descriptor: { baseUrl: 'https://x.test', apiKey: 'k', authScheme: 'header' },
			kind: 'ai',
			fetch: fetchWith(() => new Response(null, { status: 204 })),
		});
		expect(await empty.request({ path: '/' })).toEqual({ ok: true, status: 204, body: null });
	});

	it('validates descriptors and maps network failures without leaking keys', async () => {
		for (const descriptor of [
			{},
			{ baseUrl: 'nope', apiKey: 'k' },
			{ baseUrl: 'http://x.test', apiKey: 'k' },
			{ baseUrl: 'https://u:p@x.test', apiKey: 'k' },
			{ baseUrl: 'https://x.test', apiKey: '' },
		]) {
			expect(() => createHttpConnector({ descriptor, kind: 'ai', fetch })).toThrow();
		}
		const down = createHttpConnector({
			descriptor: { baseUrl: 'https://x.test', apiKey: 'sk-secret' },
			kind: 'ai',
			fetch: /** @type {any} */ (
				async () => {
					throw new TypeError('fetch failed sk-secret');
				}
			),
		});
		const error = await down.request({ path: '/' }).catch((e) => e);
		expect(error.code).toBe('upstream_error');
		expect(error.message).not.toContain('sk-secret');
		const slow = createHttpConnector({
			descriptor: { baseUrl: 'https://x.test', apiKey: 'k' },
			kind: 'ai',
			fetch: /** @type {any} */ (
				async () => {
					throw Object.assign(new Error('t'), { name: 'TimeoutError' });
				}
			),
		});
		await expect(slow.request({ path: '/' })).rejects.toMatchObject({ code: 'timeout' });
	});
});

describe('connectors via the Portal', () => {
	it('resolves credentials per website and kind, caches until expiresAt', async () => {
		const { portal, product, clock } = await setup();
		portal.setResource(
			WEBSITE,
			'storage',
			{ bucket: 'b', region: 'us-east-1', accessKeyId: 'AK', secretAccessKey: 'SK' },
			60_000,
		);
		const a = await product.connectors.storage(WEBSITE);
		const b = await product.connectors.storage(WEBSITE);
		expect(a).toBe(b);
		expect(portal.calls.filter((c) => c.path === '/v1/product/resources/resolve')).toHaveLength(1);
		clock.advance(60_000);
		expect(await product.connectors.storage(WEBSITE)).not.toBe(a);
		product.connectors.forget(WEBSITE);
		await product.connectors.storage(WEBSITE);
		expect(portal.calls.filter((c) => c.path === '/v1/product/resources/resolve')).toHaveLength(3);
		await expect(product.connectors.storage('')).rejects.toMatchObject({ code: 'invalid_argument' });
	});

	it('provides AI and messaging adapters and a payments interface', async () => {
		/** @type {any[]} */
		const calls = [];
		const fetchStub = /** @type {any} */ (
			async (/** @type {URL} */ url, /** @type {RequestInit} */ init) => {
				calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
				return new Response(JSON.stringify({ id: 'r1' }), { status: calls.length > 2 ? 500 : 200 });
			}
		);
		/** @type {Record<string, any>} */
		const descriptors = {
			ai: { baseUrl: 'https://ai.test', apiKey: 'k', model: 'm1', paths: { complete: '/complete' } },
			messaging: { baseUrl: 'https://msg.test', apiKey: 'k' },
			payments: { provider: 'acme', key: 'k' },
		};
		const connectors = createConnectors({
			portal: { resolveResource: async ({ kind }) => ({ descriptor: descriptors[kind], expiresAt: 'bad-date' }) },
			slug: 's',
			fetch: fetchStub,
			now: () => 0,
			adapters: {
				payments: {
					acme: ({ descriptor }) => ({
						provider: 'acme',
						createPayment: async () => ({ id: `p_${descriptor.key}`, status: 'pending' }),
						capture: async () => ({ id: 'p', status: 'captured' }),
						refund: async () => ({ id: 'p', status: 'refunded' }),
						status: async () => ({ id: 'p', status: 'captured' }),
						verifyWebhook: async () => ({ ok: true }),
					}),
				},
			},
		});
		const ai = await connectors.ai(WEBSITE);
		expect(await ai.complete({ messages: [] })).toEqual({ id: 'r1' });
		expect(calls[0]).toEqual({ url: 'https://ai.test/complete', body: { model: 'm1', messages: [] } });
		const messaging = await connectors.messaging(WEBSITE);
		expect(await messaging.send({ to: '+1', text: 'hi' })).toEqual({ id: 'r1' });
		expect(calls[1].url).toBe('https://msg.test/messages');
		await expect(messaging.send({})).rejects.toMatchObject({ code: 'upstream_error' });
		await expect(ai.complete({})).rejects.toMatchObject({ code: 'upstream_error' });
		const payments = await connectors.payments(WEBSITE);
		expect(await payments.createPayment({ amount: 100, currency: 'EUR', reference: 'o1', idempotencyKey: 'i' })).toEqual({
			id: 'p_k',
			status: 'pending',
		});
	});

	it('refuses unknown providers and incomplete payment adapters', async () => {
		const connectors = createConnectors({
			portal: {
				resolveResource: async ({ kind }) => ({
					descriptor: kind === 'payments' ? { provider: 'half' } : { provider: 'nope' },
					expiresAt: '2030-01-01T00:00:00Z',
				}),
			},
			slug: 's',
			fetch,
			adapters: { payments: { half: () => ({ createPayment: async () => ({}) }) } },
		});
		await expect(connectors.ai(WEBSITE)).rejects.toMatchObject({ code: 'not_implemented' });
		await expect(connectors.payments(WEBSITE)).rejects.toMatchObject({ code: 'not_implemented' });
		const none = createConnectors({
			portal: { resolveResource: async () => ({ descriptor: {}, expiresAt: 'x' }) },
			slug: 's',
			fetch,
		});
		await expect(none.payments(WEBSITE)).rejects.toMatchObject({ code: 'not_implemented' });
	});

	it('never logs credentials', async () => {
		const { logger, entries } = createTestLogger();
		const { portal, product } = await setup({ overrides: { logger } });
		portal.setResource(WEBSITE, 'ai', { baseUrl: 'https://ai.test', apiKey: 'sk-very-secret' });
		portal.setDown(true);
		await expect(product.connectors.ai(WEBSITE)).rejects.toBeDefined();
		portal.setDown(false);
		await product.connectors.ai(WEBSITE);
		expect(JSON.stringify(entries)).not.toContain('sk-very-secret');
	});
});
