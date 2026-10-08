/**
 * Customers for the merchant (PLAN 0.8.8: only shop records linked to the Accounts user id): list and search with
 * what each paid, one customer with their latest orders, the blocklist, the staff note and the RTO count.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {string} */
let ticket;

beforeAll(async () => {
	shop = await readyShop();
	ticket = await shop.ticket();
	const data = await shop.db();
	await data.collection(COLLECTIONS.customers).insertMany([
		{
			userId: 'usr_amy00000001',
			name: 'Amy Adams',
			email: 'amy@example.com',
			phone: '+15550000001',
			blocked: false,
			blockedReason: '',
			rtoCount: 0,
			orderCount: 2,
			note: '',
		},
		{
			userId: 'usr_bob00000001',
			name: 'Bob Brown',
			email: 'bob@example.com',
			phone: '+15550000002',
			blocked: true,
			blockedReason: 'Refused 3 parcels',
			rtoCount: 3,
			orderCount: 3,
			note: '',
		},
		{
			userId: 'usr_cat00000001',
			name: 'Cat Cole',
			email: 'cat@example.com',
			phone: '+15550000003',
			blocked: false,
			blockedReason: '',
			rtoCount: 1,
			orderCount: 0,
			note: '',
		},
	]);
	/** @param {string} userId @param {string} name @param {number} paid @param {number} refunded */
	const order = (userId, name, paid, refunded) => ({
		id: createId('ord'),
		number: `C-${createId('num').slice(4, 12)}`,
		customer: { userId, name, email: `${name.toLowerCase()}@example.com`, phone: '' },
		address: null,
		delivery: { method: 'none', zone: '', fee: 0, locationId: null },
		lines: [],
		totals: { subtotal: paid, discount: 0, delivery: 0, tax: 0, total: paid, currency: 'USD', taxIncluded: true },
		promotions: {
			couponId: null,
			couponCode: '',
			dealIds: [],
			bundleIds: [],
			pointsRedeemed: 0,
			pointsValue: 0,
			pointsEarned: 0,
			released: false,
		},
		payment: { method: 'online', state: 'paid', paymentId: 'pay_1', advance: 0, paid, refunded, checkedAt: null },
		status: 'delivered',
		role: 'delivered',
		history: [],
		shipment: null,
		stockHeld: true,
		holdUntil: null,
		idempotencyKey: createId('key'),
		note: '',
		staffNote: '',
		placedAt: new Date(shop.now()),
		deliveredAt: null,
	});
	await data
		.collection(COLLECTIONS.orders)
		.insertMany([
			order('usr_amy00000001', 'Amy', 5000, 0),
			order('usr_amy00000001', 'Amy', 2000, 500),
			order('usr_dan00000001', 'Dan', 900, 0),
		]);
});
afterAll(async () => shop.product.close());

describe('customers', () => {
	it('lists customers A to Z with what they paid, searches and pages', async () => {
		const all = await shop.admin(ticket, 'GET', '/v1/admin/customers?limit=2');
		expect(all.status).toBe(200);
		expect(all.json.items.map((/** @type {any} */ c) => c.name)).toEqual(['Amy Adams', 'Bob Brown']);
		expect(all.json.items[0]).toMatchObject({ totalSpent: 6500, totalSpentText: 'USD 65.00', ordersPlaced: 2, blocked: false });
		const rest = await shop.admin(ticket, 'GET', `/v1/admin/customers?limit=2&cursor=${all.json.nextCursor}`);
		expect(rest.json.items.map((/** @type {any} */ c) => c.name)).toEqual(['Cat Cole']);
		expect(rest.json.items[0]).toMatchObject({ totalSpent: 0, ordersPlaced: 0, rtoCount: 1 });
		const names = async (/** @type {string} */ query) =>
			(await shop.api('GET', `/v1/customers?${query}`)).json.items.map((/** @type {any} */ c) => c.userId);
		expect(await names('blocked=true')).toEqual(['usr_bob00000001']);
		expect(await names('blocked=false')).toEqual(['usr_amy00000001', 'usr_cat00000001']);
		expect(await names('q=cole')).toEqual(['usr_cat00000001']);
		expect(await names('q=bob%40')).toEqual(['usr_bob00000001']);
		expect(await names('q=0000001')).toEqual(['usr_amy00000001']);
		expect(await names('q=usr_cat00000001')).toEqual(['usr_cat00000001']);
		expect((await shop.api('GET', `/v1/customers?q=${'x'.repeat(121)}`)).status).toBe(422);
		expect((await shop.admin(await shop.ticket(['orders.read']), 'GET', '/v1/admin/customers')).status).toBe(403);
	});

	it('shows one customer with their latest orders, also without a customer record', async () => {
		const amy = await shop.admin(ticket, 'GET', '/v1/admin/customers/usr_amy00000001');
		expect(amy.status).toBe(200);
		expect(amy.json).toMatchObject({ userId: 'usr_amy00000001', name: 'Amy Adams', totalSpent: 6500 });
		expect(amy.json.recentOrders).toHaveLength(2);
		expect(amy.json.recentOrders[0]).toMatchObject({ statusLabel: 'Delivered', totalText: expect.stringMatching(/^USD /) });
		const dan = await shop.api('GET', '/v1/customers/usr_dan00000001');
		expect(dan.json).toMatchObject({ name: 'Dan', email: 'dan@example.com', blocked: false, totalSpent: 900, createdAt: null });
		expect((await shop.api('GET', '/v1/customers/usr_nobody0000001')).status).toBe(404);
		expect((await shop.api('GET', '/v1/customers/bad%20id')).status).toBe(404);
	});

	it('blocks and unblocks with a reason, keeps a note and resets the RTO count', async () => {
		const url = '/v1/admin/customers/usr_cat00000001';
		expect((await shop.admin(ticket, 'PATCH', url, { blocked: true })).status).toBe(422);
		expect((await shop.admin(ticket, 'PATCH', url, { blocked: 'yes' })).status).toBe(422);
		expect((await shop.admin(ticket, 'PATCH', url, { blocked: true, blockedReason: 'x'.repeat(501) })).status).toBe(422);
		expect((await shop.admin(ticket, 'PATCH', url, { note: 5 })).status).toBe(422);
		expect((await shop.admin(ticket, 'PATCH', url, { resetRto: false })).status).toBe(422);
		expect((await shop.admin(ticket, 'PATCH', url, {})).status).toBe(422);
		const blocked = await shop.admin(ticket, 'PATCH', url, { blocked: true, blockedReason: ' Fake orders ' });
		expect(blocked.status).toBe(200);
		expect(blocked.json).toMatchObject({ blocked: true, blockedReason: 'Fake orders' });
		const noted = await shop.admin(ticket, 'PATCH', url, { note: 'Calls often', resetRto: true });
		expect(noted.json).toMatchObject({ blocked: true, note: 'Calls often', rtoCount: 0 });
		const unblocked = await shop.api('PATCH', '/v1/customers/usr_cat00000001', { blocked: false, blockedReason: 'ignored' });
		expect(unblocked.json).toMatchObject({ blocked: false, blockedReason: '' });
		// a customer known only from orders gets a record
		const dan = await shop.api('PATCH', '/v1/customers/usr_dan00000001', { blocked: true, blockedReason: 'Chargeback' });
		expect(dan.json).toMatchObject({ name: 'Dan', blocked: true, rtoCount: 0, orderCount: 0 });
		const record = await (
			await shop.db()
		)
			.collection(COLLECTIONS.customers)
			.findOne({ websiteId: shop.websiteId, userId: 'usr_dan00000001' });
		expect(record).toMatchObject({ email: 'dan@example.com', blocked: true, note: '' });
		expect((await shop.api('PATCH', '/v1/customers/usr_nobody0000001', { note: 'x' })).status).toBe(404);
	});
});
