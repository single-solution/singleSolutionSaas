/**
 * Customer tags, order tags and saved customer segments through the API (E11): tags on a customer and an order, the
 * lists filtered by tag, the tags in use with their counts, renaming and removing a tag everywhere, tagging many at
 * once, the `customer_segments` list (today's three by default) and the customer list by any saved segment's rules.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let users = 0;

/**
 * Place a COD order as a new shopper.
 * @param {{ phone: string, city?: string, price?: number }} options
 */
const placeOrder = async ({ phone, city = 'Springfield', price = 1000 }) => {
	const item = await shop.seedProduct({ price, stock: 10 });
	users += 1;
	const id = `usr_e11${String(users).padStart(6, '0')}`;
	const token = await shop.signIn({ id, phone });
	const placed = await shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: {
			lines: [{ productId: item.id }],
			payment: 'cod',
			address: { name: 'Sara', phone, line1: '1 Main Street', city, region: 'IL', postalCode: '62701', country: 'US' },
		},
		headers: { 'x-forwarded-for': `10.11.0.${users}`, 'ss-sign-in': token, 'idempotency-key': `e11-${users}` },
	});
	expect(placed.status).toBe(201);
	return { userId: id, order: placed.json.order };
};

/** @param {{ json: any }} response */
const idsOf = (response) => response.json.items.map((/** @type {any} */ row) => row.userId || row.id);

beforeAll(async () => {
	shop = await readyShop();
});
afterAll(async () => shop.product.close());

describe('customer tags (E11)', () => {
	it('tags customers, lists them by tag, counts, renames and removes tags', async () => {
		const a = await placeOrder({ phone: '+447700911001' });
		const b = await placeOrder({ phone: '+447700911002' });
		const tagged = await shop.api('PATCH', `/v1/customers/${a.userId}`, { tags: [' vip ', 'wholesale', 'vip'] });
		expect(tagged.status).toBe(200);
		expect(tagged.json.tags).toEqual(['vip', 'wholesale']);
		expect((await shop.api('PATCH', `/v1/customers/${a.userId}`, { tags: 'vip' })).status).toBe(422);
		// many at once
		const applied = await shop.api('POST', '/v1/customers/tags/apply', { ids: [a.userId, b.userId], add: ['newsletter'] });
		expect(applied.json).toEqual({ matched: 2, changed: 2 });
		expect(idsOf(await shop.api('GET', '/v1/customers?tag=vip'))).toEqual([a.userId]);
		expect(idsOf(await shop.api('GET', '/v1/customers?tag=newsletter')).sort()).toEqual([a.userId, b.userId].sort());
		const inUse = await shop.api('GET', '/v1/customers/tags');
		expect(inUse.json.items).toEqual(
			expect.arrayContaining([
				{ tag: 'newsletter', count: 2 },
				{ tag: 'vip', count: 1 },
				{ tag: 'wholesale', count: 1 },
			]),
		);
		// rename into a tag the customer has: kept once
		const renamed = await shop.api('POST', '/v1/customers/tags/rename', { from: 'wholesale', to: 'vip' });
		expect(renamed.json).toEqual({ changed: 1 });
		expect((await shop.api('GET', `/v1/customers/${a.userId}`)).json.tags).toEqual(['vip', 'newsletter']);
		expect((await shop.api('POST', '/v1/customers/tags/remove', { tag: 'newsletter' })).json).toEqual({ changed: 2 });
		expect((await shop.api('GET', `/v1/customers/${b.userId}`)).json.tags).toEqual([]);
		// the admin widget's route needs customers.manage
		const ticket = await shop.ticket(['orders.read']);
		expect((await shop.admin(ticket, 'GET', '/v1/admin/customers/tags')).status).toBe(403);
	});
});

describe('order tags (E11)', () => {
	it('tags orders, lists them by tag and renames and removes tags', async () => {
		const { order } = await placeOrder({ phone: '+447700911010' });
		const edited = await shop.api('PATCH', `/v1/orders/${order.id}`, { tags: ['gift', 'rush'] });
		expect(edited.status).toBe(200);
		expect(edited.json.tags).toEqual(['gift', 'rush']);
		const listed = await shop.api('GET', '/v1/orders?tag=rush');
		expect(listed.json.items.map((/** @type {any} */ o) => o.id)).toEqual([order.id]);
		expect(listed.json.items[0].tags).toEqual(['gift', 'rush']);
		expect((await shop.api('GET', '/v1/orders/tags')).json.items).toEqual(
			expect.arrayContaining([
				{ tag: 'gift', count: 1 },
				{ tag: 'rush', count: 1 },
			]),
		);
		expect((await shop.api('POST', '/v1/orders/tags/rename', { from: 'rush', to: 'express' })).json).toEqual({ changed: 1 });
		expect((await shop.api('POST', '/v1/orders/tags/apply', { ids: [order.id], remove: ['gift'] })).json).toEqual({
			matched: 1,
			changed: 1,
		});
		expect((await shop.api('GET', `/v1/orders/${order.id}`)).json.tags).toEqual(['express']);
		expect((await shop.api('POST', '/v1/orders/tags/remove', { tag: 'express' })).json).toEqual({ changed: 1 });
		expect((await shop.api('GET', '/v1/orders?tag=express')).json.items).toEqual([]);
	});
});

describe('saved customer segments (E11)', () => {
	it('starts with today’s three and lists customers by any saved segment', async () => {
		const read = await shop.api('GET', '/v1/lists/customer_segments');
		expect(read.json.value.map((/** @type {any} */ s) => s.key)).toEqual(['loyalty', 'active', 'guest']);
		const big = await placeOrder({ phone: '+447700911020', city: 'Riverton', price: 90000 });
		const small = await placeOrder({ phone: '+447700911021', city: 'Riverton', price: 500 });
		await shop.api('PATCH', `/v1/customers/${small.userId}`, { tags: ['vip'] });
		// spend counts what was paid: the big order is paid
		await (
			await shop.db()
		)
			.collection(COLLECTIONS.orders)
			.updateOne({ websiteId: shop.websiteId, id: big.order.id }, { $set: { 'payment.paid': 90000 } });
		const saved = await shop.api('PUT', '/v1/lists/customer_segments', {
			value: [
				...read.json.value,
				{
					key: 'riverton-vip',
					name: 'Riverton VIPs',
					match: 'all',
					rules: [
						{ field: 'city', op: 'is', value: 'riverton' },
						{ field: 'tag', op: 'is', value: 'vip' },
					],
				},
				{ key: 'big', name: 'Big spenders', rules: [{ field: 'spent', op: 'gte', value: 50000 }] },
				{
					key: 'not-big',
					name: 'Others',
					rules: [
						{ field: 'spent', op: 'lte', value: 50000 },
						{ field: 'city', op: 'is', value: 'Riverton' },
					],
				},
			],
		});
		expect(saved.status).toBe(200);
		expect(idsOf(await shop.api('GET', '/v1/customers?segment=riverton-vip'))).toEqual([small.userId]);
		expect(idsOf(await shop.api('GET', '/v1/customers?segment=big'))).toEqual([big.userId]);
		expect(idsOf(await shop.api('GET', '/v1/customers?segment=not-big'))).toEqual([small.userId]);
		expect(idsOf(await shop.api('GET', '/v1/customers?segment=active'))).toEqual(
			expect.arrayContaining([big.userId, small.userId]),
		);
		expect((await shop.api('GET', '/v1/customers?segment=nobody')).status).toBe(422);
		// the count of each saved segment
		const counts = await shop.api('GET', '/v1/customers/counts?by=segment');
		expect(counts.json.groups['riverton-vip']).toBe(1);
		expect(counts.json.groups.big).toBe(1);
		// the widget reads the saved segments
		const ticket = await shop.ticket(['customers.manage']);
		const forWidget = await shop.admin(ticket, 'GET', '/v1/admin/customers/segments');
		expect(forWidget.json.items.map((/** @type {any} */ s) => s.key)).toEqual(
			expect.arrayContaining(['loyalty', 'active', 'guest', 'riverton-vip', 'big']),
		);
		const refused = await shop.api('PUT', '/v1/lists/customer_segments', {
			value: [{ key: 'x', name: 'X', rules: [{ field: 'nope', op: 'is', value: 1 }] }],
		});
		expect(refused.status).toBe(422);
	});
});
