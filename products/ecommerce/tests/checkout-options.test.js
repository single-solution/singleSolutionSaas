/**
 * The Phase 4 checkout options through the API (PLAN 0.8.10 E18–E25): deal rules, pages and cart locks, role pricing,
 * loyalty options, guest checkout with order keys, payment and delivery options, COD options, bank transfers recorded
 * by staff with the shopper's proof, and whole-unit amounts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ACCOUNTS, ORIGIN, PAYMENTS, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let ip = 0;
let users = 0;

const ADDRESS = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' };

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
		{ key: 'city', name: 'Springfield', cities: ['Springfield'], fee: 300, freeOver: 0, minDays: 1, maxDays: 2 },
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
		expect((await visit('GET', `/v1/shop/products/${item.id}/quote`)).json.savings).toBe(500);
		await shop.setting('deals', 'lineChoice', 'best');
		await shop.api('DELETE', `/v1/deals/${percent.id}`);
		await shop.api('DELETE', `/v1/deals/${fixed.id}`);
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
});

describe('guest checkout and order keys (E21)', () => {
	it('lets a guest order with a phone, read the order with its key and claims it at sign-in', async () => {
		await shop.setting('checkout', 'guests', 'on');
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
		const byNumber = await visit('GET', `/v1/shop/orders/by-number/${order.number}`, { orderKey });
		expect(byNumber.json.id).toBe(order.id);
		const wrong = await visit('GET', `/v1/shop/orders/by-number/${order.number}`, { orderKey: 'x'.repeat(32) });
		expect(wrong.status).toBeGreaterThanOrEqual(400);

		const member = await newShopper({ phone: '+15550007777' });
		const mine = await visit('GET', '/v1/shop/orders', { signIn: member.token });
		expect(mine.json.items.map((/** @type {any} */ o) => o.id)).toContain(order.id);
		expect((await orderRecord(order.id)).customer.userId).toBe(member.id);
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
		await shop.setting('checkout', 'paymentOrder', ['bank_transfer', 'cod', 'online', 'pickup']);
		await shop.setting('checkout', 'noteCod', 'Pay the rider');
		await shop.setting('cod', 'feePercent', 5);
		await shop.setting('cod', 'startStatus', 'open');
		const item = await shop.seedProduct({ price: 10_000, stock: 10 });
		const shopper = await newShopper();
		const priced = await quote(
			{ lines: [{ productId: item.id }], delivery: { city: 'Springfield' }, payment: 'cod' },
			shopper.token,
		);
		expect(priced.json.paymentMethods.map((/** @type {any} */ m) => m.method).slice(0, 2)).toEqual(['bank_transfer', 'cod']);
		expect(priced.json.notes).toMatchObject({ cod: 'Pay the rider' });
		expect(priced.json.totals).toMatchObject({ fee: 515, total: 10_815 });
		const placed = await place({ lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS }, shopper.token);
		expect(placed.json.order).toMatchObject({ totals: { fee: 515 } });
		expect((await orderRecord(placed.json.order.id)).role).toBe('open');
		await shop.setting('cod', 'feePercent', 0);
		await shop.setting('cod', 'startStatus', 'awaiting_confirmation');
		await shop.setting('checkout', 'paymentOrder', ['cod', 'online', 'bank_transfer', 'pickup']);
		await shop.setting('checkout', 'noteCod', '');
	});

	it('limits lines and quantities and sends the shopper to the store’s own success page', async () => {
		await shop.setting('checkout', 'maxQuantity', 3);
		await shop.setting('checkout', 'successUrl', `${ORIGIN}/thanks/{number}`);
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const shopper = await newShopper();
		const tooMany = await place(
			{ lines: [{ productId: item.id, quantity: 4 }], payment: 'cod', address: ADDRESS },
			shopper.token,
		);
		expect(tooMany.status).toBe(422);
		const placed = await place(
			{ lines: [{ productId: item.id, quantity: 3 }], payment: 'cod', address: ADDRESS },
			shopper.token,
		);
		expect(placed.json.next).toEqual({ kind: 'done', url: `${ORIGIN}/thanks/${placed.json.order.number}` });
		await shop.setting('checkout', 'maxQuantity', 99);
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
});

describe('bank transfers recorded by staff (E24)', () => {
	it('waits for the payment without Payments and takes the shopper’s proof', async () => {
		await shop.setting('checkout', 'bankTransferVia', 'manual');
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
		const elsewhere = await visit('POST', `/v1/shop/orders/${id}/proof`, {
			signIn: shopper.token,
			body: { key: 'ecommerce/proofs/ord_other/x.png' },
		});
		expect(elsewhere.status).toBe(422);
		await shop.setting('checkout', 'bankTransferVia', 'payments');
	});
});

describe('loyalty options (E20)', () => {
	it('answers points to earn, pending points and the paged history', async () => {
		await shop.setting('loyalty', 'earnPercent', 10);
		await shop.setting('loyalty', 'pointValue', 100);
		await shop.setting('loyalty', 'earnAt', 'placement');
		const item = await shop.seedProduct({ price: 10_000, stock: 10 });
		const shopper = await newShopper();
		const priced = await quote({ lines: [{ productId: item.id }] }, shopper.token);
		expect(priced.json.pointsToEarn).toBe(10);
		await place({ lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS }, shopper.token);
		const account = await visit('GET', '/v1/shop/loyalty?limit=5', { signIn: shopper.token });
		expect(account.json).toMatchObject({ balance: 0, lifetimeEarned: 0, pending: 10, hasMore: false });
		await shop.setting('loyalty', 'earnAt', 'delivery');
	});
});

describe('whole-unit amounts (E25)', () => {
	it('rounds deal discounts down and fees half up to whole units', async () => {
		await shop.api('PUT', '/v1/format', { wholeUnits: true });
		await shop.setting('cod', 'feePercent', 3);
		const item = await shop.seedProduct({ price: 1999, stock: 10 });
		const deal = await newDeal({ scope: { productIds: [item.id], categoryIds: [], brandIds: [] }, value: 15 });
		const priced = await quote({ lines: [{ productId: item.id }], payment: 'cod', delivery: { city: 'Springfield' } });
		expect(priced.json.totals.discount % 100).toBe(0);
		expect(priced.json.totals.fee % 100).toBe(0);
		await shop.api('DELETE', `/v1/deals/${deal.id}`);
		await shop.setting('cod', 'feePercent', 0);
		await shop.api('PUT', '/v1/format', { wholeUnits: false });
	});

	it('rounds the deals once, half up, with rounding total_half_up: cart, order and product quote (D4)', async () => {
		await shop.api('PUT', '/v1/format', { wholeUnits: true });
		const item = await shop.seedProduct({ price: 499_900, stock: 10 });
		const deal = await newDeal({ scope: { productIds: [item.id], categoryIds: [], brandIds: [] }, value: 7 });
		// 7% off 4,999.00 is 349.93: per_unit_down gives 349, total_half_up 350
		expect((await quote({ lines: [{ productId: item.id }] })).json.totals.discount).toBe(34_900);
		expect((await visit('GET', `/v1/shop/products/${item.id}/quote`)).json.savings).toBe(34_900);
		await shop.setting('deals', 'rounding', 'total_half_up');
		expect((await quote({ lines: [{ productId: item.id, quantity: 3 }] })).json.totals.discount).toBe(105_000);
		expect((await visit('GET', `/v1/shop/products/${item.id}/quote`)).json).toMatchObject({
			savings: 35_000,
			priceAfterDeals: 464_900,
		});
		const shopper = await newShopper();
		const placed = await place({ lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS }, shopper.token);
		expect(placed.json.order.totals).toMatchObject({ discount: 35_000, delivery: 300, total: 465_200 });
		await shop.setting('deals', 'rounding', 'per_unit_down');
		await shop.api('DELETE', `/v1/deals/${deal.id}`);
		await shop.api('PUT', '/v1/format', { wholeUnits: false });
	});
});
