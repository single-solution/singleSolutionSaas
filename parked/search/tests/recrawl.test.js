/** No schedule: a Catalog item event re-crawls that item's page where a sitemap source indexed it (and nothing else). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEBSITE, createHarness } from './harness.js';

const BASE = 'https://shop.example.com';
const SOURCES = [{ key: 'pages', kind: 'sitemap', url: `${BASE}/sitemap.xml`, type: 'page' }];
const SOURCE_CONFIG = { crawl_sources: SOURCES, catalog_url_template: '/items/{itemId}' };
const page = (/** @type {string} */ title, extra = '') =>
	`<html><head><title>${title}</title>${extra}</head><body><main><h1>${title}</h1></main></body></html>`;
const ITEMS = ['itm_1', 'itm_2', 'itm_3', 'itm_4', 'itm_5', 'itm_6'];

describe('item page re-crawl on Catalog events', () => {
	/** @type {Awaited<ReturnType<typeof createHarness>>} */
	let h;
	beforeAll(async () => {
		h = await createHarness({ config: { sources: SOURCE_CONFIG } });
		h.site.pages.set(`${BASE}/sitemap.xml`, {
			type: 'application/xml',
			body: `<urlset>${ITEMS.map((id) => `<url><loc>${BASE}/items/${id}</loc></url>`).join('')}</urlset>`,
		});
		for (const id of ITEMS) h.site.pages.set(`${BASE}/items/${id}`, { body: page(`Page ${id}`) });
		const crawled = await h.call('POST', '/v1/sources/pages/crawl');
		expect(crawled.json.crawl).toMatchObject({ status: 'ok', indexed: ITEMS.length });
	});
	afterAll(async () => h.close());

	/** @param {string} id */
	const pageDoc = (id) =>
		h.collection('documents').findOne({ websiteId: WEBSITE, source: 'crawl:pages', url: `${BASE}/items/${id}` });
	/** @param {string} id */
	const fetches = (id) => h.site.requests.filter((r) => r.url === `${BASE}/items/${id}`).length;
	/** @param {string} id @param {Record<string, unknown>} [extra] */
	const updated = (id, extra = {}) =>
		h.deliver('item.updated@1', { itemId: id, title: `Item ${id}`, status: 'active', ...extra });

	it('fetches the named item page again when its item event arrives', async () => {
		const before = await pageDoc('itm_1');
		h.site.pages.set(`${BASE}/items/itm_1`, { body: page('Linen shirt, new') });
		expect((await updated('itm_1')).status).toBe(200);
		expect(fetches('itm_1')).toBe(2);
		const after = await pageDoc('itm_1');
		expect(after?.fields.title).toBe('Linen shirt, new');
		expect(after?.crawlRun).toBe(before?.crawlRun);
		// the other pages are not touched
		expect(fetches('itm_2')).toBe(1);
	});

	it('removes the page when the item is deleted, gone (404) or noindex, keeps it on other failures', async () => {
		await h.deliver('item.deleted@1', { itemId: 'itm_2' });
		expect(await pageDoc('itm_2')).toBeNull();
		expect(fetches('itm_2')).toBe(1);
		h.site.pages.delete(`${BASE}/items/itm_3`);
		await updated('itm_3');
		expect(await pageDoc('itm_3')).toBeNull();
		h.site.pages.set(`${BASE}/items/itm_4`, { body: page('Hidden', '<meta name="robots" content="noindex">') });
		await updated('itm_4');
		expect(await pageDoc('itm_4')).toBeNull();
		h.site.pages.set(`${BASE}/items/itm_5`, { status: 500, body: '' });
		await updated('itm_5');
		expect(await pageDoc('itm_5')).not.toBeNull();
		h.site.pages.set(`${BASE}/items/itm_6`, { type: 'application/json', body: '{}' });
		await updated('itm_6');
		expect((await pageDoc('itm_6'))?.fields.title).toBe('Page itm_6');
	});

	it('fetches nothing for an item no source indexed, without a page template, or with sources off', async () => {
		const before = h.site.requests.length;
		await updated('itm_99');
		await h.deliver('item.updated@1', { title: 'No id' });
		await h.entitle({ config: { sources: { ...SOURCE_CONFIG, catalog_url_template: '' } } });
		await updated('itm_1');
		await h.entitle({ config: { sources: SOURCE_CONFIG }, elements: { sources: false } });
		await updated('itm_1');
		expect(h.site.requests.length).toBe(before);
		await h.entitle({ config: { sources: SOURCE_CONFIG } });
		const site = /** @type {any} */ (await h.search.siteFor(WEBSITE));
		expect(await h.search.sources.recrawlItemPage(site, 'item.updated@1', { itemId: 'itm_1' })).toEqual(['indexed']);
	});
});
