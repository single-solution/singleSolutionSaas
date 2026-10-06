/** Crawled sources through the API and the dashboard (no schedule): JSON feeds, sitemaps (and indexes), limits, failures, stale removal. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, HOUR, WEBSITE, createHarness } from './harness.js';

const BASE = 'https://shop.example.com';
const SOURCES = [
	{
		key: 'feed',
		kind: 'json',
		url: `${BASE}/feed.json`,
		type: 'item',
		every_hours: 6,
		records_path: 'products',
		fields: [{ field: 'title', path: 'name' }],
	},
	{ key: 'help', kind: 'sitemap', url: `${BASE}/sitemap.xml`, type: 'page' },
	{ key: 'evil', kind: 'sitemap', url: 'https://other.example.org/sitemap.xml', type: 'page' },
];
const page = (/** @type {string} */ title, extra = '') =>
	`<html><head><title>${title}</title><meta name="description" content="About ${title}">${extra}</head><body><main><h1>${title}</h1><p>Body of ${title}.</p></main></body></html>`;

describe('crawled sources', () => {
	/** @type {Awaited<ReturnType<typeof createHarness>>} */
	let h;
	beforeAll(async () => {
		h = await createHarness({ config: { sources: { crawl_sources: SOURCES, pages_per_run: 2, max_pages: 10 } } });
		h.site.pages.set(`${BASE}/feed.json`, {
			type: 'application/json',
			body: JSON.stringify({
				products: [
					{ id: 'p1', name: 'Linen shirt', url: '/p1', price: 4900, currency: 'EUR' },
					{ id: 'p2', name: 'Wool hat' },
					{ nope: true },
				],
			}),
		});
		h.site.pages.set(`${BASE}/sitemap.xml`, {
			type: 'application/xml',
			body: `<sitemapindex><sitemap><loc>${BASE}/s1.xml</loc></sitemap><sitemap><loc>${BASE}/missing.xml</loc></sitemap></sitemapindex>`,
		});
		h.site.pages.set(`${BASE}/s1.xml`, {
			type: 'application/xml',
			body: `<urlset><url><loc>${BASE}/returns</loc></url><url><loc>${BASE}/care</loc></url><url><loc>${BASE}/secret</loc></url><url><loc>https://elsewhere.com/x</loc></url><url><loc>${BASE}/gone</loc></url></urlset>`,
		});
		h.site.pages.set(`${BASE}/returns`, { body: page('Returns') });
		h.site.pages.set(`${BASE}/care`, { body: page('Linen care') });
		h.site.pages.set(`${BASE}/secret`, { body: page('Secret', '<meta name="robots" content="noindex">') });
	});
	afterAll(async () => h.close());

	it('lists sources with refused ones and their reason', async () => {
		const list = await h.call('GET', '/v1/sources');
		expect(list.json.catalog).toEqual({ enabled: true, type: 'item' });
		expect(list.json.items.map((/** @type {any} */ s) => [s.key, s.allowed, s.reason])).toEqual([
			['feed', true, null],
			['help', true, null],
			['evil', false, 'url_not_allowed'],
		]);
		expect((await h.call('POST', '/v1/sources/evil/crawl')).json.type).toMatch(/source_not_allowed$/);
		expect((await h.call('POST', '/v1/sources/nope/crawl')).status).toBe(404);
		expect((await h.call('GET', '/v1/sources', { key: h.pk })).status).toBe(403);
	});

	it('crawls a JSON feed through the guarded fetch and maps records', async () => {
		const crawled = await h.call('POST', '/v1/sources/feed/crawl');
		expect(crawled.json.crawl).toMatchObject({ status: 'ok', total: 3, indexed: 2, failed: 1 });
		const request = h.site.requests.find((r) => r.url === `${BASE}/feed.json`);
		expect(request?.init).toMatchObject({
			method: 'GET',
			timeoutMs: 10_000,
			maxBytes: 2048 * 1024,
			headers: { accept: 'application/json' },
		});
		expect((await h.call('GET', '/v1/search?q=linen', { key: h.pk })).json.items[0]).toMatchObject({
			id: 'feed:p1',
			price: 4900,
			url: '/p1',
		});
		expect(h.site.requests.some((r) => r.url.includes('other.example.org'))).toBe(false);
	});

	it('crawls a sitemap index over several steps, honours noindex and stays on the domain', async () => {
		// a request whose time budget is spent runs one step; the next request continues the same run
		const site = /** @type {any} */ (await h.search.siteFor(WEBSITE));
		const first = await h.search.sources.crawlNow(site, 'help', { deadline: h.clock.now() });
		expect(first.ok && first.value?.crawl).toMatchObject({ status: 'running', total: 4, processed: 2 });
		const run = (await h.collection('crawls').findOne({ websiteId: WEBSITE, key: 'help' }))?.run;
		const second = await h.call('POST', '/v1/sources/help/crawl');
		expect(second.json.crawl).toMatchObject({ status: 'ok', processed: 4 });
		expect((await h.collection('crawls').findOne({ websiteId: WEBSITE, key: 'help' }))?.run).toBe(run);
		const state = (await h.call('GET', '/v1/sources')).json.items.find((/** @type {any} */ s) => s.key === 'help');
		expect(state.crawl).toMatchObject({ status: 'ok', processed: 4, indexed: 2, failed: 1 });
		expect(h.site.requests.some((r) => r.url.startsWith('https://elsewhere.com'))).toBe(false);
		const hit = (await h.call('GET', '/v1/search?q=care', { key: h.pk })).json.items[0];
		expect(hit).toMatchObject({ type: 'page', title: 'Linen care', description: 'About Linen care', url: `${BASE}/care` });
		expect((await h.call('GET', '/v1/search?q=secret', { key: h.pk })).json.items).toEqual([]);
	});

	it('removes documents a finished run did not see, and records failures', async () => {
		h.site.pages.set(`${BASE}/feed.json`, {
			type: 'application/json',
			body: JSON.stringify({ products: [{ id: 'p2', name: 'Wool hat' }] }),
		});
		await h.call('POST', '/v1/sources/feed/crawl');
		const ids = (await h.collection('documents').find({ websiteId: WEBSITE, source: 'crawl:feed' }).toArray()).map(
			(/** @type {any} */ d) => d.id,
		);
		expect(ids).toEqual(['feed:p2']);
		expect(
			(await h.call('GET', '/v1/search?q=linen%20shirt', { key: h.pk })).json.items.map((/** @type {any} */ i) => i.id),
		).not.toContain('feed:p1');
		h.site.pages.set(`${BASE}/feed.json`, { type: 'application/json', body: '{ broken' });
		expect((await h.call('POST', '/v1/sources/feed/crawl')).json.crawl).toMatchObject({
			status: 'failed',
			error: 'json_invalid',
		});
		h.site.pages.set(`${BASE}/feed.json`, { status: 500, body: '' });
		expect((await h.call('POST', '/v1/sources/feed/crawl')).json.crawl.error).toBe('http_500');
		h.site.pages.set(`${BASE}/feed.json`, { status: 599, body: '' });
		expect((await h.call('POST', '/v1/sources/feed/crawl')).json.crawl.error).toBe('timeout');
		h.site.pages.delete(`${BASE}/sitemap.xml`);
		expect((await h.call('POST', '/v1/sources/help/crawl')).json.crawl).toMatchObject({ status: 'failed', error: 'http_404' });
	});

	it('crawls due sources from the dashboard only when their interval passed', async () => {
		h.site.pages.set(`${BASE}/feed.json`, {
			type: 'application/json',
			body: JSON.stringify({ products: [{ id: 'p9', name: 'Scarf' }] }),
		});
		h.site.pages.set(`${BASE}/sitemap.xml`, { type: 'application/xml', body: '<urlset></urlset>' });
		const before = h.site.requests.length;
		const none = await h.call('POST', '/v1/dashboard/crawl-due', { key: await h.session('merchant') });
		expect(none.json).toEqual({ crawled: 0 });
		expect(h.site.requests.length).toBe(before);
		h.clock.advance(DAY + HOUR);
		const merchant = await h.session('merchant');
		expect((await h.call('POST', '/v1/dashboard/crawl-due', { key: merchant })).json).toEqual({ crawled: 2 });
		const list = (await h.call('GET', '/v1/sources')).json.items;
		expect(list.find((/** @type {any} */ s) => s.key === 'help').crawl).toMatchObject({ status: 'ok', total: 0 });
		expect(list.find((/** @type {any} */ s) => s.key === 'feed').crawl).toMatchObject({ status: 'ok', indexed: 1 });
		expect((await h.call('POST', '/v1/dashboard/sources/feed/crawl', { key: merchant })).status).toBe(200);
		// no website in a demo session; a spent time budget starts nothing
		expect((await h.call('POST', '/v1/dashboard/crawl-due', { key: await h.session('demo') })).status).toBe(403);
		h.clock.advance(DAY + HOUR);
		const site = /** @type {any} */ (await h.search.siteFor(WEBSITE));
		expect(await h.search.sources.runDue(site, { deadline: h.clock.now() })).toEqual({ crawled: 0 });
		await h.entitle({ config: { sources: { crawl_sources: SOURCES } }, elements: { sources: false } });
		const off = /** @type {any} */ (await h.search.siteFor(WEBSITE));
		expect(await h.search.sources.runDue(off)).toEqual({ crawled: 0 });
	});
});
