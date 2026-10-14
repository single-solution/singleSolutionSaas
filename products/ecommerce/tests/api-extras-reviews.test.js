/**
 * The API descriptions of reviews, reports, the wishlist and compare (`schemas/api.json`): every route answered with a
 * 2xx, so the test helper checks each answer against its description: a review moderated through the ticket twins
 * (reject, reply, approve, delete) with its counts and the public page with its summary; sales split every way with
 * the names of each group; margin below zero; the summary with statuses; the return rate; every report as JSON and
 * as CSV through both twins; and product cards with photos in the wishlist and compare.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SALES_BY } from '../core/reports.js';
import { COLLECTIONS } from '../core/model.js';
import { STORAGE, readyShop, storedAttribute, storedBrand, storedCategory } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {import('@ss/app-kit').WebsiteData} */
let data;
/** @type {string} */
let ticket;
/** @type {string} */
let sara;
const SARA = 'usr_shopper0000001';
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */

/**
 * A variant of a seeded product.
 * @param {Partial<import('../core/model.js').VariantRecord>} [input]
 * @returns {import('../core/model.js').VariantRecord}
 */
const variant = (input = {}) => ({
	id: createId('var'),
	sku: '',
	options: {},
	price: 1000,
	compareAtPrice: null,
	cost: null,
	stock: 5,
	locations: {},
	grade: null,
	active: true,
	attributes: {},
	media: [],
	soldOut: false,
	warrantyDays: null,
	...input,
});

/**
 * Write an order straight into the merchant database.
 * @param {{ product: ProductRecord, placedAt: Date, quantity?: number, total?: number, cost?: number | null,
 *   categoryIds?: string[], brandId?: string | null, grade?: string | null, gradeLabel?: string, city?: string,
 *   method?: string, status?: string, role?: string, userId?: string, variantName?: string, deliveredAt?: Date | null }} input
 */
const seedOrder = async (input) => {
	const quantity = input.quantity ?? 1;
	const total = input.total ?? 1000 * quantity;
	const line = {
		id: createId('oln'),
		productId: input.product.id,
		variantId: input.product.variants[0]?.id ?? 'var_none',
		kind: 'physical',
		name: input.product.name,
		variantName: input.variantName ?? '',
		sku: '',
		grade: input.grade ?? null,
		gradeLabel: input.gradeLabel ?? '',
		image: null,
		unitPrice: total / quantity,
		quantity,
		discount: 0,
		tax: 0,
		total,
		cost: input.cost ?? null,
		categoryIds: input.categoryIds ?? [],
		brandId: input.brandId ?? null,
		locationId: null,
		serials: [],
		booking: null,
		licences: [],
		returnedQuantity: 0,
	};
	const id = createId('ord');
	await data.collection(COLLECTIONS.orders).insertOne({
		id,
		number: `R-${id.slice(4, 12)}`,
		idempotencyKey: id,
		customer: { userId: input.userId ?? '', customerId: '', name: 'Sara Shopper', email: '', phone: '' },
		address: { name: '', phone: '', line1: '', line2: '', city: input.city ?? '', area: '', postalCode: '', country: '' },
		delivery: { method: 'delivery', zone: '', fee: 0, locationId: null },
		lines: [line],
		totals: { subtotal: total, discount: 0, delivery: 0, tax: 0, total, currency: 'USD', taxIncluded: true, fee: 0 },
		payment: { method: input.method ?? 'cod', state: 'paid', paymentId: null, advance: 0, paid: total, refunded: 0 },
		status: input.status ?? 'delivered',
		role: input.role ?? 'delivered',
		history: [],
		placedAt: input.placedAt,
		deliveredAt: input.deliveredAt === undefined ? input.placedAt : input.deliveredAt,
	});
	return { id, lineId: line.id };
};

beforeAll(async () => {
	shop = await readyShop();
	data = await shop.db();
	ticket = await shop.ticket();
	sara = await shop.signIn();
});
afterAll(async () => shop.product.close());

describe('reviews', () => {
	it('are written, moderated through the ticket twins, counted and shown with their summary', async () => {
		const phone = await shop.seedProduct({ name: 'Review phone', variants: [variant({ options: { Color: 'Black' } })] });
		// long before the reports' ranges
		await seedOrder({ product: phone, placedAt: new Date('2025-01-10T10:00:00Z'), userId: SARA, variantName: 'Black' });
		const written = await shop.visitor('POST', '/v1/shop/reviews', {
			signIn: sara,
			key: 'review-1',
			body: { productId: phone.id, rating: 4, title: ' Good ', body: 'Works well.\nFast.' },
		});
		expect(written.status).toBe(201);
		expect(written.json).toMatchObject({
			productId: phone.id,
			userId: SARA,
			lineId: null,
			name: 'Sara Shopper',
			verified: true,
			variantName: 'Black',
			rating: 4,
			title: 'Good',
			body: 'Works well.\nFast.',
			reply: '',
			status: 'pending',
		});
		const id = written.json.id;

		const listed = await shop.api('GET', `/v1/reviews?status=pending&productId=${phone.id}`);
		expect(listed.json).toMatchObject({ hasMore: false, nextCursor: null });
		expect(listed.json.items).toEqual([expect.objectContaining({ id, productName: 'Review phone', status: 'pending' })]);
		const filter = `productId=${phone.id}`;
		expect((await shop.api('GET', `/v1/reviews/count?${filter}`)).json).toEqual({ count: 1, capped: false });
		expect((await shop.admin(ticket, 'GET', `/v1/admin/reviews/count?${filter}`)).json).toEqual({ count: 1, capped: false });
		expect((await shop.admin(ticket, 'GET', `/v1/admin/reviews/counts?by=status&${filter}`)).json).toEqual({
			total: 1,
			groups: { pending: 1 },
		});

		const rejected = await shop.admin(ticket, 'POST', `/v1/admin/reviews/${id}/reject`);
		expect(rejected.json).toMatchObject({ id, status: 'rejected' });
		expect(rejected.json).not.toHaveProperty('productName');
		const replied = await shop.admin(ticket, 'POST', `/v1/admin/reviews/${id}/reply`, { reply: ' Thank you! ' });
		expect(replied.json).toMatchObject({ id, reply: 'Thank you!', status: 'rejected' });
		expect((await shop.admin(ticket, 'POST', `/v1/admin/reviews/${id}/approve`)).json.status).toBe('approved');

		const shown = await shop.visitor('GET', `/v1/shop/products/${phone.id}/reviews?sort=highest&limit=5`);
		expect(shown.json.items).toEqual([
			{
				id,
				name: 'Sara Shopper',
				verified: true,
				variantName: 'Black',
				rating: 4,
				title: 'Good',
				body: 'Works well.\nFast.',
				reply: 'Thank you!',
				createdAt: expect.any(String),
			},
		]);
		expect(shown.json.summary).toEqual({ average: 4, count: 1, stars: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 } });
		expect(shown.json).toMatchObject({ nextCursor: null, hasMore: false });
		// a server reply with nothing removes it
		expect((await shop.api('POST', `/v1/reviews/${id}/reply`, {})).json.reply).toBe('');

		const removed = await shop.admin(ticket, 'DELETE', `/v1/admin/reviews/${id}`);
		expect(removed.status).toBe(204);
		expect(removed.text).toBe('');
		expect((await shop.api('GET', `/v1/reviews/count?${filter}`)).json.count).toBe(0);
		expect((await shop.admin(ticket, 'POST', `/v1/admin/reviews/${id}/approve`)).status).toBe(404);
		const empty = await shop.visitor('GET', `/v1/shop/products/${phone.id}/reviews`);
		expect(empty.json).toEqual({
			items: [],
			nextCursor: null,
			hasMore: false,
			summary: { average: 0, count: 0, stars: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } },
		});
	});
});

describe('reports', () => {
	/** @type {ProductRecord} */
	let phone;
	/** @type {ProductRecord} */
	let cable;
	/** @type {string} */
	let category;
	/** @type {string} */
	let brand;
	const RANGE = 'from=2026-09-20&to=2026-10-06';

	beforeAll(async () => {
		category = createId('cat');
		brand = createId('brd');
		await data
			.collection(COLLECTIONS.categories)
			.insertOne(storedCategory({ id: category, slug: 'phones', name: 'Phones', parentId: null }));
		await data.collection(COLLECTIONS.brands).insertOne(storedBrand({ id: brand, slug: 'acme', name: 'Acme' }));
		phone = await shop.seedProduct({
			name: 'Report phone',
			variants: [variant({ sku: 'RP-1', options: { Color: 'Red', Size: 'XL' }, grade: 'used_a', stock: 2 })],
			publishedAt: new Date('2026-08-01T00:00:00Z'),
		});
		cable = await shop.seedProduct({ name: 'Report cable', stock: 0 });
		const placedAt = new Date('2026-10-01T09:00:00Z');
		const sold = await seedOrder({
			product: phone,
			placedAt,
			quantity: 2,
			total: 3000,
			cost: 2000,
			categoryIds: [category],
			brandId: brand,
			grade: 'used_a',
			gradeLabel: 'Used A',
			city: ' Paris ',
			method: 'cod',
		});
		await seedOrder({ product: cable, placedAt, total: 500, method: 'card', status: 'confirmed', role: 'open' });
		await data.collection(COLLECTIONS.returns).insertOne({
			id: createId('ret'),
			orderId: sold.id,
			userId: '',
			kind: 'return',
			lines: [{ lineId: sold.lineId, quantity: 1, serials: [] }],
			reason: '',
			photos: [],
			status: 'requested',
			refundAmount: 0,
			refundId: null,
			restockedAt: null,
			history: [],
			createdAt: new Date('2026-10-02T09:00:00Z'),
		});
	});

	it('split sales every way, naming each group', async () => {
		/** @type {Record<string, unknown[]>} */
		const expected = {
			product: [
				{ key: phone.id, name: 'Report phone', units: 2, revenue: 3000, discount: 0 },
				{ key: cable.id, name: 'Report cable', units: 1, revenue: 500, discount: 0 },
			],
			category: [
				{ key: category, name: 'Phones', units: 2, revenue: 3000, discount: 0 },
				{ key: '', name: '', units: 1, revenue: 500, discount: 0 },
			],
			brand: [
				{ key: brand, name: 'Acme', units: 2, revenue: 3000, discount: 0 },
				{ key: '', name: '', units: 1, revenue: 500, discount: 0 },
			],
			city: [
				{ key: 'paris', name: 'Paris', units: 2, revenue: 3000, discount: 0 },
				{ key: '', name: '', units: 1, revenue: 500, discount: 0 },
			],
			grade: [
				{ key: 'used_a', name: 'Used A', units: 2, revenue: 3000, discount: 0 },
				{ key: '', name: '', units: 1, revenue: 500, discount: 0 },
			],
			payment_method: [
				{ key: 'cod', name: 'cod', units: 2, revenue: 3000, discount: 0 },
				{ key: 'card', name: 'card', units: 1, revenue: 500, discount: 0 },
			],
		};
		for (const by of SALES_BY) {
			const report = await shop.api('GET', `/v1/reports/sales?${RANGE}&by=${by}`);
			expect(report.status).toBe(200);
			expect(report.json).toMatchObject({
				currency: 'USD',
				by,
				totals: { orders: 2, units: 3, revenue: 3500, discount: 0 },
			});
			expect(report.json.rows).toEqual(expected[by]);
		}
		// another way is product; an unknown format is refused
		expect((await shop.api('GET', `/v1/reports/sales?${RANGE}&by=color&format=json`)).json.by).toBe('product');
		expect((await shop.api('GET', `/v1/reports/sales?${RANGE}&format=xml`)).status).toBe(422);
	});

	it('answer margin, the summary, return rate, sell-through and stock age as JSON', async () => {
		const margin = await shop.admin(ticket, 'GET', `/v1/admin/reports/margin?${RANGE}`);
		// the unit cost 2000 × 2 is more than the line total 3000
		expect(margin.json).toMatchObject({
			currency: 'USD',
			totals: { units: 2, revenue: 3000, cost: 4000, margin: -1000 },
			rows: [{ productId: phone.id, name: 'Report phone', units: 2, revenue: 3000, cost: 4000, margin: -1000 }],
		});
		const summary = await shop.admin(ticket, 'GET', `/v1/admin/reports/summary?${RANGE}&statuses=delivered,confirmed`);
		expect(summary.json).toMatchObject({ currency: 'USD', statuses: ['delivered', 'confirmed'], orders: 2, total: 3500 });
		expect(summary.json.days).toContainEqual({ day: '2026-10-01', orders: 2, total: 3500 });
		const delivered = await shop.api('GET', `/v1/reports/summary?${RANGE}&series=day&statuses=delivered`);
		expect(delivered.json).toMatchObject({ orders: 1, total: 3000, units: 2 });
		expect((await shop.api('GET', `/v1/reports/summary?${RANGE}`)).json.statuses).toBeNull();

		const returns = await shop.admin(ticket, 'GET', `/v1/admin/reports/returns?${RANGE}`);
		expect(returns.json.rows).toEqual([
			{ productId: phone.id, name: 'Report phone', sold: 2, claimed: 1, rate: 0.5 },
			{ productId: cable.id, name: 'Report cable', sold: 1, claimed: 0, rate: 0 },
		]);
		const through = await shop.api('GET', `/v1/reports/sell-through?${RANGE}`);
		expect(through.json.rows).toEqual(
			expect.arrayContaining([
				{ productId: cable.id, name: 'Report cable', sold: 1, stock: 0, rate: 1 },
				{ productId: phone.id, name: 'Report phone', sold: 2, stock: 2, rate: 0.5 },
			]),
		);
		const oldest = await shop.admin(ticket, 'GET', '/v1/admin/reports/oldest-stock');
		expect(oldest.json.rows).toContainEqual({
			productId: phone.id,
			variantId: phone.variants[0]?.id,
			name: 'Report phone',
			variantName: 'Red / XL',
			sku: 'RP-1',
			grade: 'used_a',
			stock: 2,
			since: '2026-10-01T09:00:00.000Z',
			days: 4,
		});
		const age = await shop.api('GET', '/v1/reports/stock-age');
		expect(age.json.rows).toContainEqual({
			productId: phone.id,
			name: 'Report phone',
			stock: 2,
			publishedAt: '2026-08-01T00:00:00.000Z',
			lastSoldAt: '2026-10-01T09:00:00.000Z',
			daysListed: 65,
			daysSinceSale: 4,
		});
	});

	it('answer every report as a CSV file through both twins', async () => {
		/** @type {Record<string, string>} */
		const headers = {
			sales: 'key,name,units,revenue,discount',
			'stock-age': 'product_id,name,stock,published_at,last_sold_at,days_listed,days_since_sale',
			returns: 'product_id,name,sold,claimed,rate',
			margin: 'product_id,name,units,revenue,cost,margin',
			summary: 'day,orders,total,goods,delivery,fees,discount,refunded,units',
			'sell-through': 'product_id,name,sold,stock,rate',
			'oldest-stock': 'product_id,variant_id,name,variant,sku,grade,stock,since,days',
		};
		for (const [name, header] of Object.entries(headers))
			for (const answer of [
				await shop.api('GET', `/v1/reports/${name}?${RANGE}&format=csv`),
				await shop.admin(ticket, 'GET', `/v1/admin/reports/${name}?${RANGE}&format=csv`),
			]) {
				expect(answer.status).toBe(200);
				expect(answer.headers.get('content-type')).toBe('text/csv; charset=utf-8');
				expect(answer.headers.get('content-disposition')).toBe(`attachment; filename="${name}.csv"`);
				expect(answer.text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(header);
			}
		const margin = await shop.api('GET', `/v1/reports/margin?${RANGE}&format=csv`);
		expect(margin.text).toContain(`${phone.id},Report phone,2,30.00,40.00,-10`);
	});
});

describe('wishlist and compare', () => {
	it('answer product cards with photos, brand, grades and comparable values', async () => {
		const photo = { key: 'ecommerce/products/a/front.jpg', type: 'image/jpeg', size: 1000, alt: '' };
		const brand = createId('brd');
		await data.collection(COLLECTIONS.brands).insertOne(storedBrand({ id: brand, slug: 'zeta', name: 'Zeta' }));
		await data.collection(COLLECTIONS.attributes).insertMany([
			storedAttribute({
				id: 'att_colors',
				name: 'Colors',
				slug: 'colors',
				type: 'choice',
				filterable: true,
				comparable: true,
				sort: 1,
			}),
			storedAttribute({ id: 'att_5g', name: '5G', slug: '5g', type: 'boolean', filterable: true, comparable: true, sort: 2 }),
		]);
		await shop.list('grades', [{ key: 'used_b', label: 'Used B' }]);
		const a = await shop.seedProduct({
			name: 'Card phone',
			brandId: brand,
			featured: true,
			media: [photo],
			specs: { att_colors: ['Red', 'Blue'], att_5g: true },
			variants: [
				variant({ price: 2000, compareAtPrice: 2500, grade: 'used_b', media: [{ ...photo, sizes: { card: 'card.jpg' } }] }),
				variant({ price: 3000 }),
			],
		});
		const b = await shop.seedProduct({ name: 'Plain phone' });

		const saved = await shop.visitor('POST', `/v1/shop/wishlist/items/${a.id}`, { signIn: sara });
		expect(saved.json.max).toBe(200);
		expect(saved.json.items).toEqual([
			expect.objectContaining({
				id: a.id,
				price: 2000,
				priceMax: 3000,
				compareAtPrice: 2500,
				featured: true,
				rating: { average: 0, count: 0 },
				image: expect.stringContaining(STORAGE),
				cardImages: [{ url: expect.stringContaining('card.jpg'), alt: 'Card phone' }],
			}),
		]);
		const merged = await shop.visitor('POST', '/v1/shop/wishlist/merge', {
			signIn: sara,
			body: { productIds: [b.id, a.id, 'prd_missing00'] },
		});
		expect(merged.json.items.map((/** @type {any} */ item) => item.id)).toEqual([a.id, b.id]);
		expect((await shop.visitor('GET', '/v1/shop/wishlist', { signIn: sara })).json.items).toHaveLength(2);
		const removed = await shop.visitor('DELETE', `/v1/shop/wishlist/items/${a.id}`, { signIn: sara });
		expect(removed.json.items.map((/** @type {any} */ item) => item.id)).toEqual([b.id]);

		const compared = await shop.visitor('GET', `/v1/shop/compare?ids=${a.id},${b.id},${a.id}`);
		expect(compared.json.products).toEqual([
			expect.objectContaining({ id: a.id, brand: 'Zeta', grades: ['Used B'] }),
			expect.objectContaining({ id: b.id, brand: null, grades: [], image: null }),
		]);
		expect(compared.json.rows).toEqual([
			{ attributeId: 'att_colors', name: 'Colors', unit: '', values: [['Red', 'Blue'], null] },
			{ attributeId: 'att_5g', name: '5G', unit: '', values: [true, null] },
		]);
	});
});
