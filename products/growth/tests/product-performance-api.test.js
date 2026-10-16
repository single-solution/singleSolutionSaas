/**
 * Product performance through the API (R7 #113): the shop events counted per product in the day's totals document
 * (no new documents, raw events unchanged), the products report and its CSV file to the server token and a ticket,
 * and the analytics report left as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ORIGIN, ALL, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL);
	await env.connectDatabase();
	const mug = { id: 'prd_mug', variantId: 'var_1', name: 'Blue Mug', price: 1200 };
	const lamp = { id: 'prd_lamp', name: 'Desk Lamp', price: 4500 };
	const sent = await env.collect([
		{ type: 'view_item', path: '/products/mug', currency: 'USD', value: 1200, items: [{ ...mug, quantity: 1 }] },
		{ type: 'view_item', path: '/products/mug', currency: 'USD', value: 1200, items: [{ ...mug, quantity: 1 }] },
		{ type: 'view_item', path: '/products/lamp', currency: 'USD', value: 4500, items: [{ ...lamp, quantity: 1 }] },
		{ type: 'add_to_cart', path: '/products/mug', currency: 'USD', value: 2400, items: [{ ...mug, quantity: 2 }] },
		{
			type: 'begin_checkout',
			path: '/cart',
			currency: 'USD',
			value: 6900,
			items: [
				{ ...mug, quantity: 2 },
				{ ...lamp, quantity: 1 },
			],
		},
		{
			type: 'purchase',
			path: '/cart',
			currency: 'USD',
			value: 2400,
			orderId: 'ord_1',
			items: [{ ...mug, quantity: 2 }],
		},
	]);
	expect(await sent.json()).toEqual({ accepted: 6 });
});
afterAll(async () => {
	await env.close();
});

describe('product performance', () => {
	it('counts each product in the day’s one totals document; the raw events keep ids and quantities', async () => {
		const db = await env.merchantDb();
		expect(await db.collection('ss_growth_totals').countDocuments()).toBe(1);
		const purchase = await db.collection('ss_growth_analytics_events').findOne({ type: 'purchase' });
		expect(purchase?.data.items).toEqual([{ id: 'prd_mug', variantId: 'var_1', quantity: 2 }]);
	});

	it('answers the products report, sorted, to the server token and to a ticket', async () => {
		const answer = await env.call('GET', '/v1/analytics/products', { token: env.server });
		expect(answer.status).toBe(200);
		const report = await answer.json();
		expect(report).toMatchObject({ from: '2026-09-02', to: '2026-10-01', timeZone: 'UTC', currencies: ['USD'], total: 2 });
		expect(report.items).toEqual([
			{
				id: 'prd_mug',
				name: 'Blue Mug',
				views: 2,
				carts: 1,
				checkouts: 1,
				purchases: 1,
				units: 2,
				revenue: [{ currency: 'USD', amount: 2400 }],
				cartRate: 50,
				conversion: 50,
			},
			{
				id: 'prd_lamp',
				name: 'Desk Lamp',
				views: 1,
				carts: 0,
				checkouts: 1,
				purchases: 0,
				units: 0,
				revenue: [],
				cartRate: 0,
				conversion: 0,
			},
		]);
		const sorted = await (
			await env.call('GET', '/v1/analytics/products?sort=name&order=asc&limit=1', { token: env.server })
		).json();
		expect(sorted).toMatchObject({ total: 2, items: [{ id: 'prd_mug' }] });
		expect(sorted.items).toHaveLength(1);
		expect((await env.call('GET', '/v1/analytics/products?sort=price', { token: env.server })).status).toBe(422);
		expect((await env.call('GET', '/v1/analytics/products?limit=0', { token: env.server })).status).toBe(422);
		expect((await env.call('GET', '/v1/analytics/products?from=2026-10-05&to=2026-10-01', { token: env.server })).status).toBe(
			422,
		);
		const ticket = await env.ticket(['analytics.read']);
		const viaTicket = await env.call('GET', '/v1/admin/analytics/products?from=2026-10-01&to=2026-10-01', {
			token: ticket,
			origin: ADMIN_ORIGIN,
		});
		expect(viaTicket.status).toBe(200);
		expect((await viaTicket.json()).items).toHaveLength(2);
		const refused = await env.call('GET', '/v1/admin/analytics/products', {
			token: await env.ticket(['seo.check']),
			origin: ADMIN_ORIGIN,
		});
		expect(refused.status).toBe(403);
	});

	it('gives the report as a CSV file', async () => {
		const answer = await env.call('GET', '/v1/analytics/products/csv?sort=views', { token: env.server });
		expect(answer.status).toBe(200);
		expect(answer.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(answer.headers.get('content-disposition')).toBe('attachment; filename="products-2026-09-02-2026-10-01.csv"');
		const lines = (await answer.text())
			.replace(/^\uFEFF/, '')
			.trim()
			.split('\r\n');
		expect(lines).toEqual([
			'product_id,name,views,add_to_carts,checkouts,purchases,units,cart_rate_percent,conversion_percent,revenue_USD',
			'prd_mug,Blue Mug,2,1,1,1,2,50,50,24.00',
			'prd_lamp,Desk Lamp,1,0,1,0,0,0,0,',
		]);
		const ticket = await env.ticket(['analytics.read']);
		const viaTicket = await env.call('GET', '/v1/admin/analytics/products/csv', { token: ticket, origin: ADMIN_ORIGIN });
		expect(viaTicket.status).toBe(200);
	});

	it('leaves the analytics report as it was: its lists hold no product totals', async () => {
		const report = await (await env.call('GET', '/v1/analytics', { token: env.server })).json();
		expect(JSON.stringify(report)).not.toContain('prd_mug');
		expect(report.funnels[0].steps[0]).toMatchObject({ match: 'view_item', count: 3 });
	});

	it('says nothing of products while the conversion funnel is off', async () => {
		await env.switchOn(['visitor_analytics']);
		expect((await env.call('GET', '/v1/analytics/products', { token: env.server })).status).toBe(403);
	});
});
