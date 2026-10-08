// @vitest-environment jsdom
/* global window */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountCompare } from '../ui/compare.js';
import { toggleCompare } from '../ui/shop-compare-store.js';
import { mountWishlist } from '../ui/wishlist.js';
import {
	$,
	$$,
	TEXTS,
	buttonOf,
	click,
	configOf,
	fail,
	flush,
	makeShop,
	ok,
	place,
	resetPage,
	text,
	textOf,
} from './ui-shop-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

/** @param {string} id @param {Record<string, unknown>} [over] */
const card = (id, over = {}) => ({
	id,
	name: `Item ${id}`,
	slug: id,
	url: `https://shop.example.com/products/${id}`,
	image: `https://cdn.example.com/${id}.png`,
	price: 5000,
	priceText: 'PKR 50.00',
	compareAtPrice: 6000,
	currency: 'PKR',
	inStock: true,
	rating: { average: 5, count: 1 },
	...over,
});

describe('wishlist', () => {
	it('asks a guest to sign in, lists saved products, adds to the cart and removes', async () => {
		let items = [card('prd_1'), card('prd_2', { inStock: false })];
		let refuse = false;
		const fake = makeShop({
			features: ['wishlist', 'checkout'],
			routes: {
				'GET /v1/shop/wishlist': () => ok({ items, max: 200 }),
				'DELETE /v1/shop/wishlist/items/prd_1': () => {
					if (refuse) return fail(500, 'internal_error');
					items = items.filter((item) => item.id !== 'prd_1');
					return ok({ items, max: 200 });
				},
			},
		});
		const host = place('wishlist');
		await mountWishlist({ host, config: configOf(['wishlist', 'checkout']), shop: fake.shop, win: window });
		await flush();
		expect(textOf(host)).toContain(text('wishlist.signIn'));
		fake.identify('s1');
		await flush();
		expect($$(host, 'li.card')).toHaveLength(2);
		expect(textOf(host)).toContain(text('shop.outOfStock'));
		await click(buttonOf(host, text('wishlist.addToCartLabel', { name: 'Item prd_1' })));
		expect(fake.cart.state().lines).toEqual([{ productId: 'prd_1', variantId: null, quantity: 1 }]);
		expect(textOf(host)).toContain(text('page.addedStatus', { name: 'Item prd_1' }));
		refuse = true;
		await click(buttonOf(host, text('wishlist.removeLabel', { name: 'Item prd_1' })));
		expect(textOf(host)).toContain(text('wishlist.failed'));
		refuse = false;
		await click(buttonOf(host, text('wishlist.removeLabel', { name: 'Item prd_1' })));
		expect($$(host, 'li.card')).toHaveLength(1);
		items = [];
		fake.identify('s2');
		await flush();
		expect(textOf(host)).toContain(text('wishlist.empty'));
	});

	it('shows an error and has no Add to cart without the cart', async () => {
		let broken = true;
		const fake = makeShop({
			signIn: 's1',
			features: ['wishlist'],
			routes: {
				'GET /v1/shop/wishlist': () => (broken ? fail(500, 'internal_error') : ok({ items: [card('prd_1')], max: 200 })),
			},
		});
		const host = place('wishlist');
		await mountWishlist({ host, config: configOf(['wishlist']), shop: fake.shop, win: window });
		await flush();
		expect(textOf(host)).toContain(text('wishlist.error'));
		broken = false;
		fake.identify('s2');
		await flush();
		expect(() => buttonOf(host, text('wishlist.addToCart'))).toThrow();
	});
});

describe('compare', () => {
	const answer = {
		products: [
			{ ...card('prd_1'), brand: 'Acme', grades: ['Like new'] },
			{ ...card('prd_2', { image: null, rating: { average: 0, count: 0 }, inStock: false }), brand: null, grades: [] },
		],
		rows: [
			{ attributeId: 'atr_1', name: 'Screen', unit: 'in', values: [6.1, null] },
			{ attributeId: 'atr_2', name: '5G', unit: '', values: [true, false] },
			{ attributeId: 'atr_3', name: 'Chip', unit: '', values: ['X1', 'X2'] },
		],
	};

	it('compares the products picked in the browser, removes and clears', async () => {
		let reply = ok(answer);
		const fake = makeShop({ features: ['compare'], routes: { 'GET /v1/shop/compare': () => reply } });
		const host = place('compare');
		await mountCompare({ host, config: configOf(['compare'], { compare: { max: 3 } }), shop: fake.shop, win: window });
		await flush();
		expect(textOf(host)).toContain(text('compare.empty'));
		expect(buttonOf(host, text('compare.clear')).hidden).toBe(true);
		toggleCompare(window, 'prd_1', 3);
		toggleCompare(window, 'prd_2', 3);
		await flush();
		expect(fake.calls.at(-1)?.query.ids).toBe('prd_1,prd_2');
		const page = textOf(host);
		for (const part of [
			'Item prd_1',
			'PKR 50.00',
			'PKR 60.00',
			'Acme',
			'Like new',
			text('compare.noRating'),
			text('compare.withUnit', { name: 'Screen', unit: 'in' }),
			'6.1',
			'—',
			text('shop.yes'),
			text('shop.no'),
			'X2',
			text('page.outOfStock'),
		])
			expect(page).toContain(part);
		expect($$(host, 'thead th')).toHaveLength(2);
		reply = ok({ products: [answer.products[1]], rows: [] });
		await click(buttonOf(host, text('compare.removeLabel', { name: 'Item prd_1' })));
		expect(textOf(host)).toContain(text('compare.addMore'));
		reply = fail(500, 'internal_error');
		toggleCompare(window, 'prd_3', 3);
		await flush();
		expect(textOf(host)).toContain(text('compare.error'));
		expect($(host, 'table')).toBeNull();
		await click(buttonOf(host, text('compare.clear')));
		expect(textOf(host)).toContain(text('compare.empty'));
	});
});

describe('texts', () => {
	it('has an English text for every key the shopper widgets use', () => {
		const files = [
			'product-grid',
			'product-page',
			'cart',
			'my-orders',
			'wishlist',
			'compare',
			'shop-common',
			'shop-checkout',
			'shop-reviews',
			'shop-returns',
			'shop-slots',
		];
		const source = files.map((name) => readFileSync(join(import.meta.dirname, '..', 'ui', `${name}.js`), 'utf8')).join('\n');
		const used = [
			...source.matchAll(
				/'((?:grid|page|cart|checkout|success|orders|returns|reviews|wishlist|compare|alerts|shop)\.[A-Za-z0-9_.]*[A-Za-z0-9_])'/g,
			),
		].map((match) => String(match[1]));
		const dynamic = [
			...['newest', 'price_asc', 'price_desc', 'top', 'rating', 'name'].map((key) => `grid.sort.${key}`),
			...['name', 'phone', 'line1', 'line2', 'city', 'area', 'postalCode', 'country', 'notes'].map(
				(key) => `checkout.field.${key}`,
			),
			...['cod', 'online', 'bank_transfer', 'pickup'].map((key) => `checkout.method.${key}`),
			...['shipping', 'returns', 'privacy', 'terms'].map((key) => `checkout.policy.${key}`),
			...['unpaid', 'pending', 'paid', 'partially_refunded', 'refunded'].map((key) => `orders.payment.${key}`),
			...['return', 'warranty'].map((key) => `returns.kind.${key}`),
			...['requested', 'approved', 'rejected', 'received', 'refunded', 'closed'].map((key) => `returns.status.${key}`),
			...[
				'unavailable',
				'choose_variant',
				'out_of_stock',
				'not_enough_stock',
				'slot_required',
				'slot_unavailable',
				'slot_taken',
				'one_per_slot',
			].map((key) => `cart.problem.${key}`),
		];
		const missing = [...used, ...dynamic].filter((key) => !Object.hasOwn(TEXTS, key));
		expect(missing).toEqual([]);
	});
});
