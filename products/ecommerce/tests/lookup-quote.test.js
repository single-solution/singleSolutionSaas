/**
 * Chat's deal lookups: a product's price after active deals and the list of active deals. Promotions pricing
 * (`applyPromotions`, `loadOffers`) is the promotions part's, so it is replaced here by a fixed answer: these tests
 * check what the lookups send it and how they shape its result.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { readyShop } from './helpers.js';

const offers = vi.hoisted(() => ({
	deals: [
		{ id: 'deal_1', name: 'Autumn sale', description: '10% off phones', endsAt: new Date('2026-11-01T00:00:00Z') },
		{ id: 'deal_2', name: 'Always on', description: '', endsAt: null },
	],
	/** @type {any[]} */
	seen: [],
	discount: 1500,
}));

vi.mock('../adapters/promotions-store.js', async (importOriginal) => ({
	.../** @type {object} */ (await importOriginal()),
	loadOffers: async (/** @type {any} */ _data, /** @type {any} */ options) => {
		offers.seen.push({ loadOffers: options });
		return { deals: offers.deals, bundles: [], coupon: null };
	},
}));

vi.mock('../core/promotions.js', async (importOriginal) => ({
	.../** @type {object} */ (await importOriginal()),
	applyPromotions: (/** @type {any} */ input) => {
		offers.seen.push({ applyPromotions: input });
		return {
			lines: input.lines.map((/** @type {any} */ line) => ({
				key: line.key,
				dealId: 'deal_1',
				dealDiscount: offers.discount,
				bundleDiscount: 0,
				couponDiscount: 0,
			})),
			dealIds: offers.discount > 0 ? ['deal_1', 'deal_unknown'] : [],
			bundleIds: [],
			couponId: null,
			couponCode: '',
			freeDelivery: false,
			couponProblem: null,
			applied: [],
		};
	},
}));

describe('Chat deal lookups', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	/** @type {import('../core/model.js').ProductRecord} */
	let phone;

	beforeAll(async () => {
		shop = await readyShop();
		const data = await shop.db();
		await data.collection(COLLECTIONS.categories).insertOne({
			id: 'cat_child',
			slug: 'child',
			name: 'Child',
			parentId: 'cat_root',
			path: ['cat_root'],
			description: '',
			seo: { title: '', description: '' },
			image: null,
			sort: 0,
		});
		phone = await shop.seedProduct({ slug: 'phone', price: 10000, categoryIds: ['cat_child'], brandId: 'brd_1' });
	});
	afterAll(async () => shop.product.close());

	it('quotes a product after active deals', async () => {
		const answer = await shop.api('GET', '/v1/chat/products/phone/quote');
		expect(answer.status).toBe(200);
		expect(answer.json).toEqual({
			productId: phone.id,
			price: 10000,
			priceAfterDeals: 8500,
			savings: 1500,
			currency: 'USD',
			deals: ['Autumn sale'],
		});
		const priced = offers.seen.find((entry) => entry.applyPromotions)?.applyPromotions;
		expect(priced.lines).toEqual([
			{
				key: `${phone.id}|${phone.variants[0]?.id}`,
				productId: phone.id,
				variantId: phone.variants[0]?.id,
				categoryIds: ['cat_child', 'cat_root'],
				brandId: 'brd_1',
				unitPrice: 10000,
				quantity: 1,
			},
		]);
		expect(priced).toMatchObject({ bundles: [], coupon: null, couponCode: '' });
		expect(offers.seen.find((entry) => entry.loadOffers)?.loadOffers).toMatchObject({ deals: true, bundles: false });

		offers.discount = 99_999;
		expect((await shop.api('GET', `/v1/chat/products/${phone.id}/quote`)).json).toMatchObject({
			priceAfterDeals: 0,
			savings: 10000,
		});
		offers.discount = 0;
		expect((await shop.api('GET', `/v1/chat/products/${phone.id}/quote`)).json).toMatchObject({
			priceAfterDeals: 10000,
			savings: 0,
			deals: [],
		});
		expect((await shop.api('GET', '/v1/chat/products/nothing/quote')).status).toBe(404);
	});

	it('quotes a product without active variants at its listed price', async () => {
		const bare = await shop.seedProduct({ slug: 'bare', price: 700, variants: [] });
		const answer = await shop.api('GET', `/v1/chat/products/${bare.id}/quote`);
		expect(answer.json).toMatchObject({ price: 0, priceAfterDeals: 0, savings: 0, deals: [] });
	});

	it('lists active deals', async () => {
		const answer = await shop.api('GET', '/v1/chat/deals?limit=10');
		expect(answer.json).toEqual({
			items: [
				{ id: 'deal_1', name: 'Autumn sale', description: '10% off phones', endsAt: '2026-11-01T00:00:00.000Z' },
				{ id: 'deal_2', name: 'Always on', description: '', endsAt: null },
			],
		});
		expect((await shop.api('GET', '/v1/chat/deals?limit=1')).json.items).toHaveLength(1);
	});
});
