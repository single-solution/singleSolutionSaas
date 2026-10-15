/**
 * A brand hidden in one category only (parity P3-12): the listings of the categories its `hiddenIn` names, and of those
 * below them, leave its products out (with their counts, facets and landing pages); its products stay on their own
 * pages, in search and in every other listing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {Record<string, any>} */
const ids = {};

/** @param {string} method @param {string} path @param {unknown} [body] */
const api = async (method, path, body) => {
	const answer = await shop.api(method, path, body);
	if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};
/** The names a listing shows. @param {string} query */
const names = async (query) =>
	(await shop.visitor('GET', `/v1/shop/products?${query}`)).json.items.map((/** @type {any} */ item) => item.name).sort();

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	ids.phones = await api('POST', '/v1/categories', { name: 'Phones' });
	ids.android = await api('POST', '/v1/categories', { name: 'Android', parentId: ids.phones.id });
	ids.cases = await api('POST', '/v1/categories', { name: 'Cases' });
	ids.acme = await api('POST', '/v1/brands', { name: 'Acme' });
	/** @param {string} name @param {string} categoryId @param {string | null} brandId */
	const product = (name, categoryId, brandId) =>
		api('POST', '/v1/products', { name, status: 'active', price: 1000, stock: 2, categoryIds: [categoryId], brandId });
	ids.acmePhone = await product('Acme phone', ids.android.id, ids.acme.id);
	await product('Acme case', ids.cases.id, ids.acme.id);
	await product('Plain phone', ids.android.id, null);
});
afterAll(async () => shop.product.close());

describe('a brand hidden in one category', () => {
	it('leaves its products out of that category’s listings and those below it, nowhere else', async () => {
		expect((await shop.api('PATCH', `/v1/brands/${ids.acme.id}`, { hiddenIn: ['cat_none'] })).status).toBe(422);
		const hidden = await api('PATCH', `/v1/brands/${ids.acme.id}`, { hiddenIn: [ids.phones.id] });
		expect(hidden.hiddenIn).toEqual([ids.phones.id]);
		expect(await names(`category=${ids.phones.slug}`)).toEqual(['Plain phone']);
		expect(await names(`category=${ids.android.slug}`)).toEqual(['Plain phone']);
		expect(await names(`category=${ids.cases.slug}`)).toEqual(['Acme case']);
		expect(await names('')).toEqual(['Acme case', 'Acme phone', 'Plain phone']);
		expect(await names('q=acme')).toEqual(['Acme case', 'Acme phone']);
		expect((await shop.visitor('GET', `/v1/shop/products/${ids.acmePhone.slug}`)).status).toBe(200);
		// the category's brand facet and count follow
		const listing = (await shop.visitor('GET', `/v1/shop/products?category=${ids.phones.slug}&count=1`)).json;
		expect(listing.total).toBe(1);
		// shown again once the brand is not hidden there
		await api('PATCH', `/v1/brands/${ids.acme.id}`, { hiddenIn: [] });
		expect(await names(`category=${ids.phones.slug}`)).toEqual(['Acme phone', 'Plain phone']);
	});
});
