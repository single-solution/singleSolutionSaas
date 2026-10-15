/**
 * Customers for the merchant (PLAN 0.8.8: only shop records linked to the Accounts user id): list and search with
 * what each paid, one customer with their latest orders, the blocklist, the staff note and the RTO count; guests and
 * members by customer id, with their orders, spend and points (K-6, CU-5).
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ACCOUNTS, ORIGIN, readyShop } from './helpers.js';

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
			id: createId('cus'),
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
			id: createId('cus'),
			userId: 'usr_bob00000001',
			name: 'Bob Brown',
			email: 'bob@example.com',
			phone: '+15550000002',
			blocked: true,
			blockedReason: 'Refused 3 packages',
			rtoCount: 3,
			orderCount: 3,
			note: '',
		},
		{
			id: createId('cus'),
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
	await data
		.collection(COLLECTIONS.orders)
		.insertMany([
			order('usr_amy00000001', 'Amy', 5000, 0),
			order('usr_amy00000001', 'Amy', 2000, 500),
			order('usr_dan00000001', 'Dan', 900, 0),
		]);
});
afterAll(async () => shop.product.close());

/**
 * A delivered order paid online.
 * @param {string} userId @param {string} name @param {number} paid @param {number} refunded
 * @param {string} [customerId]
 */
const order = (userId, name, paid, refunded, customerId) => ({
	id: createId('ord'),
	number: `C-${createId('num').slice(4, 12)}`,
	customer: { userId, name, email: `${name.toLowerCase()}@example.com`, phone: '', ...(customerId ? { customerId } : {}) },
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
		expect(record).toMatchObject({ email: 'dan@example.com', blocked: true, note: '', createdAt: new Date(shop.now()) });
		expect(record?.id).toMatch(/^cus_/);
		expect(dan.json.createdAt).toBe(new Date(shop.now()).toISOString());
		expect((await shop.api('PATCH', '/v1/customers/usr_nobody0000001', { note: 'x' })).status).toBe(404);
	});
});

describe('guests and members by customer id (K-6, CU-5)', () => {
	const GUEST = createId('cus');
	const MEMBER = createId('cus');
	/** @type {any} */
	let guestOrder;

	beforeAll(async () => {
		const data = await shop.db();
		await data.collection(COLLECTIONS.customers).insertMany([
			{
				id: GUEST,
				userId: null,
				guest: true,
				name: 'Gail Guest',
				email: '',
				phone: '+15550000009',
				blocked: false,
				blockedReason: '',
				rtoCount: 0,
				orderCount: 2,
				note: '',
			},
			{
				id: MEMBER,
				userId: 'usr_mia00000001',
				name: 'Mia Member',
				email: 'mia@example.com',
				phone: '+15550000010',
				blocked: false,
				blockedReason: '',
				rtoCount: 0,
				orderCount: 1,
				note: '',
			},
		]);
		guestOrder = order('', 'Gail', 3000, 0, GUEST);
		await data
			.collection(COLLECTIONS.orders)
			.insertMany([guestOrder, order('', 'Gail', 1000, 1000, GUEST), order('usr_mia00000001', 'Mia', 700, 0, MEMBER)]);
		await data.collection(COLLECTIONS.loyalty).insertOne({
			websiteId: shop.websiteId,
			userId: null,
			customerId: GUEST,
			balance: 40,
			lifetimeEarned: 40,
			lots: [{ id: 'lot_1', points: 40, left: 40, earnedAt: new Date(shop.now()), expiresAt: null, orderId: null }],
			history: [],
			version: 1,
		});
	});

	it('lists a guest with their customer id, what they paid and their orders', async () => {
		const listed = await shop.api('GET', '/v1/customers?segment=guest');
		const gail = listed.json.items.find((/** @type {any} */ c) => c.name === 'Gail Guest');
		expect(gail).toMatchObject({ id: GUEST, userId: '', guest: true, totalSpent: 3000, ordersPlaced: 2 });
		// the segment is the stored guest flag: no member in it
		expect(listed.json.items.every((/** @type {any} */ c) => c.guest === true)).toBe(true);
		const mia = (await shop.api('GET', '/v1/customers?q=Mia')).json.items[0];
		expect(mia).toMatchObject({ id: MEMBER, userId: 'usr_mia00000001', guest: false, totalSpent: 700, ordersPlaced: 1 });
	});

	it('opens, notes, blocks and marks seen a guest by customer id, and a member by either id', async () => {
		const gail = await shop.admin(ticket, 'GET', `/v1/admin/customers/${GUEST}`);
		expect(gail.status).toBe(200);
		expect(gail.json).toMatchObject({ id: GUEST, guest: true, name: 'Gail Guest', totalSpent: 3000 });
		expect(gail.json.recentOrders).toHaveLength(2);
		const blocked = await shop.admin(ticket, 'PATCH', `/v1/admin/customers/${GUEST}`, {
			blocked: true,
			blockedReason: 'Refused packages',
			note: 'Calls at night',
		});
		expect(blocked.json).toMatchObject({ id: GUEST, blocked: true, blockedReason: 'Refused packages', note: 'Calls at night' });
		const record = await (await shop.db()).collection(COLLECTIONS.customers).findOne({ websiteId: shop.websiteId, id: GUEST });
		expect(record).toMatchObject({ userId: null, guest: true, blocked: true });
		expect((await shop.api('POST', `/v1/customers/${GUEST}/seen`)).json).toEqual({ seen: true });
		// the staff order view shows the guest's flags
		const detail = await shop.api('GET', `/v1/orders/${guestOrder.id}`);
		expect(detail.json.customerFlags).toMatchObject({ blocked: true, note: 'Calls at night', orderCount: 2 });
		await shop.api('PATCH', `/v1/customers/${GUEST}`, { blocked: false });

		const byId = await shop.api('GET', `/v1/customers/${MEMBER}`);
		const byUser = await shop.api('GET', '/v1/customers/usr_mia00000001');
		expect(byId.json).toMatchObject({ id: MEMBER, userId: 'usr_mia00000001', totalSpent: 700 });
		expect(byUser.json).toEqual(byId.json);
		const noted = await shop.api('PATCH', `/v1/customers/${MEMBER}`, { note: 'VIP' });
		expect(noted.json).toMatchObject({ userId: 'usr_mia00000001', note: 'VIP' });
		expect((await shop.api('GET', `/v1/customers/${createId('cus')}`)).status).toBe(404);
		expect((await shop.api('PATCH', `/v1/customers/${createId('cus')}`, { note: 'x' })).status).toBe(404);
	});

	it('reads and adjusts a guest’s points by customer id, and a member’s through their customer id', async () => {
		const read = await shop.api('GET', `/v1/loyalty/accounts/${GUEST}`);
		expect(read.json).toMatchObject({ userId: null, customerId: GUEST, balance: 40 });
		const given = await shop.admin(
			await shop.ticket(['loyalty.manage']),
			'POST',
			`/v1/admin/loyalty/accounts/${GUEST}/adjust`,
			{
				points: 10,
				note: 'Welcome back',
			},
		);
		expect(given.json).toMatchObject({ customerId: GUEST, balance: 50 });
		const taken = await shop.api('POST', `/v1/loyalty/accounts/${GUEST}/adjust`, { points: -15 });
		expect(taken.json.balance).toBe(35);
		const loyalty = await (await shop.db()).collection(COLLECTIONS.loyalty).find({ websiteId: shop.websiteId }).toArray();
		expect(loyalty.filter((account) => account.customerId === GUEST || account.userId === GUEST)).toHaveLength(1);
		const member = await shop.api('POST', `/v1/loyalty/accounts/${MEMBER}/adjust`, { points: 5 });
		expect(member.json).toMatchObject({ userId: 'usr_mia00000001', balance: 5 });
		// a new loyalty account knows when it was made (CU-4)
		expect(
			await (
				await shop.db()
			)
				.collection(COLLECTIONS.loyalty)
				.findOne({ websiteId: shop.websiteId, userId: 'usr_mia00000001' }),
		).toMatchObject({ createdAt: new Date(shop.now()) });
		expect((await shop.api('GET', '/v1/loyalty/accounts/usr_mia00000001')).json.balance).toBe(5);
		expect((await shop.api('GET', `/v1/loyalty/accounts/${createId('cus')}`)).status).toBe(404);
	});

	it('lists a guest’s orders and points for Accounts and Chat by customer id', async () => {
		const orders = await shop.api('GET', `/v1/customers/${GUEST}/orders`);
		expect(orders.json.items).toHaveLength(2);
		expect(orders.json.loyaltyPoints).toBe(35);
		expect((await shop.api('GET', '/v1/customers/usr_mia00000001/orders')).json.items).toHaveLength(1);
	});
});

describe('customers without orders and when records are made (CU-2, CU-4)', () => {
	const JOINED = '2026-09-01T08:00:00.000Z';

	it('makes the record of an Accounts user without orders when staff open them, joined when Accounts says', async () => {
		shop.responders.set(`${ACCOUNTS}/v1/users/usr_noa00000001`, () => ({
			status: 200,
			body: { id: 'usr_noa00000001', name: 'Noa New', email: 'noa@example.com', phone: '+15550000020', createdAt: JOINED },
		}));
		shop.responders.set(`${ACCOUNTS}/v1/users/usr_ghost0000001`, () => ({ status: 404, body: { code: 'not_found' } }));
		const noa = await shop.admin(ticket, 'GET', '/v1/admin/customers/usr_noa00000001');
		expect(noa.status).toBe(200);
		expect(noa.json).toMatchObject({
			userId: 'usr_noa00000001',
			name: 'Noa New',
			phone: '+15550000020',
			ordersPlaced: 0,
			createdAt: JOINED,
			recentOrders: [],
		});
		expect(noa.json.id).toMatch(/^cus_/);
		const blocked = await shop.api('PATCH', '/v1/customers/usr_noa00000001', { blocked: true, blockedReason: 'Fraud' });
		expect(blocked.json).toMatchObject({ blocked: true, createdAt: JOINED });
		const listed = await shop.api('GET', '/v1/customers?userIds=usr_noa00000001,usr_amy00000001');
		expect(listed.json.items.map((/** @type {any} */ c) => c.userId)).toEqual(['usr_amy00000001', 'usr_noa00000001']);
		expect((await shop.api('GET', '/v1/customers/count?userIds=usr_noa00000001')).json.count).toBe(1);
		expect((await shop.api('GET', '/v1/customers?userIds=a,b%20c')).status).toBe(422);
		expect((await shop.api('GET', '/v1/customers/usr_ghost0000001')).status).toBe(404);
		shop.responders.delete(`${ACCOUNTS}/v1/users/usr_noa00000001`);
		shop.responders.delete(`${ACCOUNTS}/v1/users/usr_ghost0000001`);
	});

	it('makes a signed-in shopper’s record at their first visit with customerRecords sign_in only', async () => {
		/** @param {string} sub */
		const visit = async (sub) => {
			const token = await shop.accounts.signIn({
				websiteId: shop.websiteId,
				sub,
				name: 'Vic Visitor',
				email: `${sub}@example.com`,
				email_verified: true,
				phone: '+15550000030',
				phone_verified: true,
			});
			const answer = await shop.call('GET', '/v1/shop/orders', {
				token: shop.browser,
				origin: ORIGIN,
				headers: { 'ss-sign-in': token },
			});
			expect(answer.status).toBe(200);
		};
		const recordOf = async (/** @type {string} */ userId) =>
			(await shop.db()).collection(COLLECTIONS.customers).findOne({ websiteId: shop.websiteId, userId });
		await visit('usr_vic00000001');
		expect(await recordOf('usr_vic00000001')).toBeNull();
		await shop.setting('checkout', 'customerRecords', 'sign_in');
		await visit('usr_vic00000002');
		expect(await recordOf('usr_vic00000002')).toMatchObject({
			name: 'Vic Visitor',
			phone: '+15550000030',
			guest: false,
			orderCount: 0,
			createdAt: new Date(shop.now()),
		});
		// a record made once is not written again by later visits
		await (
			await shop.db()
		)
			.collection(COLLECTIONS.customers)
			.updateOne({ websiteId: shop.websiteId, userId: 'usr_vic00000002' }, { $set: { name: 'Vic V.' } });
		await visit('usr_vic00000002');
		expect(await recordOf('usr_vic00000002')).toMatchObject({ name: 'Vic V.' });
		await shop.setting('checkout', 'customerRecords', 'first_order');
	});
});
