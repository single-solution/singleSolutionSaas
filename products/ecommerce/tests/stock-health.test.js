/**
 * Low stock by the merchant's level (PLAN E44): a sellable variant with 1 to `lowStock` units on a product that tracks
 * stock and is not archived drives the staff list's `lowStock=1`, its counts, and the variant counts by stock
 * (`counts?by=variantStock`) a dashboard or a bell shows.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffFilter, variantStockCounts } from '../core/catalog-query.js';
import { readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {string} */
let staff;

/**
 * A variant with its stock.
 * @param {number} stock @param {{ active?: boolean, soldOut?: boolean }} [more]
 */
const variant = (stock, { active = true, soldOut = false } = {}) => ({
	id: createId('var'),
	sku: '',
	options: {},
	price: 1000,
	compareAtPrice: null,
	cost: null,
	stock,
	locations: {},
	grade: null,
	active,
	...(soldOut ? { soldOut: true } : {}),
});

beforeAll(async () => {
	shop = await readyShop();
	staff = await shop.ticket(['catalog.edit']);
	await shop.seedProduct({ name: 'Stocky dress', variants: [variant(1), variant(2), variant(0), variant(5)] });
	await shop.seedProduct({ name: 'Stocky forced', variants: [variant(2, { soldOut: true })] });
	await shop.seedProduct({ name: 'Stocky archived', status: 'archived', variants: [variant(1)] });
	await shop.seedProduct({ name: 'Stocky service', trackStock: false, variants: [variant(1)] });
	await shop.seedProduct({ name: 'Stocky hidden size', variants: [variant(1, { active: false }), variant(9)] });
});

afterAll(async () => {
	await shop?.product.close();
});

describe('low stock (E44)', () => {
	it('builds the filter and the counts of variants', () => {
		expect(staffFilter({ lowStock: '1' }, { categoryIds: null, brandIds: null, lowStock: 2 })).toEqual({
			$and: [
				{
					trackStock: true,
					status: { $ne: 'archived' },
					variants: { $elemMatch: { active: true, soldOut: { $ne: true }, stock: { $gt: 0, $lte: 2 } } },
				},
			],
		});
		expect(
			variantStockCounts([
				{ _id: 'low', n: 2 },
				{ _id: 'other', n: 9 },
			]),
		).toEqual({ out: 0, low: 2, in: 0 });
	});

	it('counts sellable variants with 1 to lowStock units on products not archived', async () => {
		await shop.setting('catalog', 'lowStock', 2);
		const list = await shop.api('GET', '/v1/products?q=Stocky&lowStock=1');
		expect(list.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['Stocky dress']);
		expect((await shop.api('GET', '/v1/products/count?q=Stocky&lowStock=1')).json).toEqual({ count: 1, capped: false });
		expect((await shop.api('GET', '/v1/products/counts?q=Stocky&lowStock=1&by=status')).json).toEqual({
			total: 1,
			groups: { active: 1 },
		});
		// the dress: 1 and 2 low, 0 out, 5 in; the forced variant out; archived, untracked and offered-no-more left out
		expect((await shop.api('GET', '/v1/products/counts?q=Stocky&by=variantStock')).json).toEqual({
			total: 6,
			groups: { out: 2, low: 2, in: 2 },
		});
		expect((await shop.admin(staff, 'GET', '/v1/admin/products/counts?q=Stocky&by=variantStock')).json.groups.low).toBe(2);
	});

	it('finds nothing low at level 0', async () => {
		await shop.setting('catalog', 'lowStock', 0);
		expect((await shop.api('GET', '/v1/products/count?q=Stocky&lowStock=1')).json.count).toBe(0);
		expect((await shop.api('GET', '/v1/products/counts?q=Stocky&by=variantStock')).json).toEqual({
			total: 6,
			groups: { out: 2, in: 4 },
		});
		await shop.setting('catalog', 'lowStock', 3);
	});
});
