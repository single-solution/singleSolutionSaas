/**
 * Growth's browser events (core/growth-events.js, PLAN 0.8.9): the names and the details the shopper widgets dispatch.
 */
import { describe, expect, it } from 'vitest';
import { GROWTH_EVENTS, growthItem, itemsDetail, purchaseDetail } from '../core/growth-events.js';

describe('growth events', () => {
	it('name the four events', () => {
		expect(GROWTH_EVENTS).toEqual({
			viewItem: 'ss:view_item',
			addToCart: 'ss:add_to_cart',
			beginCheckout: 'ss:begin_checkout',
			purchase: 'ss:purchase',
		});
		expect(Object.isFrozen(GROWTH_EVENTS)).toBe(true);
	});

	it('make an item from a priced line or a product, with safe defaults', () => {
		expect(
			growthItem({ productId: 'prd_1', variantId: 'var_1', name: 'Phone', unitPrice: 100000, price: 1, quantity: 2 }),
		).toEqual({ id: 'prd_1', variantId: 'var_1', name: 'Phone', price: 100000, quantity: 2 });
		expect(growthItem({ productId: 'prd_1', variantId: null, name: 'Phone', price: 5000, quantity: 1 })).toEqual({
			id: 'prd_1',
			variantId: null,
			name: 'Phone',
			price: 5000,
			quantity: 1,
		});
		expect(growthItem({ productId: 'prd_2' })).toEqual({ id: 'prd_2', variantId: null, name: '', price: 0, quantity: 1 });
		expect(growthItem({ productId: 'prd_2', variantId: 7, name: null, price: 1.5, quantity: 0 })).toEqual({
			id: 'prd_2',
			variantId: null,
			name: '',
			price: 0,
			quantity: 1,
		});
		expect(growthItem({ productId: 'prd_2', price: -5, quantity: 2.5 }).price).toBe(0);
	});

	it('sum the value of the items', () => {
		const items = [
			growthItem({ productId: 'prd_1', unitPrice: 100000, quantity: 2 }),
			growthItem({ productId: 'prd_2', unitPrice: 5000, quantity: 1 }),
		];
		expect(itemsDetail('PKR', items)).toEqual({ currency: 'PKR', value: 205000, items });
		expect(itemsDetail('USD', [])).toEqual({ currency: 'USD', value: 0, items: [] });
	});

	it('take the purchase from the placed order, valued at its total', () => {
		expect(
			purchaseDetail({
				id: 'ord_1',
				number: 'SO2026-1',
				totals: { total: 210000, currency: 'PKR' },
				lines: [
					{ productId: 'prd_1', variantId: 'var_1', name: 'Phone', unitPrice: 100000, quantity: 2 },
					{ productId: 'prd_2', variantId: null, name: 'Case', unitPrice: 1000, quantity: 1 },
				],
			}),
		).toEqual({
			orderId: 'ord_1',
			orderNumber: 'SO2026-1',
			currency: 'PKR',
			value: 210000,
			items: [
				{ id: 'prd_1', variantId: 'var_1', name: 'Phone', price: 100000, quantity: 2 },
				{ id: 'prd_2', variantId: null, name: 'Case', price: 1000, quantity: 1 },
			],
		});
	});
});
