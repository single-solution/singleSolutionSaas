/**
 * Growth's reads of the merchant's site (`adapters/web.js`): never a redirect followed, the time and size limits, the
 * run's deadline, why a read failed, and at most a few reads at a time. The network is a function given to it.
 */
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PAGE_MAX_BYTES, READS_AT_ONCE, READ_TIMEOUT_MS, SITEMAP_MAX_BYTES, createWeb } from '../adapters/web.js';

/** @param {number} status @param {string} [body] @param {Record<string, string>} [headers] */
const response = (status, body = '', headers = {}) => ({ status, headers, body: Buffer.from(body), url: '' });

describe('reading the site', () => {
	it('reads without following redirects, within the time and size limits, and measures the time', async () => {
		/** @type {any[]} */
		const asked = [];
		let t = 1000;
		const web = createWeb({
			clock: () => t,
			send: async (url, init) => {
				asked.push({ url, init });
				t += 250;
				return response(301, '', { location: '/new' });
			},
		});
		expect(web.deadline(25_000)).toBe(26_000);
		expect(await web.read('https://shop.example.com/old')).toEqual({
			url: 'https://shop.example.com/old',
			status: 301,
			headers: { location: '/new' },
			body: '',
			ms: 250,
			error: null,
		});
		expect(asked[0].init).toMatchObject({ redirect: 'manual', timeoutMs: READ_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES });
		expect(asked[0].init.headers['user-agent']).toMatch(/^SingleSolution-Growth-SEO\//);
		// near the run's deadline: the read gets the time left, and none is asked once less than half a second is left
		await web.read('https://shop.example.com/sitemap.xml', { maxBytes: SITEMAP_MAX_BYTES, until: t + 3000 });
		expect(asked[1].init).toMatchObject({ timeoutMs: 3000, maxBytes: SITEMAP_MAX_BYTES });
		expect(await web.read('https://shop.example.com/late', { until: t + 499 })).toEqual({
			url: 'https://shop.example.com/late',
			status: null,
			headers: {},
			body: '',
			ms: null,
			error: 'time',
		});
		expect(asked).toHaveLength(2);
	});

	it('reads a gzipped file (a sitemap.xml.gz) as its text, within the size limit', async () => {
		const xml = '<urlset><url><loc>https://shop.example.com/a</loc></url></urlset>';
		/** @param {Buffer} body */
		const webOf = (body) => createWeb({ send: async () => ({ status: 200, headers: {}, body, url: '' }) });
		expect(await webOf(gzipSync(xml)).read('https://shop.example.com/sitemap.xml.gz')).toMatchObject({
			status: 200,
			body: xml,
		});
		// unpacked larger than the limit: too large, never unpacked in full
		const bomb = gzipSync(Buffer.alloc(SITEMAP_MAX_BYTES + 1, 32));
		expect(await webOf(bomb).read('https://shop.example.com/s.xml.gz', { maxBytes: SITEMAP_MAX_BYTES })).toMatchObject({
			status: null,
			error: 'too_large',
		});
		// bytes that only start like gzip stay as they are
		expect((await webOf(Buffer.from([0x1f, 0x8b, 0x41])).read('https://shop.example.com/x')).body).toBe('\u001f\ufffdA');
	});

	it('says why a read failed', async () => {
		/** @param {unknown} thrown */
		const failed = async (thrown) =>
			(
				await createWeb({
					send: async () => {
						throw thrown;
					},
				}).read('https://shop.example.com/')
			).error;
		expect(await failed({ code: 'timeout' })).toBe('timeout');
		expect(await failed({ code: 'too_large' })).toBe('too_large');
		expect(await failed({ code: 'ssrf_blocked' })).toBe('unreachable');
		expect(await failed(null)).toBe('unreachable');
		// an IndexNow submission that could not be sent
		const web = createWeb({
			send: async () => {
				throw new Error('down');
			},
		});
		expect(await web.indexNow({ host: 'shop.example.com', key: 'k', keyLocation: '', urlList: [] })).toEqual({
			ok: false,
			status: null,
		});
	});

	it('reads several addresses at most a few at a time, in the order asked', async () => {
		let running = 0;
		let most = 0;
		const web = createWeb({
			send: async (url) => {
				running += 1;
				most = Math.max(most, running);
				await new Promise((resolve) => setTimeout(resolve, 1));
				running -= 1;
				return response(200, url);
			},
		});
		const urls = Array.from({ length: 10 }, (_, i) => `https://shop.example.com/p${i}`);
		const reads = await web.readAll(urls);
		expect(reads.map((read) => read.body)).toEqual(urls);
		expect(most).toBe(READS_AT_ONCE);
		expect(await web.readAll([])).toEqual([]);
	});
});
