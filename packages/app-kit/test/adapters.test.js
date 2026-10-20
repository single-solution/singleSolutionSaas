import { createOutboundPolicy, netError } from '@ss/net';
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_SECONDS, createS3Storage } from '../src/adapters/storage.js';

const WEBSITE = 'web_0123456789abcdefghjkmnpq';

/**
 * A `send` stub answering like `safeFetch`.
 * @param {(url: string, init: any) => { status: number, headers?: Record<string, string>, body?: string }} respond
 * @returns {any}
 */
const sendWith = (respond) => async (/** @type {string} */ url, /** @type {any} */ init) => {
	const { status, headers = {}, body = '' } = respond(url, init);
	return { status, headers, body: Buffer.from(body), url };
};
const noSend = sendWith(() => ({ status: 500 }));
const devPolicy = createOutboundPolicy({ allowHosts: ['localhost'] });

const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const AWS_NOW = Date.parse('2013-05-24T00:00:00Z');

describe('S3 storage adapter', () => {
	const descriptor = { bucket: 'merchant-bucket', region: 'eu-central-1', ...AWS, prefix: 'site/' };

	it('scopes keys to <prefix><slug>/<websiteId>/ and presigns PUT/GET', () => {
		const storage = createS3Storage({ descriptor, websiteId: WEBSITE, slug: 'coupon-box', send: noSend, now: () => AWS_NOW });
		const put = storage.presignPut({ key: 'img/a b.png', contentType: 'image/png', contentLength: 10, expiresIn: 120 });
		expect(put.key).toBe('img/a b.png');

		expect(
			put.url.startsWith(`https://merchant-bucket.s3.eu-central-1.amazonaws.com/site/coupon-box/${WEBSITE}/img/a%20b.png?`),
		).toBe(true);
		expect(new URL(put.url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
		expect(put.headers).toEqual({ 'content-type': 'image/png', 'content-length': '10' });
		expect(put.expiresAt).toBe('2013-05-24T00:02:00.000Z');
		const get = storage.presignGet({ key: 'img/a.png', downloadName: 'a"b.png' });
		expect(get.key).toBe('img/a.png');
		expect(new URL(get.url).pathname).toBe(`/site/coupon-box/${WEBSITE}/img/a.png`);
		expect(new URL(get.url).searchParams.get('response-content-disposition')).toBe('attachment; filename="a_b.png"');
		for (const key of ['', '/abs', 'a/../b', 'a//b', './a', 'a\\b', 'a\u0000b', 'x'.repeat(901)]) {
			expect(() => storage.presignGet({ key })).toThrow();
		}
		// an absolute key handed back is refused rather than prefixed twice
		expect(() => storage.presignGet({ key: `site/coupon-box/${WEBSITE}/img/a.png` })).toThrow(/relative object key/);
		expect(() => storage.presignGet({ key: 'a', expiresIn: 10 ** 7 })).toThrow();
	});

	it('gives a file its public address from publicBaseUrl and the absolute key, or null without one', () => {
		const make = (/** @type {Record<string, unknown>} */ extra, slug = 'shop') =>
			createS3Storage({ descriptor: { ...descriptor, ...extra }, websiteId: WEBSITE, slug, send: noSend, now: () => AWS_NOW });
		// no public address: the product serves the file itself
		expect(make({}).publicUrl('img/a.png')).toBeNull();
		expect(make({}).hasPublicUrl).toBe(false);
		const cdn = make({ publicBaseUrl: 'https://cdn.example.com' });
		expect(cdn.hasPublicUrl).toBe(true);
		expect(cdn.publicUrl('img/a.png')).toBe(`https://cdn.example.com/site/shop/${WEBSITE}/img/a.png`);
		// a trailing slash and a path in the address are kept sensibly; every path part is URL-encoded
		const deep = make({ publicBaseUrl: 'https://files.example.com/public//', prefix: 'my shop/' });
		expect(deep.publicUrl('img/a b#1.png')).toBe(
			`https://files.example.com/public/my%20shop/shop/${WEBSITE}/img/a%20b%231.png`,
		);
		expect(make({ publicBaseUrl: 'https://cdn.example.com', prefix: undefined }).publicUrl('x.png')).toBe(
			`https://cdn.example.com/shop/${WEBSITE}/x.png`,
		);
		// the same key rules as everywhere: relative, no dot segments, not handed back absolute
		for (const key of ['', '/abs', 'a/../b', `site/shop/${WEBSITE}/img/a.png`]) expect(() => cdn.publicUrl(key)).toThrow();
		// a public address that is not a public https address refuses the connection
		for (const publicBaseUrl of ['http://cdn.example.com', 'https://127.0.0.1', 'https://cdn.example.com/?x=1', 'nope'])
			expect(() => make({ publicBaseUrl }), publicBaseUrl).toThrow(/publicBaseUrl/);
	});

	it('signs content-length (and content-type) into presigned PUTs', () => {
		const storage = createS3Storage({ descriptor, websiteId: WEBSITE, slug: 'reviews', send: noSend, now: () => AWS_NOW });
		const put = storage.presignPut({ key: 'photos/p1', contentType: 'image/jpeg', contentLength: 48_211 });
		expect(put).toMatchObject({
			method: 'PUT',
			key: 'photos/p1',
			headers: { 'content-type': 'image/jpeg', 'content-length': '48211' },
		});
		const url = new URL(put.url);
		expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
		expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
		// the signature binds the size: another length signs differently
		const other = storage.presignPut({ key: 'photos/p1', contentType: 'image/jpeg', contentLength: 48_212 });
		expect(new URL(other.url).searchParams.get('X-Amz-Signature')).not.toBe(url.searchParams.get('X-Amz-Signature'));
		for (const contentLength of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10']) {
			expect(() =>
				storage.presignPut({ key: 'k', contentType: 'image/png', contentLength: /** @type {any} */ (contentLength) }),
			).toThrow(/contentLength/);
		}
		for (const contentType of ['', 'image', 'text/plain\r\nx-evil: 1', 42]) {
			expect(() => storage.presignPut({ key: 'k', contentType: /** @type {any} */ (contentType), contentLength: 1 })).toThrow(
				/contentType/,
			);
		}
	});

	it('a presigned PUT always fixes the type and the size, and lives only a few minutes', () => {
		const storage = createS3Storage({ descriptor, websiteId: WEBSITE, slug: 'reviews', send: noSend, now: () => AWS_NOW });
		// a caller that forgets the type or the size gets an error, never a link that takes any type or size
		expect(() => storage.presignPut({ key: 'k', contentLength: 1 })).toThrow(/contentType/);
		expect(() => storage.presignPut({ key: 'k', contentType: 'image/png' })).toThrow(/contentLength/);
		expect(() => storage.presignPut(/** @type {any} */ ({ key: 'k' }))).toThrow(/contentType/);
		const link = (/** @type {number | undefined} */ expiresIn) =>
			storage.presignPut({ key: 'k', contentType: 'image/png', contentLength: 1, expiresIn });
		expect(new URL(link(undefined).url).searchParams.get('X-Amz-Expires')).toBe('300');
		expect(new URL(link(MAX_UPLOAD_SECONDS).url).searchParams.get('X-Amz-Expires')).toBe(String(MAX_UPLOAD_SECONDS));
		expect(MAX_UPLOAD_SECONDS).toBe(600);
		for (const expiresIn of [MAX_UPLOAD_SECONDS + 1, 3600, 7 * 24 * 3600, 0, 1.5]) {
			expect(() => link(expiresIn), String(expiresIn)).toThrow(/expiresIn/);
		}
		// a download link may still live longer: only uploads are capped
		expect(new URL(storage.presignGet({ key: 'k', expiresIn: 3600 }).url).searchParams.get('X-Amz-Expires')).toBe('3600');
	});

	it('supports custom endpoints (path and virtual-hosted style)', () => {
		const path = createS3Storage({
			descriptor: { ...descriptor, endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto' },
			websiteId: WEBSITE,
			slug: 's',
			send: noSend,
			now: () => 0,
		});
		expect(path.presignGet({ key: 'k' }).url.startsWith('https://acc.r2.cloudflarestorage.com/merchant-bucket/site/s/')).toBe(
			true,
		);
		const vhost = createS3Storage({
			descriptor: { ...descriptor, endpoint: 'https://storage.example.com', forcePathStyle: false },
			websiteId: WEBSITE,
			slug: 's',
			send: noSend,
			now: () => 0,
		});
		expect(vhost.presignGet({ key: 'k' }).url.startsWith('https://merchant-bucket.storage.example.com/site/s/')).toBe(true);
		const aws = createS3Storage({
			descriptor: { ...descriptor, forcePathStyle: true },
			websiteId: WEBSITE,
			slug: 's',
			send: noSend,
			now: () => 0,
		});
		expect(aws.presignGet({ key: 'k' }).url.startsWith('https://s3.eu-central-1.amazonaws.com/merchant-bucket/')).toBe(true);
		expect(() =>
			createS3Storage({
				descriptor: { ...descriptor, endpoint: 'http://storage.example.com' },
				websiteId: WEBSITE,
				slug: 's',
				send: noSend,
				now: () => 0,
			}),
		).toThrow();
		const local = { ...descriptor, endpoint: 'http://localhost:9000' };
		expect(() => createS3Storage({ descriptor: local, websiteId: WEBSITE, slug: 's', send: noSend, now: () => 0 })).toThrow(
			/internal_name/,
		);
		expect(
			createS3Storage({ descriptor: local, websiteId: WEBSITE, slug: 's', send: noSend, now: () => 0, policy: devPolicy })
				.bucket,
		).toBe('merchant-bucket');
		for (const endpoint of ['https://169.254.169.254', 'https://10.0.0.1:9000', 'https://minio.internal']) {
			expect(() =>
				createS3Storage({
					descriptor: { ...descriptor, endpoint },
					websiteId: WEBSITE,
					slug: 's',
					send: noSend,
					now: () => 0,
				}),
			).toThrow(/storage endpoint refused/);
		}
		expect(() =>
			createS3Storage({ descriptor: { bucket: 'b' }, websiteId: WEBSITE, slug: 's', send: noSend, now: () => 0 }),
		).toThrow(/region/);
	});

	it('refuses a bucket or region that is not a real name, so a delivered value cannot change the host or path of a link (SR-1-13)', () => {
		const make = (/** @type {Record<string, unknown>} */ change) =>
			createS3Storage({ descriptor: { ...descriptor, ...change }, websiteId: WEBSITE, slug: 's', send: noSend, now: () => 0 });
		/** @param {Record<string, unknown>} change */
		const refused = (change) => {
			try {
				make(change);
			} catch (error) {
				return /** @type {{ code: string, message: string }} */ (error);
			}
			return null;
		};
		for (const bucket of ['abc', 'my.bucket-1', 'a'.repeat(63)]) expect(make({ bucket }).bucket).toBe(bucket);
		for (const region of ['auto', 'eu-central-1', 'a', 'a'.repeat(32)]) expect(make({ region }).bucket).toBe('merchant-bucket');
		const buckets = [
			'evil.example/x?',
			'a?x=1',
			'a#b',
			'a@b',
			'a:80',
			'bu cket',
			'a_b_c',
			'Bucket',
			'ab',
			'-abc',
			'abc-',
			'a'.repeat(64),
			'a\nb',
		];
		for (const bucket of buckets) {
			expect(refused({ bucket }), bucket).toMatchObject({
				code: 'connection_invalid',
				message: expect.stringMatching(/bucket name/),
			});
		}
		const regions = ['eu/west', 'EU-West', 'us east', 'a.b', 'x?', 'a_b', 'a'.repeat(33), 'r\n'];
		for (const region of regions) {
			expect(refused({ region }), region).toMatchObject({
				code: 'connection_invalid',
				message: expect.stringMatching(/region name/),
			});
		}
	});

	it('heads and deletes objects with signed requests', async () => {
		/** @type {Array<{ url: string, init: any }>} */
		const seen = [];
		const statuses = [200, 404, 500, 204, 404, 403];
		const send = sendWith((url, init) => {
			seen.push({ url, init });
			return {
				status: /** @type {number} */ (statuses.shift()),
				headers: { 'content-length': '12', 'content-type': 'image/png', etag: '"e"' },
			};
		});
		const storage = createS3Storage({ descriptor, websiteId: WEBSITE, slug: 's', send, now: () => AWS_NOW });
		expect(await storage.headObject({ key: 'k' })).toEqual({ exists: true, size: 12, contentType: 'image/png', etag: '"e"' });
		expect(await storage.headObject({ key: 'k' })).toEqual({ exists: false });
		await expect(storage.headObject({ key: 'k' })).rejects.toMatchObject({ code: 'upstream_error' });
		expect(await storage.deleteObject({ key: 'k' })).toEqual({ deleted: true });
		expect(await storage.deleteObject({ key: 'k' })).toEqual({ deleted: true });
		await expect(storage.deleteObject({ key: 'k' })).rejects.toMatchObject({ code: 'upstream_error' });
		expect(seen[0]?.init.method).toBe('HEAD');
		expect(seen[0]?.init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA/);
		expect(seen[0]?.init.headers['x-amz-date']).toBe('20130524T000000Z');
		const bare = createS3Storage({
			descriptor,
			websiteId: WEBSITE,
			slug: 's',
			send: sendWith(() => ({ status: 200 })),
			now: () => 0,
		});
		expect(await bare.headObject({ key: 'k' })).toEqual({ exists: true, size: 0, contentType: undefined, etag: undefined });
	});

	it('maps outbound failures without leaking credentials', async () => {
		/** @param {any} error */
		const failing = (error) => async () => {
			throw error;
		};
		const timeout = createS3Storage({
			descriptor,
			websiteId: WEBSITE,
			slug: 's',
			send: failing(netError('timeout', 'deadline', 'slow')),
			now: () => 0,
		});
		await expect(timeout.headObject({ key: 'k' })).rejects.toMatchObject({ code: 'timeout' });
		const blocked = createS3Storage({
			descriptor,
			websiteId: WEBSITE,
			slug: 's',
			send: failing(netError('ssrf_blocked', 'private_address', 'refused')),
			now: () => 0,
		});
		const error = await blocked.deleteObject({ key: 'k' }).catch((e) => e);
		expect(error).toMatchObject({ code: 'upstream_error', details: { reason: 'ssrf_blocked' } });
		expect(JSON.stringify(error.details)).not.toContain(AWS.secretAccessKey);
		const plain = createS3Storage({ descriptor, websiteId: WEBSITE, slug: 's', send: failing(new Error('x')), now: () => 0 });
		await expect(plain.headObject({ key: 'k' })).rejects.toMatchObject({ code: 'upstream_error', details: {} });
	});
});
