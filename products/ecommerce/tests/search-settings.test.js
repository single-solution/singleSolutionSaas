/**
 * Search settings of the re-audit (SF-10, SF-13): the shop's basic search matches every word (default) or the whole
 * phrase; Chat searches as the shop (default), or with its own mode.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchFilter } from '../core/catalog-query.js';
import { createCatalogSearch } from '../server/catalog-search.js';
import { ALL, readyShop } from './helpers.js';

describe('search modes (core)', () => {
	it('matches every word by default, or the phrase in the name or a SKU (SF-10)', () => {
		expect(searchFilter('13 pro')).toEqual(searchFilter('13 pro', 'words'));
		expect(searchFilter('  13   pro. ', 'phrase')).toEqual({
			$or: [
				{ name: { $regex: '13\\s+pro\\.', $options: 'i' } },
				{ 'variants.sku': { $regex: '13\\s+pro\\.', $options: 'i' } },
			],
		});
		expect(searchFilter(' ', 'phrase')).toBeNull();
	});

	it('sends Chat to Atlas by its own setting, else as the shop (SF-13)', async () => {
		const search = createCatalogSearch(/** @type {any} */ ({}));
		/** @param {Record<string, string>} catalog */
		const site = (catalog) => /** @type {any} */ ({ values: async () => catalog });
		expect(await search.useAtlas(site({ search: 'atlas', chatSearch: 'same' }), 'lamp', 'chat')).toBe(true);
		expect(await search.useAtlas(site({ search: 'atlas', chatSearch: 'basic' }), 'lamp', 'chat')).toBe(false);
		expect(await search.useAtlas(site({ search: 'atlas', chatSearch: 'basic' }), 'lamp')).toBe(true);
		expect(await search.useAtlas(site({ search: 'basic', chatSearch: 'atlas' }), 'lamp', 'chat')).toBe(true);
		expect(await search.useAtlas(site({ search: 'basic', chatSearch: 'atlas' }), 'lamp', 'shop')).toBe(false);
		expect(await search.useAtlas(site({ search: 'atlas' }), 'lamp', 'chat')).toBe(true);
		expect(await search.useAtlas(site({ search: 'atlas' }), '  ', 'chat')).toBe(false);
	});
});

describe('search settings through the API', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;

	/** @param {string} q */
	const names = async (q) =>
		(await shop.visitor('GET', `/v1/shop/products?q=${encodeURIComponent(q)}`)).json.items
			.map((/** @type {any} */ item) => item.name)
			.sort();

	beforeAll(async () => {
		shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
		for (const [name, sku] of [
			['iPhone 13 Pro', 'IP13P'],
			['iPad Pro 13-inch', 'IPAD-13'],
			['Phone case', 'CASE 13 PRO'],
		]) {
			const answer = await shop.api('POST', '/v1/products', { name, status: 'active', price: 1000, stock: 1, sku });
			if (answer.status !== 201) throw new Error(answer.text);
		}
	});
	afterAll(async () => shop.product.close());

	it('finds every word by default, the whole phrase with searchMatch phrase (SF-10)', async () => {
		expect(await names('13 pro')).toEqual(['Phone case', 'iPad Pro 13-inch', 'iPhone 13 Pro']);
		await shop.setting('catalog', 'searchMatch', 'phrase');
		expect(await names('13 pro')).toEqual(['Phone case', 'iPhone 13 Pro']);
		expect(await names('pro 13')).toEqual(['iPad Pro 13-inch']);
		await shop.setting('catalog', 'searchMatch', 'words');
	});

	it('shows the index on Overview when only Chat uses Atlas, and Chat answers with the basic search (SF-13)', async () => {
		const owner = await shop.adminSession();
		const path = `/v1/dashboard/websites/${shop.websiteId}/search-index`;
		expect((await shop.dashboard(owner, 'GET', path)).json.search).toBe('basic');
		await shop.setting('catalog', 'chatSearch', 'atlas');
		expect((await shop.dashboard(owner, 'GET', path)).json.search).toBe('atlas');
		expect((await shop.visitor('GET', '/v1/shop/products?q=ipad')).json.items).toHaveLength(1);
		expect(await shop.product.searchState.get(shop.websiteId)).toBeNull();
		const chat = await shop.api('GET', '/v1/chat/products?q=ipad');
		expect(chat.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['iPad Pro 13-inch']);
		expect(await shop.product.searchState.get(shop.websiteId)).toMatchObject({ missing: true });
	});
});
