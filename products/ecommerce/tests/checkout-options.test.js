/**
 * The checkout options through the API (PLAN 0.8.10 E18–E25): deal rules, pages and cart locks, role pricing,
 * loyalty options, guest checkout with order keys, payment and delivery options, COD options, bank transfers recorded
 * by staff with the shopper's proof, and whole-unit amounts.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CART_MAX_LINES, CART_MAX_QUANTITY, ORDER_BURST_LIMIT, ORDER_BURST_WINDOW_MINUTES } from '../core/limits.js';
import { COLLECTIONS } from '../core/model.js';
import { ACCOUNTS, ORIGIN, PAYMENTS, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let ip = 0;
let users = 0;

const ADDRESS = {
	name: 'Sara Shopper',
	phone: '+15550001111',
	line1: '1 Main Street',
	city: 'Springfield',
	region: 'IL',
	postalCode: '62701',
	country: 'US',
};

/**
 * A visitor request from a fresh address.
 * @param {string} method @param {string} path
 * @param {{ body?: unknown, signIn?: string, key?: string, orderKey?: string }} [init]
 */
const visit = (method, path, { body, signIn, key, orderKey } = {}) => {
	ip += 1;
	return shop.call(method, path, {
		token: shop.browser,
		origin: ORIGIN,
		body,
		headers: {
			'x-forwarded-for': `10.9.${(ip >> 8) & 255}.${ip & 255}`,
			...(signIn ? { 'ss-sign-in': signIn } : {}),
			...(key ? { 'idempotency-key': key } : {}),
			...(orderKey ? { 'ss-order-key': orderKey } : {}),
		},
	});
};

/** @param {Record<string, unknown>} [claims] a new shopper's sign-in, with extra claims (role, phone) */
const newShopper = async (claims = {}) => {
	users += 1;
	const id = `usr_options${String(users).padStart(6, '0')}`;
	const token = await shop.accounts.signIn({
		websiteId: shop.websiteId,
		sub: id,
		name: 'Sara Shopper',
		email: `sara${users}@example.com`,
		email_verified: true,
		phone: `+1555000${String(users).padStart(4, '0')}`,
		phone_verified: true,
		...claims,
	});
	return { id, token };
};

/** @param {Record<string, unknown>} body @param {string} [signIn] */
const place = (body, signIn) => visit('POST', '/v1/shop/orders', { body, signIn, key: `opt-${ip}-${Math.random()}` });

/** @param {Record<string, unknown>} body @param {string} [signIn] */
const quote = (body, signIn) => visit('POST', '/v1/shop/cart/quote', { body, signIn });
/** What the shopper is shown for one unit of a product: the product answer's first variant. @param {string} id */
const shown = async (id) => (await visit('GET', `/v1/shop/products/${id}`)).json.variants[0];

/** @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

/** @param {string} id */
const orderRecord = async (id) =>
	/** @type {any} */ (await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id }));

/** @param {Record<string, unknown>} input */
const newDeal = async (input) => {
	const created = await shop.api('POST', '/v1/deals', { name: 'Deal', type: 'percent', value: 10, ...input });
	expect(created.status).toBe(201);
	return created.json;
};

beforeAll(async () => {
	shop = await readyShop();
	await shop.list('delivery_zones', [
		// every other place: today's seeded rates, free (E5)
		{
			key: 'everywhere',
			name: 'Everywhere',
			rates: [
				{ key: 'standard', name: 'Standard' },
				{ key: 'pickup', name: 'Pickup', kind: 'pickup' },
			],
		},
		{
			key: 'city',
			name: 'Springfield',
			match: { cities: ['Springfield'] },
			rates: [{ key: 'standard', name: 'Standard', price: 300, minDays: 1, maxDays: 2 }],
		},
	]);
});
afterAll(async () => shop.product.close());

describe('deals (E18)', () => {
	it('serves a deal by id or slug with its display fields, and refuses a slug used twice', async () => {
		const deal = await newDeal({ slug: 'summer-sale', badgeLabel: 'Sale', discountLabel: '10% off', color: '#c00' });
		const bySlug = await visit('GET', '/v1/shop/deals/summer-sale');
		expect(bySlug.json).toMatchObject({ id: deal.id, badgeLabel: 'Sale', discountLabel: '10% off', color: '#c00' });
		expect((await visit('GET', `/v1/shop/deals/${deal.id}`)).json.id).toBe(deal.id);
		expect((await visit('GET', '/v1/shop/deals/nothing-here')).status).toBe(404);
		const again = await shop.api('POST', '/v1/deals', { name: 'Other', type: 'percent', value: 5, slug: 'summer-sale' });
		expect(codeOf(again)).toBe('slug_taken');
		await shop.api('DELETE', `/v1/deals/${deal.id}`);
	});

	it('applies a deal only for its payment method, minimum quantity and cart total', async () => {
		const item = await shop.seedProduct({ price: 1000, stock: 50 });
		const deal = await newDeal({
			scope: { productIds: [item.id], categoryIds: [], brandIds: [] },
			conditions: { match: 'all', rules: [], groups: [], paymentMethods: ['cod'], minQuantity: 2, cartTotal: 0 },
		});
		const one = await quote({ lines: [{ productId: item.id, quantity: 1 }], payment: 'cod' });
		expect(one.json.totals.discount).toBe(0);
		const two = await quote({ lines: [{ productId: item.id, quantity: 2 }], payment: 'cod' });
		expect(two.json.totals.discount).toBe(200);
		const online = await quote({ lines: [{ productId: item.id, quantity: 2 }], payment: 'online' });
		expect(online.json.totals.discount).toBe(0);
		await shop.api('DELETE', `/v1/deals/${deal.id}`);
	});

	it('gives a line the best saving, or the first deal in show order with lineChoice first (D4)', async () => {
		const item = await shop.seedProduct({ price: 10_000, stock: 5 });
		const scope = { productIds: [item.id], categoryIds: [], brandIds: [] };
		const percent = await newDeal({ scope, value: 5, sort: 1 });
		const fixed = await newDeal({ scope, type: 'fixed', value: 800, sort: 2 });
		const best = await quote({ lines: [{ productId: item.id }] });
		expect(best.json.lines[0]).toMatchObject({ dealDiscount: 800, deal: { id: fixed.id } });
		await shop.setting('deals', 'lineChoice', 'first');
		const first = await quote({ lines: [{ productId: item.id }] });
		expect(first.json.lines[0]).toMatchObject({ dealDiscount: 500, deal: { id: percent.id } });
		expect((await shown(item.id)).deal.savings).toBe(500);
		await shop.setting('deals', 'lineChoice', 'best');
		await shop.api('DELETE', `/v1/deals/${percent.id}`);
		await shop.api('DELETE', `/v1/deals/${fixed.id}`);
	});

	it('puts one checkout deal after item deals with cartOffer one_after_items, none with one_exclusive (D4)', async () => {
		const item = await shop.seedProduct({ price: 600_000, stock: 10 });
		const own = await newDeal({ scope: { productIds: [item.id], categoryIds: [], brandIds: [] }, value: 10 });
		const checkout = await newDeal({
			name: 'Five off from 5,000',
			target: 'cart',
			value: 5,
			conditions: { match: 'all', rules: [], groups: [], cartTotal: 500_000 },
		});
		const lines = [{ productId: item.id }];
		// per_line_best: the line takes the larger of 10% and 5%
		expect((await quote({ lines })).json.totals.discount).toBe(60_000);
		await shop.setting('deals', 'cartOffer', 'one_after_items');
		// 10% of 6,000, then 5% of the 5,400 left
		const after = await quote({ lines });
		expect(after.json.totals.discount).toBe(87_000);
		expect(after.json.lines[0]).toMatchObject({ dealDiscount: 87_000, deal: { id: own.id } });
		expect(after.json.promotions.applied.map((/** @type {any} */ entry) => [entry.id, entry.amount])).toEqual([
			[own.id, 60_000],
			[checkout.id, 27_000],
		]);
		const shopper = await newShopper();
		const placed = await place({ lines, payment: 'cod', address: ADDRESS }, shopper.token);
		expect(placed.json.order.totals.discount).toBe(87_000);
		expect((await orderRecord(placed.json.order.id)).promotions.dealIds).toEqual([own.id, checkout.id]);
		await shop.setting('deals', 'cartOffer', 'one_exclusive');
		expect((await quote({ lines })).json.totals.discount).toBe(60_000);
		await shop.setting('deals', 'cartOffer', 'per_line_best');
		await shop.api('DELETE', `/v1/deals/${own.id}`);
		await shop.api('DELETE', `/v1/deals/${checkout.id}`);
	});

	it('judges a free-delivery deal’s cart total after item deals with cartThresholdBase (D4)', async () => {
		const item = await shop.seedProduct({ price: 1_050_000, stock: 10 });
		const own = await newDeal({ scope: { productIds: [item.id], categoryIds: [], brandIds: [] }, value: 10 });
		const ship = await newDeal({
			name: 'Free delivery from 10,000',
			type: 'free_delivery',
			conditions: { match: 'all', rules: [], groups: [], cartTotal: 1_000_000 },
		});
		const body = { lines: [{ productId: item.id }], delivery: { city: 'Springfield' } };
		expect((await quote(body)).json.totals).toMatchObject({ discount: 105_000, delivery: 0 });
		await shop.setting('deals', 'cartThresholdBase', 'after_item_deals');
		// 10,500 less 10% is 9,450: below the free delivery's 10,000
		expect((await quote(body)).json.totals).toMatchObject({ discount: 105_000, delivery: 300 });
		await shop.setting('deals', 'cartThresholdBase', 'goods');
		await shop.api('DELETE', `/v1/deals/${own.id}`);
		await shop.api('DELETE', `/v1/deals/${ship.id}`);
	});

	it('lets only a checkout deal block points with pointsBlockedBy cart_offer (D4)', async () => {
		const item = await shop.seedProduct({ price: 10_000, stock: 10 });
		const own = await newDeal({ scope: { productIds: [item.id], categoryIds: [], brandIds: [] }, allowPoints: false });
		const lines = [{ productId: item.id }];
		expect((await quote({ lines })).json.promotions.pointsBlocked).toBe(true);
		await shop.setting('deals', 'pointsBlockedBy', 'cart_offer');
		expect((await quote({ lines })).json.promotions.pointsBlocked).toBe(false);
		await shop.setting('deals', 'pointsBlockedBy', 'any_deal');
		await shop.api('DELETE', `/v1/deals/${own.id}`);
	});

	it('shows deals on product cards', async () => {
		const item = await shop.seedProduct({ price: 1000, stock: 5 });
		const deal = await newDeal({ scope: { productIds: [item.id], categoryIds: [], brandIds: [] }, badgeLabel: 'Hot' });
		const listing = await visit('GET', `/v1/shop/products?ids=${item.id}`);
		const card = listing.json.items.find((/** @type {any} */ c) => c.id === item.id);
		expect(card).toMatchObject({ dealCount: 1, deal: { id: deal.id, badgeLabel: 'Hot' } });
		await shop.api('DELETE', `/v1/deals/${deal.id}`);
	});

	it('keeps a locked price after the deal ends, until the lock ends', async () => {
		await shop.setting('deals', 'lockMinutes', 30);
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const deal = await newDeal({ scope: { productIds: [item.id], categoryIds: [], brandIds: [] }, value: 20 });
		const shopper = await newShopper();
		const first = await quote({ lines: [{ productId: item.id }] }, shopper.token);
		const lock = first.json.lines[0].lock;
		expect(typeof lock).toBe('string');
		await shop.api('PATCH', `/v1/deals/${deal.id}`, { active: false });
		const kept = await place({ lines: [{ productId: item.id, lock }], payment: 'cod', address: ADDRESS }, shopper.token);
		expect(kept.status).toBe(201);
		expect(kept.json.order.totals.discount).toBe(200);
		shop.advance(31 * 60_000);
		const late = await quote({ lines: [{ productId: item.id, lock }] }, shopper.token);
		expect(late.json.totals.discount).toBe(0);
		await shop.setting('deals', 'lockMinutes', 0);
		await shop.api('DELETE', `/v1/deals/${deal.id}`);
	});
});

describe('role pricing (E19)', () => {
	it('takes the role percent off the goods after deals, before delivery', async () => {
		await shop.list('role_prices', [{ role: 'member', percent: 10, label: 'Member price' }]);
		const item = await shop.seedProduct({ price: 2000, stock: 10 });
		const member = await newShopper({ role: 'member' });
		const body = { lines: [{ productId: item.id }], delivery: { city: 'Springfield' } };
		const priced = await quote(body, member.token);
		expect(priced.json.totals).toMatchObject({ roleDiscount: 200, delivery: 300 });
		expect(priced.json.role).toMatchObject({ key: 'member', percent: 10, label: 'Member price' });
		const other = await newShopper({ role: 'customer' });
		expect((await quote(body, other.token)).json.totals.roleDiscount).toBe(0);
		await shop.list('role_prices', []);
	});

	it('gives a role its fixed prices per product or variant, and the order keeps them (E31)', async () => {
		const listed = await shop.seedProduct({ price: 2000, stock: 10 });
		const unlisted = await shop.seedProduct({ price: 1000, stock: 10 });
		await shop.list('role_prices', [
			{
				role: 'trade',
				kind: 'prices',
				label: 'Trade price',
				prices: [{ productId: listed.id, variantId: null, price: 1500 }],
			},
		]);
		const trader = await newShopper({ role: 'trade' });
		const body = {
			lines: [
				{ productId: listed.id, quantity: 2 },
				{ productId: unlisted.id, quantity: 1 },
			],
			delivery: { city: 'Springfield' },
		};
		const priced = await quote(body, trader.token);
		expect(priced.json.totals).toMatchObject({ subtotal: 5000, roleDiscount: 1000 });
		expect(priced.json.role).toEqual({ key: 'trade', kind: 'prices', percent: 0, label: 'Trade price' });
		expect((await quote(body, (await newShopper({ role: 'customer' })).token)).json.totals.roleDiscount).toBe(0);
		// the order keeps the role's prices of its products
		const placed = await place({ ...body, payment: 'cod', address: ADDRESS }, trader.token);
		expect(placed.status).toBe(201);
		expect((await orderRecord(placed.json.order.id)).promotions.role).toEqual({
			key: 'trade',
			kind: 'prices',
			percent: 0,
			label: 'Trade price',
			prices: [{ productId: listed.id, variantId: null, price: 1500 }],
		});
		await shop.list('role_prices', []);
	});
});

describe('guest checkout and order keys (E21)', () => {
	it('lets a guest order with a phone, read the order with its key and claims it at sign-in', async () => {
		expect((await visit('GET', '/v1/widget/config')).json.settings.checkout.guests).toBeNull();
		await shop.setting('checkout', 'guests', 'on');
		// the cart widget offers guest checkout as the setting says
		expect((await visit('GET', '/v1/widget/config')).json.settings.checkout.guests).toEqual({
			identity: 'phone',
			phoneRequired: true,
		});
		await shop.setting('checkout', 'defaultCallingCode', '+1');
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const placed = await place({
			lines: [{ productId: item.id }],
			payment: 'cod',
			address: ADDRESS,
			customer: { name: 'Gina Guest', phone: '555 000 7777' },
		});
		expect(placed.status).toBe(201);
		const { order, orderKey } = placed.json;
		expect(orderKey).toHaveLength(32);
		expect((await orderRecord(order.id)).customer).toMatchObject({ userId: '', phone: '+15550007777' });

		expect((await visit('GET', `/v1/shop/orders/${order.id}`)).status).toBeGreaterThanOrEqual(400);
		const read = await visit('GET', `/v1/shop/orders/${order.id}`, { orderKey });
		expect(read.json.number).toBe(order.number);
		// the order says its invoice can be read, and the same key opens it (E21, E35)
		expect(read.json.invoice).toBe(true);
		const invoice = await visit('GET', `/v1/shop/orders/${order.id}/invoice`, { orderKey });
		expect(invoice.status).toBe(200);
		expect(invoice.text).toContain(order.number);
		expect((await visit('GET', `/v1/shop/orders/${order.id}/invoice`)).json.type).toMatch(/sign_in_required$/);
		expect((await visit('GET', `/v1/shop/orders/${order.id}/invoice`, { orderKey: 'x'.repeat(32) })).status).toBe(404);
		await shop.setting('invoices', 'shopperFrom', 'confirmed');
		expect((await visit('GET', `/v1/shop/orders/${order.id}`, { orderKey })).json.invoice).toBe(false);
		expect((await visit('GET', `/v1/shop/orders/${order.id}/invoice`, { orderKey })).status).toBe(404);
		await shop.setting('invoices', 'shopperFrom', 'placed');
		const byNumber = await visit('GET', `/v1/shop/orders/by-number/${order.number}`, { orderKey });
		expect(byNumber.json.id).toBe(order.id);
		const wrong = await visit('GET', `/v1/shop/orders/by-number/${order.number}`, { orderKey: 'x'.repeat(32) });
		expect(wrong.status).toBeGreaterThanOrEqual(400);

		// what staff keep on the guest's record (review M4): its note and customer field values
		const taxNumber = (await shop.api('POST', '/v1/attributes', { name: 'Tax number', on: 'customer' })).json.id;
		const guestId = (await orderRecord(order.id)).customer.customerId;
		const kept = await shop.api('PATCH', `/v1/customers/${guestId}`, {
			note: 'Prefers morning delivery',
			fields: { [taxNumber]: 'TX-1' },
		});
		expect(kept.status).toBe(200);

		const member = await newShopper({ phone: '+15550007777' });
		const mine = await visit('GET', '/v1/shop/orders', { signIn: member.token });
		expect(mine.json.items.map((/** @type {any} */ o) => o.id)).toContain(order.id);
		expect((await orderRecord(order.id)).customer.userId).toBe(member.id);
		const folded = await shop.api('GET', `/v1/customers/${member.id}`);
		expect(folded.json.fields).toEqual({ [taxNumber]: 'TX-1' });
		expect(folded.json.note).toBe('Prefers morning delivery');
		expect((await shop.api('GET', `/v1/customers/${guestId}`)).status).toBe(404);
		await shop.api('DELETE', `/v1/attributes/${taxNumber}`);
		await shop.setting('checkout', 'guests', 'off');
	});

	it('links a guest order on a member’s phone to the member’s record, theirs only at a verified sign-in (K-6)', async () => {
		await shop.setting('checkout', 'guests', 'on');
		await shop.setting('checkout', 'defaultCallingCode', '+1');
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const member = await newShopper({ phone: '+15550005555' });
		const first = await place({ lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS }, member.token);
		expect(first.status).toBe(201);
		const asGuest = await place({
			lines: [{ productId: item.id }],
			payment: 'cod',
			address: ADDRESS,
			customer: { name: 'Sara', phone: '555 000 5555' },
		});
		expect(asGuest.status).toBe(201);
		expect(asGuest.json.orderKey).toHaveLength(32);
		const records = await (
			await shop.db()
		)
			.collection(COLLECTIONS.customers)
			.find({ websiteId: shop.websiteId, phone: '+15550005555' })
			.toArray();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			userId: member.id,
			orderCount: 2,
			name: 'Sara Shopper',
			createdAt: new Date(shop.now()),
		});
		// the member's record counts it, but nobody's account holds it yet (owner, 2026-10-14 (2)): whoever typed the
		// phone reads it with its order key
		expect((await orderRecord(asGuest.json.order.id)).customer).toMatchObject({ userId: '', customerId: records[0]?.id });
		const staff = await shop.api('GET', `/v1/customers/${records[0]?.id}`);
		expect(staff.json.recentOrders.map((/** @type {any} */ o) => o.id)).toContain(asGuest.json.order.id);
		expect(staff.json.orderCount).toBe(2);
		// the same account signed in without a verified phone does not get it
		const unverified = await shop.accounts.signIn({
			websiteId: shop.websiteId,
			sub: member.id,
			name: 'Sara Shopper',
			email: 'sara-unverified@example.com',
			phone: '+15550005555',
			phone_verified: false,
		});
		const notYet = await visit('GET', '/v1/shop/orders', { signIn: unverified });
		expect(notYet.json.items.map((/** @type {any} */ o) => o.id)).not.toContain(asGuest.json.order.id);
		expect((await orderRecord(asGuest.json.order.id)).customer.userId).toBe('');
		// a sign-in that proves the phone moves it into the member's account
		const mine = await visit('GET', '/v1/shop/orders', { signIn: member.token });
		expect(mine.json.items.map((/** @type {any} */ o) => o.id)).toContain(asGuest.json.order.id);
		expect((await orderRecord(asGuest.json.order.id)).customer).toMatchObject({
			userId: member.id,
			customerId: records[0]?.id,
		});

		await shop.api('PATCH', `/v1/customers/${records[0]?.id}`, { blocked: true, blockedReason: 'Refused packages' });
		const refused = await place({
			lines: [{ productId: item.id }],
			payment: 'cod',
			address: ADDRESS,
			customer: { name: 'Sara', phone: '+15550005555' },
		});
		expect(codeOf(refused)).toBe('customer_blocked');
		await shop.setting('checkout', 'guests', 'off');
	});

	it('reads a guest’s and an address’s phone as one E.164 number however it is typed (K12)', async () => {
		await shop.setting('checkout', 'guests', 'on');
		await shop.setting('checkout', 'defaultCallingCode', '+44');
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const local = await place({
			lines: [{ productId: item.id }],
			payment: 'cod',
			address: { ...ADDRESS, phone: 'call me' },
			customer: { name: 'Sam Guest', phone: '07700900123' },
		});
		expect(local.json.errors[0].path).toBe('/address/phone');
		/** @type {string[]} */
		const ids = [];
		for (const phone of ['07700900123', '447700900123', '+44 07700 900123']) {
			const placed = await place({
				lines: [{ productId: item.id }],
				payment: 'cod',
				address: { ...ADDRESS, phone: '+44 07700 900456' },
				customer: { name: 'Sam Guest', phone },
			});
			expect(placed.status).toBe(201);
			ids.push(placed.json.order.id);
		}
		for (const id of ids) {
			const record = await orderRecord(id);
			expect(record.customer.phone).toBe('+447700900123');
			expect(record.address.phone).toBe('+447700900456');
		}
		const records = await (
			await shop.db()
		)
			.collection(COLLECTIONS.customers)
			.find({ websiteId: shop.websiteId, phone: '+447700900123' })
			.toArray();
		expect(records).toHaveLength(1);
		expect(records[0]?.orderCount).toBe(3);
		for (const id of ids) await shop.api('DELETE', `/v1/orders/${id}`);
		await shop.setting('checkout', 'defaultCallingCode', '+1');
		await shop.setting('checkout', 'guests', 'off');
	});

	it('takes a guest’s phone only of the countries the website serves (checkout.countries, SE-5)', async () => {
		await shop.setting('checkout', 'guests', 'on');
		await shop.setting('checkout', 'countries', ['US']);
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		/** @param {string} phone */
		const asGuest = (phone) =>
			place({ lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS, customer: { name: 'Lee Guest', phone } });
		const abroad = await asGuest('+447700900123');
		expect(abroad.status).toBe(422);
		expect(abroad.json.errors[0]).toMatchObject({ path: '/customer/phone', code: 'country_not_allowed' });
		const local = await asGuest('+15550004444');
		expect(local.status).toBe(201);
		await shop.api('DELETE', `/v1/orders/${local.json.order.id}`);
		await shop.setting('checkout', 'countries', []);
		expect((await asGuest('+447700900123')).status).toBe(201);
		await shop.setting('checkout', 'guests', 'off');
	});

	it('asks a guest whose phone has an account with a password to sign in', async () => {
		await shop.setting('checkout', 'guests', 'unless_password');
		shop.responders.set(`${ACCOUNTS}/v1/users`, () => ({
			status: 200,
			body: { items: [{ id: 'usr_member', phone: '+15550006666', hasPassword: true }], hasMore: false },
		}));
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const refused = await place({
			lines: [{ productId: item.id }],
			payment: 'cod',
			address: ADDRESS,
			customer: { name: 'Mo Member', phone: '+15550006666' },
		});
		shop.responders.delete(`${ACCOUNTS}/v1/users`);
		expect(refused.status).toBe(403);
		expect(refused.json).toMatchObject({ signIn: 'member_phone' });
		expect(codeOf(refused)).toBe('sign_in_required');
		await shop.setting('checkout', 'guests', 'off');
	});

	it('stops a burst of orders at ORDER_BURST_LIMIT in ORDER_BURST_WINDOW_MINUTES, per customer', async () => {
		await shop.setting('checkout', 'guests', 'on');
		try {
			const item = await shop.seedProduct({ price: 1000, stock: 40 });
			const data = await shop.db();
			const guest = (/** @type {string} */ phone) =>
				place({ lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS, customer: { name: 'Bea Burst', phone } });
			// orders that are no longer waiting do not count towards the cap of waiting orders, only towards the burst
			const settle = () =>
				data.collection(COLLECTIONS.orders).updateMany({ websiteId: shop.websiteId }, { $set: { role: 'open' } });
			for (let i = 0; i < ORDER_BURST_LIMIT; i += 1) {
				expect((await guest('+15550007101')).status).toBe(201);
				await settle();
			}
			const burst = await guest('+1 555 000 7101');
			expect(burst.status).toBe(429);
			expect(codeOf(burst)).toBe('too_many_orders');
			// another customer is not held up, and the window passes
			expect((await guest('+15550007102')).status).toBe(201);
			await settle();
			shop.advance(ORDER_BURST_WINDOW_MINUTES * 60_000 + 1);
			expect((await guest('+15550007101')).status).toBe(201);
		} finally {
			await shop.setting('checkout', 'guests', 'off');
		}
	});

	it('takes guests by email (guestIdentity email, phoneRequired off): one record per email address, no phone needed', async () => {
		await shop.setting('checkout', 'guests', 'on');
		await shop.setting('checkout', 'guestIdentity', 'email');
		await shop.setting('checkout', 'phoneRequired', false);
		// the cart widget asks what the settings say
		expect((await visit('GET', '/v1/widget/config')).json.settings.checkout.guests).toEqual({
			identity: 'email',
			phoneRequired: false,
		});
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const noPhone = {
			name: 'Ella Guest',
			line1: '1 Main Street',
			city: 'Springfield',
			region: 'IL',
			postalCode: '62701',
			country: 'US',
		};
		/** @param {Record<string, unknown>} customer */
		const asGuest = (customer) =>
			place({
				lines: [{ productId: item.id }],
				payment: 'cod',
				address: noPhone,
				customer: { name: 'Ella Guest', ...customer },
			});
		// the email address is the guest's identity: a phone alone is not enough
		const phoneOnly = await asGuest({ phone: '+15550003333' });
		expect(phoneOnly.status).toBe(422);
		expect(phoneOnly.json.errors[0].path).toBe('/customer/email');
		const first = await asGuest({ email: 'Ella@Example.com' });
		expect(first.status).toBe(201);
		const second = await asGuest({ email: 'ella@example.com', phone: '+15550003333' });
		expect(second.status).toBe(201);
		const db = await shop.db();
		const records = await db
			.collection(COLLECTIONS.customers)
			.find({ websiteId: shop.websiteId, guestKey: 'e:ella@example.com' })
			.toArray();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ guest: true, email: 'ella@example.com', orderCount: 2, phone: '+15550003333' });
		expect((await orderRecord(first.json.order.id)).address).toMatchObject({ phone: '', region: 'IL' });
		// another email guest without a phone is another record (no clash on the empty phone, as the phone-only index had)
		const other = await asGuest({ email: 'otto@example.com' });
		expect(other.status).toBe(201);
		expect(
			await db.collection(COLLECTIONS.customers).countDocuments({ websiteId: shop.websiteId, guest: true, phone: '' }),
		).toBeGreaterThanOrEqual(1);
		const staff = await shop.api('GET', `/v1/customers/${records[0]?.id}`);
		expect(staff.json).toMatchObject({ guest: true, guestKey: 'e:ella@example.com' });

		// a member who signs in with that email address verified gets the guest's orders and record
		const member = await newShopper({ email: 'ella@example.com', phone: '+15550009991' });
		const mine = await visit('GET', '/v1/shop/orders', { signIn: member.token });
		expect(mine.json.items.map((/** @type {any} */ o) => o.id)).toEqual(
			expect.arrayContaining([first.json.order.id, second.json.order.id]),
		);
		expect((await shop.api('GET', `/v1/customers/${records[0]?.id}`)).status).toBe(404);
		for (const id of [first.json.order.id, second.json.order.id, other.json.order.id])
			await shop.api('DELETE', `/v1/orders/${id}`);
		await shop.setting('checkout', 'phoneRequired', true);
		await shop.setting('checkout', 'guestIdentity', 'phone');
		await shop.setting('checkout', 'guests', 'off');
	});

	it('moves an email guest’s orders only at a sign-in whose email Accounts verified', async () => {
		await shop.setting('checkout', 'guests', 'on');
		await shop.setting('checkout', 'guestIdentity', 'email');
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const placed = await place({
			lines: [{ productId: item.id }],
			payment: 'cod',
			address: ADDRESS,
			customer: { name: 'Vera Guest', email: 'vera@example.com', phone: '+15550002222' },
		});
		expect(placed.status).toBe(201);
		const unverified = await newShopper({ email: 'vera@example.com', email_verified: false, phone: '+15550009992' });
		const notYet = await visit('GET', '/v1/shop/orders', { signIn: unverified.token });
		expect(notYet.json.items.map((/** @type {any} */ o) => o.id)).not.toContain(placed.json.order.id);
		expect((await orderRecord(placed.json.order.id)).customer.userId).toBe('');
		await shop.api('DELETE', `/v1/orders/${placed.json.order.id}`);
		await shop.setting('checkout', 'guestIdentity', 'phone');
		await shop.setting('checkout', 'guests', 'off');
	});

	it('knows a guest by the phone when given, else the email address (guestIdentity either)', async () => {
		await shop.setting('checkout', 'guests', 'on');
		await shop.setting('checkout', 'guestIdentity', 'either');
		await shop.setting('checkout', 'phoneRequired', false);
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const noPhone = { name: 'Ann Guest', line1: '1 Main Street', city: 'Springfield' };
		/** @param {Record<string, unknown>} customer */
		const asGuest = (customer) =>
			place({
				lines: [{ productId: item.id }],
				payment: 'cod',
				address: noPhone,
				customer: { name: 'Ann Guest', ...customer },
			});
		const neither = await asGuest({});
		expect(neither.status).toBe(422);
		expect(neither.json.errors[0].path).toBe('/customer/phone');
		const byPhone = await asGuest({ phone: '+15550001234', email: 'ann@example.com' });
		const byEmail = await asGuest({ email: 'ann@example.com' });
		expect([byPhone.status, byEmail.status]).toEqual([201, 201]);
		const db = await shop.db();
		const recordOf = async (/** @type {string} */ id) =>
			db
				.collection(COLLECTIONS.customers)
				.findOne({ websiteId: shop.websiteId, id: (await orderRecord(id)).customer.customerId });
		expect((await recordOf(byPhone.json.order.id))?.guestKey).toBe('p:+15550001234');
		expect((await recordOf(byEmail.json.order.id))?.guestKey).toBe('e:ann@example.com');
		for (const id of [byPhone.json.order.id, byEmail.json.order.id]) await shop.api('DELETE', `/v1/orders/${id}`);
		await shop.setting('checkout', 'phoneRequired', true);
		await shop.setting('checkout', 'guestIdentity', 'phone');
		await shop.setting('checkout', 'guests', 'off');
	});

	it('asks a guest whose email address has an account with a password to sign in', async () => {
		await shop.setting('checkout', 'guests', 'unless_password');
		await shop.setting('checkout', 'guestIdentity', 'either');
		/** @type {string[]} */
		const asked = [];
		shop.responders.set(`${ACCOUNTS}/v1/users`, (call) => {
			asked.push(call.url);
			return {
				status: 200,
				body: {
					items: [{ id: 'usr_member', email: 'Mo@Example.com', phone: '+15550006667', hasPassword: true }],
					hasMore: false,
				},
			};
		});
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const refused = await place({
			lines: [{ productId: item.id }],
			payment: 'cod',
			address: ADDRESS,
			customer: { name: 'Mo Member', email: 'mo@example.com', phone: '+15550004321' },
		});
		shop.responders.delete(`${ACCOUNTS}/v1/users`);
		expect(refused.status).toBe(403);
		expect(refused.json).toMatchObject({ signIn: 'member_email' });
		expect(asked.some((url) => url.includes('q=mo%40example.com'))).toBe(true);
		await shop.setting('checkout', 'guestIdentity', 'phone');
		await shop.setting('checkout', 'guests', 'off');
	});

	it('refuses guests while guest checkout is off', async () => {
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const placed = await place({
			lines: [{ productId: item.id }],
			payment: 'cod',
			address: ADDRESS,
			customer: { name: 'Gina Guest', phone: '+15550008888' },
		});
		expect(codeOf(placed)).toBe('sign_in_required');
	});
});

describe('payment, delivery and COD options (E22, E23)', () => {
	it('orders methods, adds notes and the COD fee, and starts COD open when asked', async () => {
		await shop.methods({}, ['bank_transfer', 'cod', 'online', 'pickup']);
		await shop.methods({ cod: { note: 'Pay the rider' } });
		await shop.methods({ cod: { feePercent: 5 } });
		await shop.flow((flow) => ({ ...flow, starts: { ...flow.starts, on_delivery: 'confirmed' } }));
		const item = await shop.seedProduct({ price: 10_000, stock: 10 });
		const shopper = await newShopper();
		const priced = await quote(
			{ lines: [{ productId: item.id }], delivery: { city: 'Springfield' }, payment: 'cod' },
			shopper.token,
		);
		expect(priced.json.paymentMethods.map((/** @type {any} */ m) => m.method).slice(0, 2)).toEqual(['bank_transfer', 'cod']);
		expect(priced.json.paymentMethods.find((/** @type {any} */ m) => m.method === 'cod').note).toBe('Pay the rider');
		expect(priced.json.totals).toMatchObject({ fee: 515, total: 10_815 });
		const placed = await place({ lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS }, shopper.token);
		expect(placed.json.order).toMatchObject({ totals: { fee: 515 } });
		expect((await orderRecord(placed.json.order.id)).role).toBe('open');
		await shop.methods({ cod: { feePercent: 0 } });
		await shop.flow((flow) => ({ ...flow, starts: { ...flow.starts, on_delivery: 'awaiting_confirmation' } }));
		await shop.methods({}, ['online', 'bank_transfer', 'cod', 'pickup']);
		await shop.methods({ cod: { note: '' } });
	});

	it('lets staff switch a payment method off for new orders, kept on orders staff edit (active, AO-2)', async () => {
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const shopper = await newShopper();
		const body = { lines: [{ productId: item.id }], delivery: { city: 'Springfield' } };
		/** @param {any} answer */
		const methods = (answer) => answer.json.paymentMethods.map((/** @type {any} */ m) => m.method);
		const before = await place({ ...body, payment: 'cod', address: ADDRESS }, shopper.token);
		expect(before.status).toBe(201);
		expect(methods(await quote(body))).toContain('cod');
		await shop.methods({ cod: { active: false } });
		expect(methods(await quote(body))).not.toContain('cod');
		const refused = await place({ ...body, payment: 'cod', address: ADDRESS }, shopper.token);
		expect(refused.json.errors[0].path).toBe('/payment');
		const offered = (await visit('GET', '/v1/widget/config')).json.settings.checkout.paymentMethods;
		expect(offered.map((/** @type {any} */ m) => m.key)).not.toContain('cod');
		// an order placed before keeps cash on delivery when staff edit it
		const variantId = /** @type {any} */ (item.variants[0]).id;
		const edited = await shop.api('PATCH', `/v1/orders/${before.json.order.id}`, { lines: [{ variantId, quantity: 2 }] });
		expect(edited.status).toBe(200);
		expect(edited.json.payment.method).toBe('cod');
		await shop.methods({ cod: { active: true } });
		expect(methods(await quote(body))).toContain('cod');
		await shop.api('DELETE', `/v1/orders/${before.json.order.id}`);
	});

	it('takes the COD fee on the goods after discounts with feeBase goods_after_discounts (D4)', async () => {
		await shop.methods({ cod: { feePercent: 5 } });
		await shop.methods({ cod: { feeBase: 'goods_after_discounts' } });
		const item = await shop.seedProduct({ price: 10_000, stock: 10 });
		const shopper = await newShopper();
		const body = { lines: [{ productId: item.id }], delivery: { city: 'Springfield' }, payment: 'cod' };
		// 5% of the 10,000 goods, not of the 10,300 with delivery (515)
		const priced = await quote(body, shopper.token);
		expect(priced.json.totals).toMatchObject({ delivery: 300, fee: 500, total: 10_800 });
		expect(priced.json.paymentMethods.find((/** @type {any} */ m) => m.method === 'cod')).toMatchObject({ fee: 500 });
		const placed = await place({ lines: body.lines, payment: 'cod', address: ADDRESS }, shopper.token);
		expect(placed.json.order.totals).toMatchObject({ fee: 500, total: 10_800 });
		await shop.methods({ cod: { feeBase: 'order_total' } });
		await shop.methods({ cod: { feePercent: 0 } });
	});

	it('refuses a total other than the one the shopper was shown, with the new quote (CK-14)', async () => {
		const item = await shop.seedProduct({ price: 10_000, stock: 10 });
		const deal = await newDeal({ scope: { productIds: [item.id], categoryIds: [], brandIds: [] }, value: 10 });
		const shopper = await newShopper();
		const body = { lines: [{ productId: item.id }], delivery: { city: 'Springfield' }, payment: 'cod' };
		const shown = (await quote(body, shopper.token)).json.totals.total;
		expect(shown).toBe(9300);
		// the deal ends before the order is placed
		await shop.api('PATCH', `/v1/deals/${deal.id}`, { active: false });
		const order = { lines: body.lines, payment: 'cod', address: ADDRESS, expectedTotal: shown };
		const changed = await place(order, shopper.token);
		expect(changed.status).toBe(409);
		expect(codeOf(changed)).toBe('price_changed');
		expect(changed.json.quote.totals).toMatchObject({ discount: 0, total: 10_300 });
		expect((await place({ ...order, expectedTotal: 10_300 }, shopper.token)).status).toBe(201);
		expect((await place({ ...order, expectedTotal: -5 }, shopper.token)).status).toBe(422);
		await shop.api('DELETE', `/v1/deals/${deal.id}`);
	});

	it('limits lines and quantities and sends the shopper to the store’s own success page', async () => {
		await shop.setting('checkout', 'successUrl', `${ORIGIN}/thanks/{number}`);
		const item = await shop.seedProduct({ price: 1000, stock: 200 });
		const shopper = await newShopper();
		// 99 of one item (CART_MAX_QUANTITY) and 50 lines (CART_MAX_LINES) at most
		const tooMany = await place(
			{ lines: [{ productId: item.id, quantity: CART_MAX_QUANTITY + 1 }], payment: 'cod', address: ADDRESS },
			shopper.token,
		);
		expect(tooMany.status).toBe(422);
		const lines = Array.from({ length: CART_MAX_LINES + 1 }, () => ({ productId: item.id, variantId: createId('var') }));
		expect((await place({ lines, payment: 'cod', address: ADDRESS }, shopper.token)).status).toBe(422);
		const placed = await place(
			{ lines: [{ productId: item.id, quantity: CART_MAX_QUANTITY }], payment: 'cod', address: ADDRESS },
			shopper.token,
		);
		expect(placed.json.next).toEqual({ kind: 'done', url: `${ORIGIN}/thanks/${placed.json.order.number}` });
		await shop.setting('checkout', 'successUrl', '');
	});
});

describe('the way back from Payments (E22)', () => {
	it('sends the shopper back to the website’s home with the order when nothing else is set', async () => {
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const shopper = await newShopper();
		const placed = await place({ lines: [{ productId: item.id }], payment: 'online', address: ADDRESS }, shopper.token);
		expect(placed.json.next.kind).toBe('pay');
		const create = JSON.parse(
			String(
				shop
					.callsTo(PAYMENTS)
					.filter((c) => c.path === '/v1/payments')
					.at(-1)?.body,
			),
		);
		expect(create.returnUrl).toBe(`${ORIGIN}/?ss_order=${placed.json.order.id}`);
		expect(create.cancelUrl).toBe(create.returnUrl);
	});

	it('ends the checkout at Payments when the order’s time to pay ends: one timer (expiresAt)', async () => {
		/** @param {string} id */
		const created = async (id) => {
			const record = await orderRecord(id);
			const body = shop
				.callsTo(PAYMENTS)
				.filter((c) => c.path === '/v1/payments')
				.map((c) => JSON.parse(String(c.body)))
				.find((each) => each.metadata?.orderId === id);
			return { record, body };
		};
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const shopper = await newShopper();
		const placed = await place({ lines: [{ productId: item.id }], payment: 'online', address: ADDRESS }, shopper.token);
		const { record, body } = await created(placed.json.order.id);
		// the order's time to pay (60 minutes by default) is the checkout's end
		expect(record.holdUntil).toBeInstanceOf(Date);
		expect(body.expiresAt).toBe(record.holdUntil.toISOString());
		// the default time to pay is 60 minutes, counted from the moment the order was made
		expect(Math.abs(Date.parse(body.expiresAt) - Date.parse(record.placedAt) - 60 * 60_000)).toBeLessThan(1000);
		// an order with no time to pay (0 = never canceled) leaves the end to Payments' own setting
		await shop.setting('checkout', 'paymentWindowMinutes', 0);
		try {
			const second = await place({ lines: [{ productId: item.id }], payment: 'online', address: ADDRESS }, shopper.token);
			expect((await created(second.json.order.id)).body).not.toHaveProperty('expiresAt');
		} finally {
			await shop.setting('checkout', 'paymentWindowMinutes', 60);
		}
	});
});

describe('bank transfers recorded by staff (E24)', () => {
	it('waits for the payment without Payments and takes the shopper’s proof', async () => {
		await shop.methods({ bank_transfer: { via: 'manual', instructions: 'Pay to account 0000 0000.' } });
		await shop.connectStorage();
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const shopper = await newShopper();
		const placed = await place({ lines: [{ productId: item.id }], payment: 'bank_transfer', address: ADDRESS }, shopper.token);
		expect(placed.status).toBe(201);
		const id = placed.json.order.id;
		const record = await orderRecord(id);
		expect(record).toMatchObject({ role: 'awaiting_payment', payment: { paymentId: null, via: 'manual' } });
		const upload = await visit('POST', `/v1/shop/orders/${id}/proof/upload`, {
			signIn: shopper.token,
			body: { type: 'image/png', size: 1000 },
		});
		expect(upload.status).toBeLessThan(300);
		expect(upload.json.key).toMatch(new RegExp(`^ecommerce/proofs/${id}/`));
		const sent = await visit('POST', `/v1/shop/orders/${id}/proof`, {
			signIn: shopper.token,
			body: { key: upload.json.key, reference: 'TRX-42' },
		});
		expect(sent.status).toBeLessThan(300);
		expect((await orderRecord(id)).payment.proof).toMatchObject({ key: upload.json.key, reference: 'TRX-42' });
		expect((await orderRecord(id)).history.at(-1)).toMatchObject({ by: 'shopper', code: 'proof_sent' });
		// staff see the proof with a short-lived link to open it; the shopper sees what was sent, never the file's key
		const staff = await shop.api('GET', `/v1/orders/${id}`);
		expect(staff.json.payment.proof).toMatchObject({ key: upload.json.key, reference: 'TRX-42', url: expect.any(String) });
		expect(staff.json.payment.proof.url).toMatch(/^https:\/\//);
		expect(sent.json.order.payment.proof).toEqual({ reference: 'TRX-42', at: expect.any(String) });
		expect(sent.json.order.canSendProof).toBe(true);
		const elsewhere = await visit('POST', `/v1/shop/orders/${id}/proof`, {
			signIn: shopper.token,
			body: { key: 'ecommerce/proofs/ord_other/x.png' },
		});
		expect(elsewhere.status).toBe(422);
		// with its proof the order waits for staff past the payment window; one without a proof ends with it
		expect((await orderRecord(id)).holdUntil).toBeNull();
		const seen = await visit('GET', `/v1/shop/orders/${id}`, { signIn: shopper.token });
		expect(seen.json.payment.payBy).toBeNull();
		await shop.setting('checkout', 'paymentWindowMinutes', 60);
		const unproved = await place(
			{ lines: [{ productId: item.id }], payment: 'bank_transfer', address: ADDRESS },
			shopper.token,
		);
		expect((await orderRecord(unproved.json.order.id)).holdUntil).not.toBeNull();
		shop.advance(61 * 60_000);
		await visit('POST', '/v1/shop/cart/quote', { body: { lines: [{ productId: item.id }] } });
		expect((await orderRecord(unproved.json.order.id)).role).toBe('canceled');
		expect((await orderRecord(id)).role).toBe('awaiting_payment');
		await shop.methods({ bank_transfer: { via: 'payments' } });
	});

	it('offers a method paid first only once it tells shoppers how to pay: its own accounts, or Payments’ (CK-33, E8)', async () => {
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const body = { lines: [{ productId: item.id }], delivery: { city: 'Springfield' } };
		const none = { name: 'Bank transfer', instructions: '', accounts: [] };
		/** The bank transfer option while Payments answers this `bank_transfer` method. @param {Record<string, unknown>} details */
		const bankWith = async (details) => {
			shop.responders.set(`${PAYMENTS}/v1/manual-methods`, () => ({
				status: 200,
				body: {
					methods: [
						{ key: 'check', kind: 'pay_first', ready: true },
						{ key: 'bank_transfer', kind: 'pay_first', ...details },
					],
				},
			}));
			// the details are read again once the copy kept for 5 minutes is old
			shop.advance(5 * 60_000 + 1000);
			return (await quote(body)).json.paymentMethods.find((/** @type {any} */ m) => m.method === 'bank_transfer');
		};
		// through Payments (the default): Payments' manual method of the same key, for the shop's currency
		expect(await bankWith({ ready: false, ...none })).toMatchObject({ available: false, reason: 'not_ready' });
		expect(shop.callsTo(`${PAYMENTS}/v1/manual-methods`).at(-1)?.url).toContain('currency=USD');
		const shopper = await newShopper();
		const refused = await place({ ...body, payment: 'bank_transfer', address: ADDRESS }, shopper.token);
		expect([refused.status, refused.json.paymentReason]).toEqual([422, 'not_ready']);
		const account = { label: '', currency: '', rows: [{ label: 'Account number', value: '0123456789' }] };
		expect(await bankWith({ ready: true, ...none, accounts: [account] })).toMatchObject({ available: true });
		// the quote shows the merchant's own rows as Payments answers them, whatever the country's fields
		const accounts = [
			{
				label: 'Example Bank',
				currency: 'USD',
				rows: [
					{ label: 'Account holder', value: 'Example Shop Ltd' },
					{ label: 'IBAN', value: 'GB33BUKB20201555555555' },
					{ label: 'SWIFT/BIC', value: 'BUKBGB22' },
				],
			},
		];
		await bankWith({ ready: true, ...none, instructions: 'Use the order number as the reference.', accounts });
		expect((await quote(body)).json.payDetails).toEqual({
			bank_transfer: { ready: true, name: 'Bank transfer', instructions: 'Use the order number as the reference.', accounts },
		});
		// Payments without that method: not ready
		shop.responders.set(`${PAYMENTS}/v1/manual-methods`, () => ({ status: 200, body: { methods: [] } }));
		shop.advance(5 * 60_000 + 1000);
		expect((await quote(body)).json.paymentMethods.find((/** @type {any} */ m) => m.method === 'bank_transfer')).toMatchObject({
			reason: 'not_ready',
		});
		shop.responders.delete(`${PAYMENTS}/v1/manual-methods`);

		// by hand: the method's own accounts for the shop's currency (else those for any currency), never Payments'
		await shop.methods({ bank_transfer: { via: 'manual' } });
		expect((await quote(body)).json.paymentMethods.find((/** @type {any} */ m) => m.method === 'bank_transfer')).toMatchObject({
			reason: 'not_ready',
		});
		await shop.methods({
			bank_transfer: {
				accounts: [
					{ label: 'Euro', currency: 'EUR', rows: [{ label: 'IBAN', value: 'DE89370400440532013000' }] },
					{
						label: 'Main',
						currency: '',
						rows: [
							{ label: 'Account', value: '0000 0000' },
							{ label: 'Sort code', value: '' },
						],
					},
				],
			},
		});
		const own = await quote(body);
		expect(own.json.paymentMethods.find((/** @type {any} */ m) => m.method === 'bank_transfer')).toMatchObject({
			available: true,
		});
		expect(own.json.payDetails.bank_transfer).toEqual({
			ready: true,
			name: 'Bank transfer',
			instructions: '',
			accounts: [{ label: 'Main', currency: '', rows: [{ label: 'Account', value: '0000 0000' }] }],
		});
		await shop.methods({ bank_transfer: { via: 'payments', accounts: [] } });
	});
});

describe('loyalty options (E20)', () => {
	it('answers points to earn, pending points and the newest history', async () => {
		await shop.setting('loyalty', 'earnPercent', 10);
		await shop.setting('loyalty', 'pointValue', 100);
		await shop.setting('loyalty', 'earnAt', 'placement');
		const item = await shop.seedProduct({ price: 10_000, stock: 10 });
		const shopper = await newShopper();
		const priced = await quote({ lines: [{ productId: item.id }] }, shopper.token);
		expect(priced.json.pointsToEarn).toBe(10);
		await place({ lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS }, shopper.token);
		const account = await visit('GET', '/v1/shop/loyalty?limit=5', { signIn: shopper.token });
		expect(account.json).toMatchObject({ balance: 0, lifetimeEarned: 0, pending: 10 });
		await shop.setting('loyalty', 'earnAt', 'delivery');
	});

	it('lets only the roles the settings name earn and redeem, at delivery too', async () => {
		await shop.setting('loyalty', 'earnPercent', 10);
		await shop.setting('loyalty', 'pointValue', 100);
		await shop.setting('loyalty', 'roles', ['vip']);
		const item = await shop.seedProduct({ price: 10_000, stock: 10 });
		const body = { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS };
		/** Place and deliver an order; the shopper's balance after. @param {{ token: string }} who */
		const delivered = async (who) => {
			const placed = await place(body, who.token);
			expect(placed.status).toBe(201);
			const id = placed.json.order.id;
			for (const to of ['confirmed', 'delivered'])
				expect((await shop.api('POST', `/v1/orders/${id}/move`, { to })).status).toBe(200);
			return {
				record: await orderRecord(id),
				balance: (await visit('GET', '/v1/shop/loyalty', { signIn: who.token })).json.balance,
			};
		};
		for (const earnAt of ['delivery', 'placement']) {
			await shop.setting('loyalty', 'earnAt', earnAt);
			const other = await newShopper({ role: 'customer' });
			expect((await quote({ lines: [{ productId: item.id }] }, other.token)).json.pointsToEarn).toBe(0);
			const left = await delivered(other);
			expect(left.record.promotions, earnAt).toMatchObject({ pointsEarned: 0, pointsFixed: true });
			expect(left.balance, earnAt).toBe(0);
			const vip = await newShopper({ role: 'vip' });
			expect((await delivered(vip)).balance, earnAt).toBe(10);
		}
		// points staff gave a shopper of another role are not redeemed at checkout; a vip's are
		const other = await newShopper({ role: 'customer' });
		const vip = await newShopper({ role: 'vip' });
		for (const who of [other, vip])
			expect((await shop.api('POST', `/v1/loyalty/accounts/${who.id}/adjust`, { points: 50 })).status).toBe(200);
		await shop.setting('loyalty', 'minRedeem', 10);
		const spend = { lines: [{ productId: item.id }], points: 20 };
		expect((await quote(spend, other.token)).json.points).toBeNull();
		expect((await quote(spend, vip.token)).json.points).toMatchObject({ balance: 50, used: 20 });
		await shop.setting('loyalty', 'minRedeem', 100);
		await shop.setting('loyalty', 'earnAt', 'delivery');
		await shop.setting('loyalty', 'roles', []);
	});
});

describe('whole-unit amounts (E25)', () => {
	it('rounds deal discounts down and fees half up to whole units', async () => {
		await shop.api('PUT', '/v1/format', { wholeUnits: true });
		await shop.methods({ cod: { feePercent: 3 } });
		const item = await shop.seedProduct({ price: 1999, stock: 10 });
		const deal = await newDeal({ scope: { productIds: [item.id], categoryIds: [], brandIds: [] }, value: 15 });
		const priced = await quote({ lines: [{ productId: item.id }], payment: 'cod', delivery: { city: 'Springfield' } });
		expect(priced.json.totals.discount % 100).toBe(0);
		expect(priced.json.totals.fee % 100).toBe(0);
		await shop.api('DELETE', `/v1/deals/${deal.id}`);
		await shop.methods({ cod: { feePercent: 0 } });
		await shop.api('PUT', '/v1/format', { wholeUnits: false });
	});

	it('rounds the deals once, half up, with rounding total_half_up: cart, order and product price (D4)', async () => {
		await shop.api('PUT', '/v1/format', { wholeUnits: true });
		const item = await shop.seedProduct({ price: 499_900, stock: 10 });
		const deal = await newDeal({ scope: { productIds: [item.id], categoryIds: [], brandIds: [] }, value: 7 });
		// 7% off 4,999.00 is 349.93: per_unit_down gives 349, total_half_up 350
		expect((await quote({ lines: [{ productId: item.id }] })).json.totals.discount).toBe(34_900);
		expect((await shown(item.id)).deal.savings).toBe(34_900);
		await shop.setting('deals', 'rounding', 'total_half_up');
		expect((await quote({ lines: [{ productId: item.id, quantity: 3 }] })).json.totals.discount).toBe(105_000);
		expect(await shown(item.id)).toMatchObject({ price: 464_900, deal: { savings: 35_000 } });
		const shopper = await newShopper();
		const placed = await place({ lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS }, shopper.token);
		expect(placed.json.order.totals).toMatchObject({ discount: 35_000, delivery: 300, total: 465_200 });
		await shop.setting('deals', 'rounding', 'per_unit_down');
		await shop.api('DELETE', `/v1/deals/${deal.id}`);
		await shop.api('PUT', '/v1/format', { wholeUnits: false });
	});
});
