/**
 * Customers without an account (PLAN 0.8.10 E46) and the loyalty member flag (E47): staff add a customer by phone with
 * opening points, keep their addresses (a guest's orders add theirs, the newest first, at most 6), list the newest
 * first and delete a customer no order names; with the loyalty setting `memberFlag` only flagged customers earn, see
 * and redeem points, the first order flags a customer with `first_order`, and the customers' loyalty segment is the flag.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let users = 0;
let keys = 0;

const ADDRESS = { name: 'Gina Guest', phone: '+15550004001', line1: '1 Main Street', city: 'Springfield', country: 'US' };

/** @param {string} method @param {string} path @param {unknown} [body] */
const api = async (method, path, body) => {
	const answer = await shop.api(method, path, body);
	if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};

/** A visitor's request from the website. @param {string} method @param {string} path @param {{ body?: unknown, signIn?: string }} [init] */
const visit = (method, path, { body, signIn } = {}) => {
	keys += 1;
	return shop.call(method, path, {
		token: shop.browser,
		origin: ORIGIN,
		body,
		headers: {
			'x-forwarded-for': `10.7.${(keys >> 8) & 255}.${keys & 255}`,
			'idempotency-key': `rec-${keys}`,
			...(signIn ? { 'ss-sign-in': signIn } : {}),
		},
	});
};

/** A signed-in shopper of their own. */
const newShopper = async () => {
	users += 1;
	const id = `usr_records${String(users).padStart(6, '0')}`;
	const token = await shop.accounts.signIn({
		websiteId: shop.websiteId,
		sub: id,
		name: 'Max Member',
		email: `max${users}@example.com`,
		email_verified: true,
		phone: `+1555009${String(users).padStart(4, '0')}`,
		phone_verified: true,
	});
	return { id, token };
};

/** @param {string} id */
const recordOf = async (id) =>
	/** @type {any} */ (await (await shop.db()).collection(COLLECTIONS.customers).findOne({ websiteId: shop.websiteId, id }));

beforeAll(async () => {
	shop = await readyShop();
	await shop.setting('checkout', 'defaultCallingCode', '+1');
	await shop.setting('loyalty', 'earnPercent', 10);
	await shop.setting('loyalty', 'earnAt', 'placement');
});
afterAll(async () => shop.product.close());

describe('customers without an account (E46)', () => {
	it('adds a customer by phone with opening points, one per phone', async () => {
		const made = await shop.api('POST', '/v1/customers', {
			name: ' Olive Opening ',
			phone: '555 000 3001',
			city: 'Springfield',
			points: 250,
			note: 'Met at the fair',
		});
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({
			id: expect.stringMatching(/^cus_/),
			userId: '',
			guest: true,
			guestKey: 'p:+15550003001',
			name: 'Olive Opening',
			phone: '+15550003001',
			city: 'Springfield',
			note: 'Met at the fair',
			loyaltyMember: false,
			addresses: [],
			recentOrders: [],
		});
		const account = await api('GET', `/v1/loyalty/accounts/${made.json.id}`);
		expect(account).toMatchObject({
			balance: 250,
			history: [expect.objectContaining({ points: 250, note: 'Opening points' })],
		});
		// one record per phone, however it is typed
		const again = await shop.api('POST', '/v1/customers', { name: 'Olive', phone: '+1 555 000 3001' });
		expect(again.status).toBe(409);
		const paths = async (/** @type {Record<string, unknown>} */ body) =>
			(await shop.api('POST', '/v1/customers', body)).json.errors.map((/** @type {any} */ error) => error.path);
		expect(await paths({ phone: '+15550003002' })).toEqual(['/name']);
		expect(await paths({ name: 'Nobody' })).toEqual(['/phone']);
		expect(await paths({ name: 'N', phone: '+15550003002', points: -1 })).toEqual(['/points']);
		expect(await paths({ name: 'N', phone: '+15550003002', email: 'nope' })).toEqual(['/email']);
		// the one guest contact (checkout.guestIdentity, E15): a website that knows guests by email adds them by email
		await shop.setting('checkout', 'guestIdentity', 'email');
		try {
			expect(await paths({ name: 'Nobody', phone: '+15550003009' })).toEqual(['/email']);
			const byEmail = await shop.api('POST', '/v1/customers', { name: 'Eve', email: 'Eve@Example.com' });
			expect(byEmail.status).toBe(201);
			expect(byEmail.json).toMatchObject({ email: 'eve@example.com', phone: '' });
		} finally {
			await shop.setting('checkout', 'guestIdentity', 'phone');
		}
		// the widget, with customers.manage
		const ticket = await shop.ticket(['customers.manage']);
		const widget = await shop.admin(ticket, 'POST', '/v1/admin/customers', { name: 'Wendy', phone: '+15550003003' });
		expect(widget.status).toBe(201);
		expect((await shop.admin(await shop.ticket(['orders.read']), 'POST', '/v1/admin/customers', {})).status).toBe(403);
	});

	it('keeps the addresses staff set, and those a guest’s orders go to, the newest first', async () => {
		const made = await api('POST', '/v1/customers', { name: 'Gina Guest', phone: '+15550004001' });
		const set = await shop.api('PUT', `/v1/customers/${made.id}/addresses`, {
			addresses: [{ ...ADDRESS, line1: '9 Old Road', region: ' Ohio ', postalCode: '43004' }],
		});
		expect(set.status).toBe(200);
		// a kept address carries its region, as checkout checks it (dynamic model §5)
		expect(set.json.addresses).toEqual([
			expect.objectContaining({ line1: '9 Old Road', phone: '+15550004001', region: 'Ohio', postalCode: '43004' }),
		]);
		expect(
			(await shop.api('PUT', `/v1/customers/${made.id}/addresses`, { addresses: [{ ...ADDRESS, line1: '' }] })).json.errors[0]
				.path,
		).toBe('/addresses/0/line1');
		expect(
			(await shop.api('PUT', `/v1/customers/${made.id}/addresses`, { addresses: Array.from({ length: 7 }, () => ADDRESS) }))
				.status,
		).toBe(422);
		// the guest orders: the new address first, the same address once
		await shop.setting('checkout', 'guests', 'on');
		try {
			const item = await shop.seedProduct({ price: 1000, stock: 10 });
			const place = async (/** @type {Record<string, string>} */ address) =>
				visit('POST', '/v1/shop/orders', {
					body: {
						lines: [{ productId: item.id }],
						payment: 'cod',
						address,
						customer: { name: 'Gina Guest', phone: '+15550004001' },
					},
				});
			expect((await place(ADDRESS)).status).toBe(201);
			expect((await place({ ...ADDRESS, line1: '1  MAIN street' })).status).toBe(201);
			const read = await api('GET', `/v1/customers/${made.id}`);
			// the same address typed again is kept once, as last typed
			expect(read.addresses.map((/** @type {any} */ entry) => entry.line1)).toEqual(['1  MAIN street', '9 Old Road']);
			expect(read.orderCount).toBe(2);
		} finally {
			await shop.setting('checkout', 'guests', 'off');
		}
	});

	it('lists the newest first, and pages customers of one name by their ids', async () => {
		for (const phone of ['+15550005001', '+15550005002', '+15550005003']) {
			shop.advance(1000);
			await api('POST', '/v1/customers', { name: 'Sam Same', phone });
		}
		const newest = await api('GET', '/v1/customers?sort=newest&limit=2');
		expect(newest.items.map((/** @type {any} */ row) => row.phone)).toEqual(['+15550005003', '+15550005002']);
		const next = await api('GET', `/v1/customers?sort=newest&limit=2&cursor=${newest.nextCursor}`);
		expect(next.items[0].phone).toBe('+15550005001');
		expect((await shop.api('GET', '/v1/customers?sort=oldest')).status).toBe(422);
		// three guests of one name, one page each: none is skipped
		/** @type {string[]} */
		const seen = [];
		let cursor = '';
		do {
			const page = await api('GET', `/v1/customers?q=Sam%20Same&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
			seen.push(...page.items.map((/** @type {any} */ row) => row.phone));
			cursor = page.hasMore ? page.nextCursor : '';
		} while (cursor);
		expect(seen.sort()).toEqual(['+15550005001', '+15550005002', '+15550005003']);
	});

	it('deletes a customer no order names, with their loyalty account', async () => {
		const made = await api('POST', '/v1/customers', { name: 'Del Ete', phone: '+15550006001', points: 10 });
		expect((await shop.api('DELETE', `/v1/customers/${made.id}`)).status).toBe(204);
		expect(await recordOf(made.id)).toBeNull();
		expect(
			await (await shop.db()).collection(COLLECTIONS.loyalty).findOne({ websiteId: shop.websiteId, customerId: made.id }),
		).toBeNull();
		expect((await shop.api('DELETE', `/v1/customers/${made.id}`)).status).toBe(404);
		// a customer with orders is kept with them
		const shopper = await newShopper();
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const placed = await visit('POST', '/v1/shop/orders', {
			body: { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS },
			signIn: shopper.token,
		});
		expect(placed.status).toBe(201);
		const refused = await shop.admin(await shop.ticket(['customers.manage']), 'DELETE', `/v1/admin/customers/${shopper.id}`);
		expect(refused.status).toBe(409);
	});
});

describe('the loyalty member flag (E47)', () => {
	it('lets only members earn, see and redeem points while the flag is manual; staff mark them', async () => {
		await shop.setting('loyalty', 'memberFlag', 'manual');
		try {
			const shopper = await newShopper();
			const item = await shop.seedProduct({ price: 10_000, stock: 10 });
			const body = { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS };
			// not a member: nothing to earn, no points shown
			expect((await visit('POST', '/v1/shop/cart/quote', { body, signIn: shopper.token })).json.pointsToEarn).toBe(0);
			const first = await visit('POST', '/v1/shop/orders', { body, signIn: shopper.token });
			expect(first.status).toBe(201);
			const firstRecord = /** @type {any} */ (
				await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id: first.json.order.id })
			);
			expect(firstRecord.promotions.pointsEarned).toBe(0);
			const hidden = await visit('GET', '/v1/shop/loyalty', { signIn: shopper.token });
			expect(hidden.json).toMatchObject({ member: false, balance: 0, history: [] });
			// staff mark them a member: they earn and see points
			const marked = await api('PATCH', `/v1/customers/${shopper.id}`, { loyaltyMember: true });
			expect(marked.loyaltyMember).toBe(true);
			expect((await visit('POST', '/v1/shop/cart/quote', { body, signIn: shopper.token })).json.pointsToEarn).toBeGreaterThan(
				0,
			);
			const second = await visit('POST', '/v1/shop/orders', { body, signIn: shopper.token });
			expect(second.status).toBe(201);
			const shown = await visit('GET', '/v1/shop/loyalty', { signIn: shopper.token });
			// its points wait for delivery (pending), as members' do
			expect(shown.json.member).toBe(true);
			expect(shown.json.pending).toBeGreaterThan(0);
			// the loyalty segment is the members
			const members = await api('GET', '/v1/customers?segment=loyalty&limit=100');
			expect(members.items.every((/** @type {any} */ row) => row.loyaltyMember)).toBe(true);
			expect(members.items.map((/** @type {any} */ row) => row.userId)).toContain(shopper.id);
		} finally {
			await shop.setting('loyalty', 'memberFlag', 'off');
		}
	});

	it('makes a customer a member with their first order with first_order', async () => {
		await shop.setting('loyalty', 'memberFlag', 'first_order');
		try {
			const shopper = await newShopper();
			const item = await shop.seedProduct({ price: 10_000, stock: 10 });
			const placed = await visit('POST', '/v1/shop/orders', {
				body: { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS },
				signIn: shopper.token,
			});
			expect(placed.status).toBe(201);
			const customer = await api('GET', `/v1/customers/${shopper.id}`);
			expect(customer.loyaltyMember).toBe(true);
			const order = /** @type {any} */ (
				await (
					await shop.db()
				)
					.collection(COLLECTIONS.orders)
					.findOne({ websiteId: shop.websiteId, id: placed.json.order.id })
			);
			expect(order.promotions.pointsEarned).toBeGreaterThan(0);
			expect((await visit('GET', '/v1/shop/loyalty', { signIn: shopper.token })).json.member).toBe(true);
		} finally {
			await shop.setting('loyalty', 'memberFlag', 'off');
		}
	});
});
