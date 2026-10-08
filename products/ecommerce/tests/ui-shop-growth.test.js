// @vitest-environment jsdom
/* global window */
/**
 * Growth's browser events from the shopper widgets (PLAN 0.8.9): `ss:view_item` and `ss:add_to_cart` on the product
 * page, `ss:add_to_cart` from the wishlist, `ss:begin_checkout` and `ss:purchase` from the cart widget.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountCart } from '../ui/cart.js';
import { mountProductPage } from '../ui/product-page.js';
import { mountWishlist } from '../ui/wishlist.js';
import {
	$,
	buttonOf,
	click,
	configOf,
	fail,
	flush,
	growthEvents,
	handTimers,
	makeShop,
	ok,
	place,
	resetPage,
	setValue,
	text,
} from './ui-shop-helpers.js';

/** @type {ReturnType<typeof growthEvents>} */
let events;
beforeEach(() => {
	resetPage();
	events = growthEvents();
});
afterEach(() => {
	events.stop();
	resetPage();
});

const PRODUCT = {
	id: 'prd_1',
	slug: 'phone',
	name: 'Phone One',
	kind: 'physical',
	summary: '',
	description: '',
	price: 100000,
	compareAtPrice: null,
	currency: 'PKR',
	inStock: true,
	media: [],
	options: [{ name: 'Storage', values: ['128 GB', '256 GB'] }],
	variants: [
		{
			id: 'var_1',
			name: '128 GB',
			options: { Storage: '128 GB' },
			price: 100000,
			compareAtPrice: null,
			inStock: true,
			grade: null,
		},
		{
			id: 'var_2',
			name: '256 GB',
			options: { Storage: '256 GB' },
			price: 120000,
			compareAtPrice: null,
			inStock: true,
			grade: null,
		},
	],
	specs: [],
	brand: null,
	rating: { average: 0, count: 0 },
	booking: null,
};

describe('product page', () => {
	it('tells Growth the product was viewed once, and each add to the cart at the price shown', async () => {
		const fake = makeShop({
			features: ['catalog', 'checkout', 'deals'],
			routes: {
				'GET /v1/shop/products/phone': () => ok(PRODUCT),
				'GET /v1/shop/products/prd_1/quote': (call) =>
					ok({
						price: call.query.variantId === 'var_2' ? 120000 : 100000,
						priceAfterDeals: call.query.variantId === 'var_2' ? 110000 : 100000,
						savings: call.query.variantId === 'var_2' ? 10000 : 0,
						currency: 'PKR',
						deals: [],
					}),
			},
		});
		const host = place('product_page', { product: 'phone' });
		await mountProductPage({ host, config: configOf(['catalog']), shop: fake.shop, win: window });
		await flush();
		const viewed = { id: 'prd_1', variantId: 'var_1', name: 'Phone One', price: 100000, quantity: 1 };
		expect(events.of('ss:view_item')).toEqual([{ currency: 'PKR', value: 100000, items: [viewed] }]);
		await click(buttonOf(host, text('page.addToCart')));
		await setValue($(host, '#ss-page-option-0'), '256 GB');
		await setValue($(host, '#ss-page-qty'), '2');
		await click(buttonOf(host, text('page.addToCart')));
		expect(events.of('ss:view_item')).toHaveLength(1);
		expect(events.of('ss:add_to_cart')).toEqual([
			{ currency: 'PKR', value: 100000, items: [viewed] },
			{
				currency: 'PKR',
				value: 220000,
				items: [{ id: 'prd_1', variantId: 'var_2', name: 'Phone One', price: 110000, quantity: 2 }],
			},
		]);
	});

	it('tells Growth about a product without variants at its own price', async () => {
		const fake = makeShop({
			features: ['catalog'],
			routes: { 'GET /v1/shop/products/phone': () => ok({ ...PRODUCT, options: [], variants: [] }) },
		});
		const host = place('product_page', { product: 'phone' });
		await mountProductPage({ host, config: configOf(['catalog']), shop: fake.shop, win: window });
		await flush();
		expect(events.of('ss:view_item')).toEqual([
			{
				currency: 'PKR',
				value: 100000,
				items: [{ id: 'prd_1', variantId: null, name: 'Phone One', price: 100000, quantity: 1 }],
			},
		]);
	});
});

describe('wishlist', () => {
	it('tells Growth about Add to cart at the card’s price', async () => {
		const fake = makeShop({
			features: ['wishlist', 'checkout'],
			signIn: 's1',
			routes: {
				'GET /v1/shop/wishlist': () =>
					ok({
						items: [{ id: 'prd_1', name: 'Phone One', url: '', price: 5000, currency: 'USD', inStock: true }],
						max: 200,
					}),
			},
		});
		const host = place('wishlist');
		await mountWishlist({ host, config: configOf(['wishlist', 'checkout']), shop: fake.shop, win: window });
		await flush();
		await click(buttonOf(host, text('wishlist.addToCartLabel', { name: 'Phone One' })));
		expect(events.of('ss:add_to_cart')).toEqual([
			{
				currency: 'USD',
				value: 5000,
				items: [{ id: 'prd_1', variantId: null, name: 'Phone One', price: 5000, quantity: 1 }],
			},
		]);
	});
});

describe('cart', () => {
	const LINES = [
		{ productId: 'prd_1', variantId: 'var_1', name: 'Phone', unitPrice: 100000, quantity: 2 },
		{ productId: 'prd_2', variantId: null, name: 'Case', unitPrice: 1000, quantity: 1 },
	];
	const DELIVERY = { method: 'delivery', zone: 'z1', name: 'City', fee: 20000, locationId: null, minDays: 1, maxDays: 3 };
	const QUOTE = {
		currency: 'PKR',
		lines: LINES.map((line) => ({
			...line,
			kind: 'physical',
			discount: 0,
			tax: 0,
			total: line.unitPrice * line.quantity,
			problems: [],
		})),
		promotions: { applied: [], couponCode: '', couponProblem: null, freeDelivery: false },
		delivery: DELIVERY,
		deliveryOptions: [DELIVERY],
		deliveryProblem: null,
		paymentMethods: [{ method: 'cod', available: true, reason: null, advance: 0 }],
		points: null,
		totals: { subtotal: 201000, discount: 0, delivery: 20000, tax: 0, total: 221000, currency: 'PKR', taxIncluded: true },
		ready: true,
	};
	const ORDER = {
		id: 'ord_1',
		number: 'SO2026-1',
		statusLabel: 'Placed',
		role: 'awaiting_confirmation',
		lines: LINES.map((line, index) => ({ ...line, id: `oln_${index}`, variantName: '', total: 0 })),
		totals: QUOTE.totals,
		payment: { method: 'cod', state: 'unpaid', advance: 0, paid: 0, refunded: 0, payUrl: null, payBy: null },
	};

	it('tells Growth the checkout began on the first Place order, and the purchase once the order exists', async () => {
		let placed = fail(503, 'internal_error');
		const fake = makeShop({
			features: ['checkout'],
			signIn: 's1',
			routes: {
				'POST /v1/shop/cart/quote': () => ok(QUOTE),
				'POST /v1/shop/orders': () => placed,
			},
		});
		fake.cart.add({ productId: 'prd_1', variantId: 'var_1', quantity: 2 });
		fake.cart.add({ productId: 'prd_2', variantId: null, quantity: 1 });
		const timers = handTimers();
		const host = place('cart');
		await mountCart({ host, config: configOf(['checkout']), shop: fake.shop, win: /** @type {any} */ (timers) });
		await flush();
		expect(events.seen).toEqual([]);
		// the address is missing: checking out has begun all the same
		await click(buttonOf(host, text('checkout.place')));
		const items = [
			{ id: 'prd_1', variantId: 'var_1', name: 'Phone', price: 100000, quantity: 2 },
			{ id: 'prd_2', variantId: null, name: 'Case', price: 1000, quantity: 1 },
		];
		expect(events.of('ss:begin_checkout')).toEqual([{ currency: 'PKR', value: 201000, items }]);
		$(host, '#ss-cart-name').value = 'Ana';
		$(host, '#ss-cart-phone').value = '+92 300 0000000';
		$(host, '#ss-cart-line1').value = '1 Road';
		await setValue($(host, '#ss-cart-city'), 'Lahore');
		await timers.run();
		// the server failed: no order, no purchase
		await click(buttonOf(host, text('checkout.place')));
		expect(events.of('ss:purchase')).toEqual([]);
		placed = ok({ order: ORDER, next: { kind: 'done' } }, 201);
		await click(buttonOf(host, text('checkout.place')));
		expect(events.of('ss:begin_checkout')).toHaveLength(1);
		expect(events.of('ss:purchase')).toEqual([
			{ orderId: 'ord_1', orderNumber: 'SO2026-1', currency: 'PKR', value: 221000, items },
		]);
		expect(events.seen.map((entry) => entry.name)).toEqual(['ss:begin_checkout', 'ss:purchase']);
	});
});
