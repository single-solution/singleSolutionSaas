/**
 * What ranks top products (parity P3-10): units sold (delivered orders; no setting changes it) for the listing's `top`
 * and `sold_asc` sorts and Chat's top products.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;

/** @param {string} query */
const names = async (query) =>
	(await shop.visitor('GET', `/v1/shop/products?q=Top&${query}`)).json.items.map((/** @type {any} */ item) => item.name);

beforeAll(async () => {
	shop = await readyShop();
	// A has delivered the most, B the fewest, C is in between
	await shop.seedProduct({ name: 'Top A', sold: 5 });
	await shop.seedProduct({ name: 'Top B', sold: 1 });
	await shop.seedProduct({ name: 'Top C', sold: 3 });
});
afterAll(async () => shop?.product.close());

describe('top products (P3-10)', () => {
	it('ranks by units sold', async () => {
		expect(await names('sort=top')).toEqual(['Top A', 'Top C', 'Top B']);
		expect(await names('sort=sold_asc')).toEqual(['Top B', 'Top C', 'Top A']);
		const top = (await shop.api('GET', '/v1/chat/products/top?kind=top&limit=3')).json.items;
		expect(top.map((/** @type {any} */ item) => item.name)).toEqual(['Top A', 'Top C', 'Top B']);
	});

	it('pages follow the same order, and so does the listing head', async () => {
		const first = (await shop.visitor('GET', '/v1/shop/products?q=Top&sort=top&limit=1')).json;
		expect(first.items.map((/** @type {any} */ item) => item.name)).toEqual(['Top A']);
		const next = await shop.visitor('GET', `/v1/shop/products?q=Top&sort=top&limit=2&cursor=${first.nextCursor}`);
		expect(next.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['Top C', 'Top B']);
		const head = (await shop.api('GET', '/v1/seo/listing?q=Top&sort=top')).json;
		expect(head.status).toBe(200);
	});

	it('no setting changes what ranks them', async () => {
		await expect(shop.setting('catalog', 'topBasis', 'sold')).rejects.toThrow(/404/);
	});
});
