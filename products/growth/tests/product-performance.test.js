/**
 * Product performance (R7 #113): the shop events' items counted per product per day in the daily totals (views,
 * add-to-carts, checkouts, purchases, units and revenue per currency, with the item's name from the events), and the
 * report and CSV file worked out from them. Raw events keep only ids and quantities.
 */
import { describe, expect, it } from 'vitest';
import { funnelEvent } from '../core/pixels.js';
import { checkEvent } from '../core/events.js';
import { PRODUCT_METRICS, PRODUCT_SORTS, productReport, productsCsv } from '../core/product-performance.js';

const context = { domain: 'shop.example.com', country: null };

describe('the shop events count each product', () => {
	it('a view counts the product once, with its name; the raw event keeps ids and quantities only', () => {
		const view = checkEvent(
			{
				type: 'view_item',
				path: '/products/mug',
				currency: 'USD',
				value: 1200,
				items: [{ id: 'prd_1', variantId: 'var_1', name: 'Blue Mug', price: 1200, quantity: 1 }],
			},
			context,
		);
		expect(view?.data.items).toEqual([{ id: 'prd_1', variantId: 'var_1', quantity: 1 }]);
		expect(view?.totals).toEqual(
			expect.arrayContaining([
				{ metric: 'item_view', key: 'prd_1', count: 1, sum: 0 },
				{ metric: 'item_name', key: 'prd_1\nBlue Mug', count: 1, sum: 0 },
			]),
		);
		expect(view?.totals.some((total) => total.metric === 'item_revenue')).toBe(false);
	});

	it('a purchase counts the order once per product, its units and its revenue per currency', () => {
		const purchase = checkEvent(
			{
				type: 'purchase',
				path: '/thanks',
				currency: 'EUR',
				value: 5000,
				orderId: 'o1',
				items: [
					{ id: 'prd_1', variantId: 'var_1', name: 'Blue Mug', price: 1200, quantity: 2 },
					{ id: 'prd_1', variantId: 'var_2', name: 'Blue Mug', price: 1300, quantity: 1 },
					{ id: 'prd_2', name: '', quantity: 1 },
				],
			},
			context,
		);
		const items = (purchase?.totals ?? []).filter((total) => PRODUCT_METRICS.includes(total.metric));
		expect(items).toEqual([
			{ metric: 'item_purchase', key: 'prd_1', count: 1, sum: 3 },
			{ metric: 'item_revenue', key: 'prd_1\nEUR', count: 3, sum: 3700 },
			{ metric: 'item_name', key: 'prd_1\nBlue Mug', count: 1, sum: 0 },
			{ metric: 'item_purchase', key: 'prd_2', count: 1, sum: 1 },
		]);
		// a cart and a checkout count the product and (a cart) its units
		const cart = checkEvent({ type: 'add_to_cart', path: '/', items: [{ id: 'prd_2', quantity: 4 }] }, context);
		expect(cart?.totals).toContainEqual({ metric: 'item_cart', key: 'prd_2', count: 1, sum: 4 });
		const checkout = checkEvent({ type: 'begin_checkout', path: '/', items: [{ id: 'prd_2', quantity: 4 }] }, context);
		expect(checkout?.totals).toContainEqual({ metric: 'item_checkout', key: 'prd_2', count: 1, sum: 0 });
	});

	it('the page script sends each item’s name and price with the event', () => {
		const detail = {
			items: [{ id: 'prd_1', variantId: null, name: 'Blue Mug', price: 1200, quantity: 1 }],
			value: 1200,
			currency: 'USD',
			orderId: null,
		};
		expect(funnelEvent('view_item', detail, '/p').items).toEqual([
			{ id: 'prd_1', variantId: null, name: 'Blue Mug', price: 1200, quantity: 1 },
		]);
	});
});

describe('the products report', () => {
	const rows = [
		{ metric: 'item_view', key: 'prd_1', count: 100, sum: 0 },
		{ metric: 'item_cart', key: 'prd_1', count: 10, sum: 12 },
		{ metric: 'item_checkout', key: 'prd_1', count: 6, sum: 0 },
		{ metric: 'item_purchase', key: 'prd_1', count: 4, sum: 5 },
		{ metric: 'item_revenue', key: 'prd_1\nUSD', count: 5, sum: 6000 },
		{ metric: 'item_name', key: 'prd_1\nBlue Mug', count: 80 },
		{ metric: 'item_name', key: 'prd_1\nBlue mug (old)', count: 20 },
		{ metric: 'item_view', key: 'prd_2', count: 40, sum: 0 },
		{ metric: 'item_purchase', key: 'prd_2', count: 4, sum: 4 },
		{ metric: 'item_revenue', key: 'prd_2\nUSD', count: 4, sum: 8000 },
		{ metric: 'item_revenue', key: 'prd_2\nEUR', count: 1, sum: 900 },
		{ metric: 'item_cart', key: 'prd_3', count: 2, sum: 2 },
	].map((row) => ({ sum: 0, ...row }));

	it('one row per product: its name as the events gave it most, its counts, units, revenue and rates', () => {
		const report = productReport(rows, {});
		expect(report.currencies).toEqual(['USD', 'EUR']);
		expect(report.total).toBe(3);
		expect(report.items[0]).toEqual({
			id: 'prd_1',
			name: 'Blue Mug',
			views: 100,
			carts: 10,
			checkouts: 6,
			purchases: 4,
			units: 5,
			revenue: [{ currency: 'USD', amount: 6000 }],
			cartRate: 10,
			conversion: 4,
		});
		expect(report.items.map((item) => item.id)).toEqual(['prd_1', 'prd_2', 'prd_3']);
		expect(report.items[2]).toMatchObject({ id: 'prd_3', name: '', views: 0, carts: 2, conversion: null });
	});

	it('sorts by any column, either way, and keeps a limit', () => {
		expect(productReport(rows, { sort: 'conversion' }).items.map((item) => item.id)).toEqual(['prd_2', 'prd_1', 'prd_3']);
		expect(productReport(rows, { sort: 'revenue' }).items.map((item) => item.id)).toEqual(['prd_2', 'prd_1', 'prd_3']);
		expect(productReport(rows, { sort: 'views', order: 'asc' }).items.map((item) => item.id)).toEqual([
			'prd_3',
			'prd_2',
			'prd_1',
		]);
		// by name (its id when the events gave none), A to Z
		expect(productReport(rows, { sort: 'name', order: 'asc' }).items.map((item) => item.id)).toEqual([
			'prd_1',
			'prd_2',
			'prd_3',
		]);
		expect(productReport(rows, { limit: 1 })).toMatchObject({ total: 3, items: [{ id: 'prd_1' }] });
		expect(PRODUCT_SORTS).toContain('purchases');
	});

	it('the CSV file: a column per measure and one revenue column per currency, amounts in major units', () => {
		const report = productReport(rows, {});
		const csv = productsCsv(report);
		const lines = csv
			.replace(/^\uFEFF/, '')
			.trim()
			.split('\r\n');
		expect(lines[0]).toBe(
			'product_id,name,views,add_to_carts,checkouts,purchases,units,cart_rate_percent,conversion_percent,revenue_USD,revenue_EUR',
		);
		expect(lines[1]).toBe('prd_1,Blue Mug,100,10,6,4,5,10,4,60.00,');
		expect(lines[2]).toBe('prd_2,,40,0,0,4,4,0,10,80.00,9.00');
	});
});
