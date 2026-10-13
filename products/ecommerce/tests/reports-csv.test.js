/**
 * Reports and CSV (PLAN E36): the summary with its daily series in the business time zone and its `statuses`, sales
 * by grade and payment method, sell-through, oldest stock, every report as CSV, orders per order with the list's
 * filters, customers, and price and stock updates by CSV with the stale-row check; each with its ticket twin.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '../core/csv.js';
import { COLLECTIONS } from '../core/model.js';
import { ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {import('@ss/app-kit').WebsiteData} */
let data;
const DAY = 86_400_000;
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** Sold in the range, with stock left. @type {ProductRecord} */
let sold;
/** Sold in the range, no stock left. @type {ProductRecord} */
let gone;
/** Never sold, published 40 days ago. @type {ProductRecord} */
let idle;
/** @type {Map<string, ProductRecord>} */
const byId = new Map();

/**
 * The lines of a CSV answer, without the byte order mark.
 * @param {{ text: string }} answer
 */
const linesOf = (answer) =>
	answer.text
		.replace(/^\uFEFF/, '')
		.trim()
		.split('\r\n');

/**
 * Write an order straight into the merchant database.
 * @param {{ number: string, placedAt: string, status: string, role: string, productId: string, quantity: number,
 *   total: number, subtotal: number, delivery?: number, fee?: number, discount?: number, refunded?: number,
 *   paid?: number, method?: string, state?: string, grade?: string | null, cost?: number | null, currency?: string,
 *   userId?: string, name?: string }} input
 */
const seedOrder = async (input) => {
	const { quantity, total, subtotal, discount = 0, currency = 'USD' } = input;
	await data.collection(COLLECTIONS.orders).insertOne({
		id: createId('ord'),
		number: input.number,
		idempotencyKey: input.number,
		customer: { userId: input.userId ?? '', name: input.name ?? 'Shopper', email: '', phone: '' },
		address: { name: '', phone: '', line1: '', line2: '', city: 'Lahore', area: '', postalCode: '', country: '', notes: '' },
		delivery: { method: 'delivery', zone: '', fee: input.delivery ?? 0, locationId: null },
		lines: [
			{
				id: createId('oln'),
				productId: input.productId,
				variantId: byId.get(input.productId)?.variants[0]?.id ?? 'var_none',
				kind: 'physical',
				name: byId.get(input.productId)?.name ?? 'Item',
				variantName: '',
				sku: '',
				grade: input.grade ?? null,
				gradeLabel: input.grade ? 'Used A' : '',
				image: null,
				unitPrice: subtotal / quantity,
				quantity,
				discount,
				tax: 0,
				total: subtotal - discount,
				cost: input.cost ?? null,
				categoryIds: [],
				brandId: null,
				locationId: null,
				serials: [],
				booking: null,
				licences: [],
				returnedQuantity: 0,
			},
		],
		totals: {
			subtotal,
			discount,
			delivery: input.delivery ?? 0,
			tax: 0,
			total,
			currency,
			taxIncluded: true,
			fee: input.fee ?? 0,
		},
		payment: {
			method: input.method ?? 'cod',
			state: input.state ?? 'unpaid',
			paymentId: null,
			advance: 0,
			paid: input.paid ?? 0,
			refunded: input.refunded ?? 0,
			checkedAt: null,
		},
		status: input.status,
		role: input.role,
		history: [],
		placedAt: new Date(input.placedAt),
	});
};

beforeAll(async () => {
	shop = await readyShop();
	data = await shop.db();
	// the business time zone is five hours ahead of UTC (PLAN 0.8.10 K8)
	shop.responders.set(`${ORIGIN}/.well-known/business.json`, () => ({
		status: 200,
		body: { version: 1, name: 'Shop', email: 'hello@shop.example.com', timeZone: 'Asia/Karachi' },
	}));
	const refreshed = await shop.dashboard(
		await shop.adminSession(),
		'POST',
		`/v1/dashboard/websites/${shop.websiteId}/business/refresh`,
	);
	expect(refreshed.status).toBeLessThan(300);

	sold = await shop.seedProduct({ name: 'Sold phone', stock: 3 });
	gone = await shop.seedProduct({ name: 'Last tablet', stock: 0 });
	idle = await shop.seedProduct({ name: 'Idle watch', stock: 5, publishedAt: new Date(shop.now() - 40 * DAY) });
	for (const item of [sold, gone, idle]) byId.set(item.id, item);
	// 2026-10-04 20:30 UTC is 2026-10-05 01:30 in the business time zone
	await seedOrder({
		number: 'R-A',
		placedAt: '2026-10-04T20:30:00Z',
		status: 'delivered',
		role: 'delivered',
		productId: sold.id,
		quantity: 2,
		subtotal: 1200,
		delivery: 200,
		fee: 100,
		total: 1500,
		paid: 1500,
		state: 'paid',
		userId: 'usr_ann',
		name: 'Ann',
	});
	await seedOrder({
		number: 'R-B',
		placedAt: '2026-10-05T05:00:00Z',
		status: 'confirmed',
		role: 'open',
		productId: gone.id,
		quantity: 1,
		subtotal: 1100,
		discount: 100,
		total: 1000,
		paid: 1000,
		refunded: 300,
		state: 'partially_refunded',
		method: 'bank_transfer',
		grade: 'used_a',
		cost: 1200,
		name: 'Bea',
	});
	await seedOrder({
		number: 'R-C',
		placedAt: '2026-10-03T10:00:00Z',
		status: 'cancelled',
		role: 'cancelled',
		productId: sold.id,
		quantity: 5,
		subtotal: 5000,
		total: 5000,
		userId: 'usr_ann',
		name: 'Ann',
	});
	await seedOrder({
		number: 'R-D',
		placedAt: '2026-10-05T06:00:00Z',
		status: 'delivered',
		role: 'delivered',
		productId: sold.id,
		quantity: 1,
		subtotal: 900,
		total: 900,
		currency: 'EUR',
	});
});
afterAll(async () => shop.product.close());

const RANGE = 'from=2026-10-03&to=2026-10-05';

describe('reports', () => {
	it('sums the range and every business day of it, counting the statuses asked for', async () => {
		const summary = await shop.api('GET', `/v1/reports/summary?${RANGE}&series=day`);
		expect(summary.status).toBe(200);
		expect(summary.json).toMatchObject({
			from: '2026-10-02T19:00:00.000Z',
			to: '2026-10-05T19:00:00.000Z',
			currency: 'USD',
			statuses: null,
			orders: 2,
			total: 2500,
			goods: 2300,
			delivery: 200,
			fees: 100,
			discount: 100,
			refunded: 300,
			units: 3,
		});
		expect(summary.json.days).toEqual([
			{ day: '2026-10-03', orders: 0, total: 0 },
			{ day: '2026-10-04', orders: 0, total: 0 },
			{ day: '2026-10-05', orders: 2, total: 2500 },
		]);

		// statuses decide which orders count as revenue
		const chosen = await shop.api('GET', `/v1/reports/summary?${RANGE}&statuses=delivered,cancelled`);
		expect(chosen.json).toMatchObject({ statuses: ['delivered', 'cancelled'], orders: 2, total: 6500, units: 7 });
		expect(chosen.json.days).toEqual([
			{ day: '2026-10-03', orders: 1, total: 5000 },
			{ day: '2026-10-04', orders: 0, total: 0 },
			{ day: '2026-10-05', orders: 1, total: 1500 },
		]);
		expect((await shop.api('GET', `/v1/reports/summary?${RANGE}&statuses=nothing_like_it`)).status).toBe(422);
		expect((await shop.api('GET', `/v1/reports/summary?${RANGE}&series=week`)).status).toBe(422);

		const staff = await shop.ticket(['reports.read']);
		expect((await shop.admin(staff, 'GET', `/v1/admin/reports/summary?${RANGE}`)).json.total).toBe(2500);
		expect((await shop.admin(await shop.ticket(['orders.read']), 'GET', '/v1/admin/reports/summary')).status).toBe(403);

		const file = await shop.api('GET', `/v1/reports/summary?${RANGE}&format=csv`);
		expect(file.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(file.headers.get('content-disposition')).toBe('attachment; filename="summary.csv"');
		expect(linesOf(file)).toEqual([
			'day,orders,total,goods,delivery,fees,discount,refunded,units',
			'2026-10-03,0,0.00,0.00,0.00,0.00,0.00,0.00,0',
			'2026-10-04,0,0.00,0.00,0.00,0.00,0.00,0.00,0',
			'2026-10-05,2,25.00,23.00,2.00,1.00,1.00,3.00,3',
		]);
	});

	it('splits sales by grade and by payment method', async () => {
		const byGrade = await shop.api('GET', `/v1/reports/sales?by=grade&${RANGE}`);
		expect(byGrade.json.by).toBe('grade');
		expect(byGrade.json.rows).toEqual([
			{ key: '', name: '', units: 2, revenue: 1200, discount: 0 },
			{ key: 'used_a', name: 'Used A', units: 1, revenue: 1000, discount: 100 },
		]);
		const byMethod = await shop.admin(
			await shop.ticket(['reports.read']),
			'GET',
			`/v1/admin/reports/sales?by=payment_method&${RANGE}`,
		);
		expect(byMethod.json.rows).toEqual([
			{ key: 'cod', name: 'cod', units: 2, revenue: 1200, discount: 0 },
			{ key: 'bank_transfer', name: 'bank_transfer', units: 1, revenue: 1000, discount: 100 },
		]);
		expect(linesOf(await shop.api('GET', `/v1/reports/sales?by=payment_method&${RANGE}&format=csv`))).toEqual([
			'key,name,units,revenue,discount',
			'cod,cod,2,12.00,0.00',
			'bank_transfer,bank_transfer,1,10.00,1.00',
		]);
	});

	it('gives sell-through and the oldest stock', async () => {
		const through = await shop.api('GET', `/v1/reports/sell-through?${RANGE}`);
		expect(through.status).toBe(200);
		const mine = through.json.rows.filter((/** @type {any} */ row) => [sold.id, gone.id, idle.id].includes(row.productId));
		expect(mine).toEqual([
			{ productId: gone.id, name: 'Last tablet', sold: 1, stock: 0, rate: 1 },
			{ productId: sold.id, name: 'Sold phone', sold: 2, stock: 3, rate: 0.4 },
			{ productId: idle.id, name: 'Idle watch', sold: 0, stock: 5, rate: 0 },
		]);
		const staff = await shop.ticket(['reports.read']);
		expect((await shop.admin(staff, 'GET', `/v1/admin/reports/sell-through?${RANGE}`)).status).toBe(200);
		expect(linesOf(await shop.api('GET', `/v1/reports/sell-through?${RANGE}&format=csv`))[0]).toBe(
			'product_id,name,sold,stock,rate',
		);

		const oldest = await shop.admin(staff, 'GET', '/v1/admin/reports/oldest-stock');
		expect(oldest.status).toBe(200);
		const rows = oldest.json.rows.filter((/** @type {any} */ row) => [sold.id, gone.id, idle.id].includes(row.productId));
		expect(rows).toEqual([
			expect.objectContaining({
				productId: idle.id,
				variantId: idle.variants[0]?.id,
				stock: 5,
				days: 40,
				since: new Date(shop.now() - 40 * DAY).toISOString(),
			}),
			expect.objectContaining({ productId: sold.id, stock: 3, days: 0, since: '2026-10-05T06:00:00.000Z' }),
		]);
		expect(linesOf(await shop.api('GET', '/v1/reports/oldest-stock?format=csv'))[0]).toBe(
			'product_id,variant_id,name,variant,sku,grade,stock,since,days',
		);
	});

	it('answers every report as CSV, signed amounts included', async () => {
		const margin = linesOf(await shop.api('GET', `/v1/reports/margin?${RANGE}&format=csv`));
		expect(margin).toEqual(['product_id,name,units,revenue,cost,margin', `${gone.id},Last tablet,1,10.00,12.00,-2`]);
		for (const [path, header] of [
			['stock-age', 'product_id,name,stock,published_at,last_sold_at,days_listed,days_since_sale'],
			['returns', 'product_id,name,sold,claimed,rate'],
			['sales', 'key,name,units,revenue,discount'],
		]) {
			const answer = await shop.admin(await shop.ticket(['reports.read']), 'GET', `/v1/admin/reports/${path}?format=csv`);
			expect(answer.headers.get('content-type'), path).toBe('text/csv; charset=utf-8');
			expect(linesOf(answer)[0], path).toBe(header);
		}
		await shop.setting('csv', 'delimiter', ';');
		expect(linesOf(await shop.api('GET', `/v1/reports/sales?${RANGE}&format=csv`))[0]).toBe('key;name;units;revenue;discount');
		await shop.setting('csv', 'delimiter', ',');
		expect((await shop.api('GET', '/v1/reports/sales?format=xml')).status).toBe(422);
		expect((await shop.api('GET', '/v1/reports/stock-age?format=json')).json.rows).toBeInstanceOf(Array);
	});
});

describe('CSV', () => {
	it('exports orders one row per order, with the order list filters', async () => {
		const perOrder = await shop.api('GET', '/v1/csv/orders?per=order&paymentMethod=bank_transfer');
		expect(perOrder.status).toBe(200);
		expect(linesOf(perOrder)).toEqual([
			'number,placed_at,status,customer,city,lines,units,subtotal,discount,delivery,fee,tax,total,currency,payment_method,payment_state,paid,refunded',
			'R-B,2026-10-05T05:00:00.000Z,confirmed,Bea,Lahore,1,1,11.00,1.00,0.00,0.00,0.00,10.00,USD,bank_transfer,partially_refunded,10.00,3.00',
		]);
		expect(linesOf(await shop.api('GET', '/v1/csv/orders?per=order&role=cancelled')).slice(1)).toEqual([
			'R-C,2026-10-03T10:00:00.000Z,cancelled,Ann,Lahore,1,5,50.00,0.00,0.00,0.00,0.00,50.00,USD,cod,unpaid,0.00,0.00',
		]);
		const searched = linesOf(await shop.api('GET', '/v1/csv/orders?q=R-A'));
		expect(searched[0]?.startsWith('number,placed_at,status,customer,city,product,')).toBe(true);
		expect(searched.slice(1).map((line) => line.split(',')[0])).toEqual(['R-A']);
		expect((await shop.api('GET', '/v1/csv/orders?per=week')).status).toBe(422);
		expect((await shop.api('GET', '/v1/csv/orders?paymentMethod=cheque')).status).toBe(422);
		const staff = await shop.ticket(['csv.run']);
		const twin = await shop.admin(staff, 'GET', '/v1/admin/csv/orders?per=order&status=delivered');
		expect(
			linesOf(twin)
				.slice(1)
				.map((line) => line.split(',')[0]),
		).toEqual(['R-A', 'R-D']);
	});

	it('exports customers with their orders and what they spent', async () => {
		await data.collection(COLLECTIONS.customers).insertMany([
			{
				userId: 'usr_ann',
				name: 'Ann',
				email: 'ann@example.com',
				phone: '+15550001',
				city: 'Lahore',
				blocked: false,
				blockedReason: '',
				rtoCount: 1,
				orderCount: 2,
				note: '',
				lastOrderAt: new Date('2026-10-04T20:30:00Z'),
			},
			{
				id: 'cus_zed',
				userId: null,
				name: 'Zed',
				email: 'zed@example.com',
				phone: '',
				guest: true,
				blocked: true,
				blockedReason: 'Fake orders',
				rtoCount: 0,
				orderCount: 1,
				note: '=1+1',
			},
		]);
		// a guest's orders are theirs by customer id (CU-5)
		const guestOrder = /** @type {any} */ (
			await data.collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId }, { projection: { _id: 0 } })
		);
		await data.collection(COLLECTIONS.orders).insertOne({
			...guestOrder,
			id: 'ord_zed',
			number: 'R-Z',
			customer: { userId: '', customerId: 'cus_zed', name: 'Zed', email: 'zed@example.com', phone: '' },
			payment: { ...guestOrder.payment, paid: 700, refunded: 0 },
		});
		const answer = await shop.api('GET', '/v1/csv/customers');
		expect(answer.status).toBe(200);
		expect(answer.headers.get('content-disposition')).toBe('attachment; filename="customers.csv"');
		expect(linesOf(answer)).toEqual([
			'user_id,customer_id,name,email,phone,city,guest,orders,spent,currency,blocked,blocked_reason,returned_parcels,note,last_order_at',
			"usr_ann,,Ann,ann@example.com,'+15550001,Lahore,false,2,15.00,USD,false,,1,,2026-10-04T20:30:00.000Z",
			",cus_zed,Zed,zed@example.com,,,true,1,7.00,USD,true,Fake orders,0,'=1+1,",
		]);
		const staff = await shop.ticket(['csv.run']);
		expect(linesOf(await shop.admin(staff, 'GET', '/v1/admin/csv/customers'))).toHaveLength(3);
		expect((await shop.admin(await shop.ticket(['orders.read']), 'GET', '/v1/admin/csv/customers')).status).toBe(403);
	});

	it('updates only price, stock and sold out by CSV, and fails rows older than their product', async () => {
		const phone = await shop.seedProduct({
			name: 'Update phone',
			variants: [
				{
					id: createId('var'),
					sku: 'U-1',
					options: {},
					price: 1000,
					compareAtPrice: null,
					cost: null,
					stock: 5,
					locations: {},
					grade: null,
					active: true,
				},
				{
					id: createId('var'),
					sku: 'U-2',
					options: {},
					price: 2000,
					compareAtPrice: null,
					cost: null,
					stock: 1,
					locations: {},
					grade: null,
					active: true,
				},
			],
		});
		const case_ = await shop.seedProduct({ name: 'Update case', sku: 'U-3', price: 300 });
		const exported = (await shop.api('GET', '/v1/csv/products')).text;
		const parsed = parseCsv(exported);
		if (!parsed.ok) throw new Error('export');
		const [header = [], ...rows] = parsed.rows;
		expect(header.slice(-2)).toEqual(['sold_out', 'updated_at']);
		const column = (/** @type {string} */ name) => header.indexOf(name);
		const pick = (/** @type {string} */ sku) => [...(rows.find((row) => row[column('sku')] === sku) ?? [])];
		const one = pick('U-1');
		one[column('price')] = '12.50';
		one[column('stock')] = '7';
		one[column('sold_out')] = 'true';
		one[column('name')] = 'Renamed';
		const two = pick('U-2');
		two[column('price')] = '25';
		two[column('sold_out')] = '';
		const three = pick('U-3');
		three[column('price')] = '5';
		const missing = [...one];
		missing[column('variant_id')] = '';
		missing[column('sku')] = 'NOPE';
		const bad = [...two];
		bad[column('price')] = 'cheap';
		const csv = toCsv(header, [one, two, three, missing, bad]);
		expect(new Date(String(three[column('updated_at')])).getTime()).toBe(new Date(case_.updatedAt).getTime());

		// someone changes the case after the export: its row is stale
		shop.advance(60_000);
		await data
			.collection(COLLECTIONS.products)
			.updateOne({ websiteId: shop.websiteId, id: case_.id }, { $set: { updatedAt: new Date(shop.now()) } });

		const failed = [
			{ line: 4, path: '/updated_at', message: 'The product changed after this file was exported: export it again.' },
			{ line: 5, path: '/sku', message: 'There is no such variant.' },
			{ line: 6, path: '/price', message: 'This is not a price in USD.' },
		];
		const dry = await shop.api('POST', '/v1/csv/products?mode=update', { csv });
		expect(dry.json).toEqual({ dryRun: true, mode: 'update', rows: 5, updated: 2, failed });
		const untouched = await data.collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id: phone.id });
		expect(untouched?.variants.map((/** @type {any} */ v) => v.price)).toEqual([1000, 2000]);

		const staff = await shop.ticket(['csv.run']);
		const done = await shop.admin(staff, 'POST', '/v1/admin/csv/products?mode=update', { csv, dryRun: false });
		expect(done.json).toEqual({ dryRun: false, mode: 'update', rows: 5, updated: 2, failed });
		const after = await data.collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id: phone.id });
		expect(after?.name).toBe('Update phone');
		expect(after?.variants.map((/** @type {any} */ v) => [v.price, v.stock, v.soldOut ?? false])).toEqual([
			[1250, 7, true],
			[2500, 1, false],
		]);
		expect(after?.price).toBe(1250);
		const caseAfter = await data.collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id: case_.id });
		expect(caseAfter?.variants[0].price).toBe(300);

		// the same file again: the phone changed since its export too
		shop.advance(60_000);
		const again = await shop.api('POST', '/v1/csv/products?mode=update', { csv, dryRun: false });
		expect(again.json.updated).toBe(0);
		expect(
			again.json.failed.filter((/** @type {any} */ f) => f.path === '/updated_at').map((/** @type {any} */ f) => f.line),
		).toEqual([2, 3, 4]);

		expect((await shop.api('POST', '/v1/csv/products?mode=update', { csv: 'sku,price\nU-1,1' })).status).toBe(422);
		expect((await shop.api('POST', '/v1/csv/products?mode=replace', { csv })).status).toBe(422);
	});
});
