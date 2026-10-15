/**
 * Customers, seen markers and deletes through the API (PLAN 0.8.10 E31): segments, phone search on the last digits,
 * the order list's several statuses and methods, city and customer, seen markers per staff member with `unseen=1` and
 * `createdAfter`, deleting an order (its stock given back) and deleting everything of a scope.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { DOMAIN, ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let users = 0;

/** @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

/**
 * Place a COD order as a new shopper.
 * @param {{ phone?: string, city?: string, stock?: number }} [options]
 */
const placeOrder = async ({ phone = '+447700900123', city = 'Springfield', stock = 10 } = {}) => {
	const item = await shop.seedProduct({ price: 1000, stock });
	users += 1;
	const id = `usr_e31${String(users).padStart(6, '0')}`;
	const token = await shop.signIn({ id, phone });
	const placed = await shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: {
			lines: [{ productId: item.id }],
			payment: 'cod',
			address: { name: 'Sara', phone, line1: '1 Main Street', city, country: 'US' },
		},
		headers: { 'x-forwarded-for': `10.6.0.${users}`, 'ss-sign-in': token, 'idempotency-key': `e31-${users}` },
	});
	expect(placed.status).toBe(201);
	return { item, userId: id, order: placed.json.order };
};

/** @param {string} id */
const stockOf = async (id) =>
	/** @type {any} */ (await (await shop.db()).collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id }))
		.variants[0].stock;

/** A server-token call naming the acting staff member (K2). @param {string} method @param {string} path @param {string} staff */
const asStaff = (method, path, staff) =>
	shop.call(method, path, {
		token: shop.server,
		headers: { 'ss-actor-kind': 'staff', 'ss-actor-id': staff, 'ss-actor-name': staff },
	});

beforeAll(async () => {
	shop = await readyShop();
});
afterAll(async () => shop.product.close());

describe('order list filters and seen markers (E31)', () => {
	it('filters by several statuses, methods, city and customer, and finds a phone by its last digits', async () => {
		const a = await placeOrder({ phone: '+447700900101', city: 'London' });
		const b = await placeOrder({ phone: '+447700900102', city: 'Manchester' });
		await shop.api('POST', `/v1/orders/${b.order.id}/move`, { to: 'confirmed' });
		const both = await shop.api('GET', '/v1/orders?status=awaiting_confirmation,confirmed&paymentMethod=cod,online');
		const ids = both.json.items.map((/** @type {any} */ o) => o.id);
		expect(ids).toEqual(expect.arrayContaining([a.order.id, b.order.id]));
		const london = await shop.api('GET', '/v1/orders?city=london&deliveryMethod=delivery');
		expect(london.json.items.map((/** @type {any} */ o) => o.id)).toEqual([a.order.id]);
		expect((await shop.api('GET', `/v1/orders?customer=${b.userId}`)).json.items.map((/** @type {any} */ o) => o.id)).toEqual([
			b.order.id,
		]);
		const byPhone = await shop.api('GET', '/v1/orders?q=07700-900-102');
		expect(byPhone.json.items.map((/** @type {any} */ o) => o.id)).toEqual([b.order.id]);
		// the number by any part of it, and by its digits anywhere
		const number = String(b.order.number);
		const tail = number.replace(/\D/g, '').slice(-4);
		for (const q of [tail, `#${tail}`, number.slice(1).toLowerCase()])
			expect(
				(await shop.api('GET', `/v1/orders?q=${encodeURIComponent(q)}`)).json.items.map((/** @type {any} */ o) => o.id),
				q,
			).toContain(b.order.id);
		expect((await shop.api('GET', '/v1/orders?deliveryMethod=boat')).status).toBe(422);
	});

	it('keeps what each staff member opened and lists the rest', async () => {
		const { order } = await placeOrder();
		const marked = await asStaff('POST', `/v1/orders/${order.id}/seen`, 'usr_staffann001');
		expect(marked.json).toEqual({ seen: true });
		const forAnn = await asStaff('GET', '/v1/orders?unseen=1', 'usr_staffann001');
		expect(forAnn.json.items.map((/** @type {any} */ o) => o.id)).not.toContain(order.id);
		const forBob = await asStaff('GET', '/v1/orders?unseen=1', 'usr_staffbob001');
		expect(forBob.json.items.map((/** @type {any} */ o) => o.id)).toContain(order.id);
		const later = await shop.api('GET', `/v1/orders?createdAfter=${new Date(shop.now() + 1000).toISOString()}`);
		expect(later.json.items).toEqual([]);
	});
});

describe('customers (E31)', () => {
	it('lists segments and marks customers seen', async () => {
		const { userId } = await placeOrder({ phone: '+447700900188' });
		const active = await shop.api('GET', '/v1/customers?segment=active');
		expect(active.json.items.map((/** @type {any} */ c) => c.userId)).toContain(userId);
		expect((await shop.api('GET', '/v1/customers?segment=nobody')).status).toBe(422);
		const byPhone = await shop.api('GET', '/v1/customers?q=7700900188');
		expect(byPhone.json.items.map((/** @type {any} */ c) => c.userId)).toEqual([userId]);
		expect((await asStaff('POST', `/v1/customers/${userId}/seen`, 'usr_staffann001')).json).toEqual({ seen: true });
		const unseen = await asStaff('GET', '/v1/customers?unseen=1', 'usr_staffann001');
		expect(unseen.json.items.map((/** @type {any} */ c) => c.userId)).not.toContain(userId);
		expect((await asStaff('POST', '/v1/customers/usr_nobody/seen', 'usr_staffann001')).status).toBe(404);
	});
});

describe('deletes (E31)', () => {
	it('deletes an order after giving its stock back, and needs the permission through a ticket', async () => {
		const { item, order } = await placeOrder({ stock: 3 });
		expect(await stockOf(item.id)).toBe(2);
		const ticket = await shop.ticket(['orders.read']);
		expect((await shop.admin(ticket, 'DELETE', `/v1/admin/orders/${order.id}`)).status).toBe(403);
		const deleted = await shop.api('DELETE', `/v1/orders/${order.id}`);
		expect(deleted.status).toBe(204);
		expect(await stockOf(item.id)).toBe(3);
		expect((await shop.api('GET', `/v1/orders/${order.id}`)).status).toBe(404);
	});

	it('deletes every order of the website only with the domain typed', async () => {
		const { item } = await placeOrder({ stock: 4 });
		expect(codeOf(await shop.api('POST', '/v1/data/delete-all', { scope: 'orders', confirm: 'nope' }))).toBe(
			'validation_failed',
		);
		const done = await shop.api('POST', '/v1/data/delete-all', { scope: 'orders', confirm: DOMAIN });
		expect(done.json.scope).toBe('orders');
		expect((await shop.api('GET', '/v1/orders')).json.items).toEqual([]);
		expect(await stockOf(item.id)).toBe(4);
	});
});
