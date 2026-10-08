/**
 * The cart and checkout through the API: quotes, placing COD, online, bank-transfer and advance orders, payment
 * confirmation through the fake Payments, the shopper's orders, cancelling, the end of waiting windows on use, pickup,
 * loyalty points and the widget settings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { givePoints } from '../adapters/ledger.js';
import { COLLECTIONS } from '../core/model.js';
import { ORIGIN, PAYMENTS, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let ip = 0;
let users = 0;

const ADDRESS = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' };

/**
 * A visitor request from a fresh address (the visitor rate limits count per address).
 * @param {string} method @param {string} path @param {{ body?: unknown, signIn?: string, key?: string }} [init]
 */
const visit = (method, path, { body, signIn, key } = {}) => {
	ip += 1;
	return shop.call(method, path, {
		token: shop.browser,
		origin: ORIGIN,
		body,
		headers: {
			'x-forwarded-for': `10.${(ip >> 16) & 255}.${(ip >> 8) & 255}.${ip & 255}`,
			...(signIn ? { 'ss-sign-in': signIn } : {}),
			...(key ? { 'idempotency-key': key } : {}),
		},
	});
};

/** A new shopper's sign-in. */
const newShopper = async () => {
	users += 1;
	const id = `usr_shopper${String(users).padStart(6, '0')}`;
	return { id, token: await shop.signIn({ id }) };
};

/** @param {string} token @param {Record<string, unknown>} body */
const place = (token, body) => visit('POST', '/v1/shop/orders', { body, signIn: token, key: `key-${ip}-${Math.random()}` });

/** @param {string} id */
const stockOf = async (id) =>
	/** @type {any} */ (await (await shop.db()).collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id }))
		.variants[0].stock;

/** @param {string} id */
const orderRecord = async (id) =>
	/** @type {any} */ (await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id }));

/** @param {string} paymentId */
const verifyCalls = (paymentId) => shop.callsTo(PAYMENTS).filter((call) => call.path === `/v1/payments/${paymentId}/verify`);

/** The problem code of an answer. @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

/** Let the work on use run on the next request. */
const nextUse = async () => {
	shop.advance(61_000);
	await visit('POST', '/v1/shop/cart/quote', { body: { lines: [{ productId: 'prd_none' }] } });
};

beforeAll(async () => {
	shop = await readyShop();
	await shop.list('delivery_zones', [
		{ key: 'city', name: 'Springfield', cities: ['Springfield'], fee: 300, freeOver: 50_000, minDays: 1, maxDays: 2 },
	]);
	await shop.setting('delivery_zones', 'defaultFee', 900);
});
afterAll(async () => shop.product.close());

describe('quote', () => {
	it('prices a guest cart with delivery, taxes and payment methods', async () => {
		const item = await shop.seedProduct({ price: 10_000, stock: 5 });
		await shop.list('tax_rules', [{ name: 'Sales tax', percent: 10, categoryIds: [], regions: [{ country: 'US', city: '' }] }]);
		await shop.setting('taxes', 'pricesIncludeTax', false);
		const response = await visit('POST', '/v1/shop/cart/quote', {
			body: { lines: [{ productId: item.id, quantity: 2 }], delivery: { city: 'Springfield', country: 'US' } },
		});
		await shop.setting('taxes', 'pricesIncludeTax', true);
		await shop.list('tax_rules', []);
		expect(response.status).toBe(200);
		expect(response.json).toMatchObject({
			currency: 'USD',
			lines: [{ productId: item.id, quantity: 2, unitPrice: 10_000, tax: 2000, total: 22_000, problems: [] }],
			delivery: { method: 'delivery', zone: 'city', fee: 300, minDays: 1, maxDays: 2 },
			totals: { subtotal: 20_000, tax: 2000, delivery: 300, total: 22_300, taxIncluded: false },
			points: null,
			ready: true,
		});
		expect(response.json.paymentMethods.map((/** @type {any} */ m) => m.method)).toEqual(['cod', 'online', 'bank_transfer']);
	});

	it('uses the default fee, reports shortfalls without stock counts and checks the body', async () => {
		const item = await shop.seedProduct({ price: 1000, stock: 1 });
		const response = await visit('POST', '/v1/shop/cart/quote', {
			body: { lines: [{ productId: item.id, quantity: 3 }, { productId: 'prd_missing' }], delivery: { city: 'Elsewhere' } },
		});
		expect(response.json.delivery).toMatchObject({ zone: '', fee: 900 });
		expect(response.json.lines.map((/** @type {any} */ l) => l.problems[0]?.code)).toEqual(['not_enough_stock', 'unavailable']);
		expect(JSON.stringify(response.json)).not.toContain('"stock"');
		expect(response.json.ready).toBe(false);
		expect((await visit('POST', '/v1/shop/cart/quote', { body: { lines: [] } })).status).toBe(422);
	});

	it('takes deals off and redeems points for a signed-in shopper', async () => {
		const item = await shop.seedProduct({ price: 100_000, stock: 5 });
		const shopper = await newShopper();
		const data = await shop.db();
		await data.collection(COLLECTIONS.deals).insertOne({
			id: 'deal_checkout1',
			name: 'Ten off',
			description: '',
			type: 'percent',
			value: 10,
			scope: { productIds: [item.id], categoryIds: [], brandIds: [] },
			startsAt: null,
			endsAt: null,
			limit: null,
			used: 0,
			priority: 0,
			active: true,
		});
		await givePoints(
			data,
			{ userId: shopper.id, points: 300, orderId: null, kind: 'adjust', expiresAt: null },
			{ now: shop.now() },
		);
		const body = {
			lines: [{ productId: item.id }],
			points: 150,
			delivery: { city: 'Springfield' },
			payment: 'cod',
			address: ADDRESS,
		};
		const quote = await visit('POST', '/v1/shop/cart/quote', { body, signIn: shopper.token });
		expect(quote.json.points).toEqual({ balance: 300, max: 180, used: 150, value: 15_000 });
		expect(quote.json.lines[0]).toMatchObject({ discount: 25_000, total: 75_000 });
		expect(quote.json.totals).toMatchObject({ discount: 25_000, delivery: 0, total: 75_000 });
		const few = await visit('POST', '/v1/shop/cart/quote', { body: { ...body, points: 50 }, signIn: shopper.token });
		expect(few.json.points.used).toBe(0);

		const placed = await place(shopper.token, body);
		expect(placed.status).toBe(201);
		const order = await orderRecord(placed.json.order.id);
		expect(order.promotions).toMatchObject({ dealIds: ['deal_checkout1'], pointsRedeemed: 150, pointsValue: 15_000 });
		expect(order.promotions.pointsEarned).toBeGreaterThan(0);
		const cancelled = await visit('POST', `/v1/shop/orders/${order.id}/cancel`, { signIn: shopper.token });
		expect(cancelled.json.order.statusLabel).toBe('Cancelled');
		const again = await visit('POST', '/v1/shop/cart/quote', { body, signIn: shopper.token });
		expect(again.json.points.balance).toBe(300);
		await data
			.collection(COLLECTIONS.deals)
			.updateOne({ websiteId: shop.websiteId, id: 'deal_checkout1' }, { $set: { active: false } });
	});
});

describe('placing with cash on delivery', () => {
	it('needs a sign-in, an Idempotency-Key and an address', async () => {
		const item = await shop.seedProduct();
		const body = { lines: [{ productId: item.id }], payment: 'cod' };
		expect(codeOf(await visit('POST', '/v1/shop/orders', { body, key: 'k-guest' }))).toBe('sign_in_required');
		expect((await visit('POST', '/v1/shop/orders', { body, key: 'k-guest2' })).status).toBe(403);
		const shopper = await newShopper();
		expect((await visit('POST', '/v1/shop/orders', { body, signIn: shopper.token })).status).toBe(428);
		const missing = await place(shopper.token, body);
		expect(missing.status).toBe(422);
		expect(missing.json.errors[0].path).toBe('/address');
		const bad = await place(shopper.token, { ...body, address: { ...ADDRESS, city: '' } });
		expect(bad.json.errors[0].path).toBe('/address/city');
		expect((await place(shopper.token, { ...body, address: ADDRESS, returnUrl: 'https://evil.example/x' })).status).toBe(422);
		expect((await place(shopper.token, { ...body, payment: 'cheque' })).status).toBe(422);
		const long = await place(shopper.token, { ...body, address: ADDRESS, note: 'x'.repeat(1001) });
		expect(long.json.errors[0].path).toBe('/note');
		const odd = await place(shopper.token, { ...body, address: ADDRESS, returnUrl: 'not an address' });
		expect(odd.json.errors[0].path).toBe('/returnUrl');
		const pickup = await place(shopper.token, { ...body, address: ADDRESS, payment: 'pickup' });
		expect(pickup.json.errors[0].path).toBe('/payment');
	});

	it('places a COD order that waits for confirmation, once per key', async () => {
		const item = await shop.seedProduct({ price: 2500, stock: 4 });
		const shopper = await newShopper();
		const sent = shop.messages().length;
		const body = { lines: [{ productId: item.id, quantity: 2 }], payment: 'cod', address: ADDRESS, note: 'Leave at door' };
		const key = 'cod-order-1';
		const response = await visit('POST', '/v1/shop/orders', { body, signIn: shopper.token, key });
		expect(response.status).toBe(201);
		expect(response.json.next).toEqual({ kind: 'done' });
		expect(response.json.order).toMatchObject({
			status: 'awaiting_confirmation',
			statusLabel: 'Awaiting confirmation',
			payment: { method: 'cod', state: 'unpaid', payUrl: null },
			totals: { subtotal: 5000, delivery: 300, total: 5300 },
			address: { city: 'Springfield' },
			canCancel: true,
			note: 'Leave at door',
		});
		expect(response.json.order.number).toMatch(/^2026-\d{6}$/);
		expect(response.json.order).not.toHaveProperty('staffNote');
		expect(await stockOf(item.id)).toBe(2);
		const record = await orderRecord(response.json.order.id);
		expect(record).toMatchObject({ role: 'awaiting_confirmation', stockHeld: true, staffNote: '' });
		expect(new Date(record.holdUntil).getTime() - shop.now()).toBe(24 * 3_600_000);
		const customer = await (
			await shop.db()
		)
			.collection(COLLECTIONS.customers)
			.findOne({ websiteId: shop.websiteId, userId: shopper.id });
		expect(customer).toMatchObject({ orderCount: 1, blocked: false, rtoCount: 0, email: 'sara@example.com' });
		expect(
			shop
				.messages()
				.slice(sent)
				.map((m) => m.template),
		).toContain('ecommerce.order_placed');

		const repeat = await visit('POST', '/v1/shop/orders', { body, signIn: shopper.token, key });
		expect(repeat.status).toBe(409);
		expect(await stockOf(item.id)).toBe(2);
	});

	it('refuses blocked customers, too many waiting orders, large COD orders and out-of-stock carts', async () => {
		const item = await shop.seedProduct({ price: 1000, stock: 50 });
		const body = { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS };
		const blocked = await newShopper();
		await (await shop.db()).collection(COLLECTIONS.customers).insertOne({
			userId: blocked.id,
			name: '',
			email: '',
			phone: '',
			blocked: true,
			blockedReason: 'x',
			rtoCount: 0,
			orderCount: 0,
			note: '',
		});
		expect(codeOf(await place(blocked.token, body))).toBe('customer_blocked');

		const busy = await newShopper();
		for (let n = 0; n < 3; n += 1) expect((await place(busy.token, body)).status).toBe(201);
		const fourth = await place(busy.token, body);
		expect(fourth.status).toBe(409);
		expect(codeOf(fourth)).toBe('too_many_open_orders');

		await shop.setting('cod', 'maxOrderValue', 1500);
		const large = await place((await newShopper()).token, { ...body, lines: [{ productId: item.id, quantity: 2 }] });
		await shop.setting('cod', 'maxOrderValue', 0);
		expect(large.status).toBe(422);
		expect([codeOf(large), large.json.codReason]).toEqual(['cod_not_allowed', 'over_max']);

		const rare = await shop.seedProduct({ stock: 1 });
		const short = await place((await newShopper()).token, { ...body, lines: [{ productId: rare.id, quantity: 2 }] });
		expect(short.status).toBe(409);
		expect(codeOf(short)).toBe('out_of_stock');
		const gone = await place((await newShopper()).token, { ...body, lines: [{ productId: 'prd_unknown' }] });
		expect(gone.status).toBe(422);
		expect(gone.json.errors[0]).toMatchObject({ path: '/lines/0', code: 'unavailable' });
	});

	it('asks flagged customers for an advance through Payments', async () => {
		const item = await shop.seedProduct({ price: 10_000 });
		const flagged = await newShopper();
		await (await shop.db()).collection(COLLECTIONS.customers).insertOne({
			userId: flagged.id,
			name: '',
			email: '',
			phone: '',
			blocked: false,
			blockedReason: '',
			rtoCount: 2,
			orderCount: 3,
			note: '',
		});
		const body = { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS };
		const refused = await place(flagged.token, body);
		expect([codeOf(refused), refused.json.codReason]).toEqual(['cod_not_allowed', 'advance_unavailable']);

		await shop.setting('cod', 'advancePercent', 20);
		const placed = await place(flagged.token, { ...body, returnUrl: `${ORIGIN}/thanks` });
		await shop.setting('cod', 'advancePercent', 0);
		expect(placed.status).toBe(201);
		expect(placed.json.order).toMatchObject({
			status: 'pending_payment',
			payment: { method: 'cod', advance: 2060, state: 'pending' },
		});
		expect(placed.json.next.kind).toBe('pay');
		const create = shop
			.callsTo(PAYMENTS)
			.filter((call) => call.path === '/v1/payments')
			.at(-1);
		expect(JSON.parse(String(create?.body))).toMatchObject({ amount: 2060, currency: 'USD', gateway: null });

		const record = await orderRecord(placed.json.order.id);
		shop.payPayment(record.payment.paymentId);
		const read = await visit('GET', `/v1/shop/orders/${record.id}`, { signIn: flagged.token });
		expect(read.json).toMatchObject({ status: 'confirmed', payment: { state: 'unpaid', paid: 2060, advance: 2060 } });
	});
});

describe('paying online and by bank transfer', () => {
	it('confirms an order only after Payments verifies it, rechecking at most every 30 seconds', async () => {
		const item = await shop.seedProduct({ price: 4000 });
		const shopper = await newShopper();
		const placed = await place(shopper.token, {
			lines: [{ productId: item.id }],
			payment: 'online',
			address: ADDRESS,
			returnUrl: `${ORIGIN}/checkout/done?step=3`,
		});
		expect(placed.status).toBe(201);
		const id = placed.json.order.id;
		expect(placed.json.order).toMatchObject({ status: 'pending_payment', payment: { state: 'pending' } });
		expect(placed.json.next).toMatchObject({ kind: 'pay' });
		expect(placed.json.order.payment.payUrl).toBe(placed.json.next.url);
		const create = JSON.parse(
			String(
				shop
					.callsTo(PAYMENTS)
					.filter((c) => c.path === '/v1/payments')
					.at(-1)?.body,
			),
		);
		expect(create).toMatchObject({
			amount: 4300,
			currency: 'USD',
			reference: placed.json.order.number,
			metadata: { orderId: id },
		});
		expect(create.returnUrl).toBe(`${ORIGIN}/checkout/done?step=3&ss_order=${id}`);

		const paymentId = (await orderRecord(id)).payment.paymentId;
		const first = await visit('GET', `/v1/shop/orders/${id}`, { signIn: shopper.token });
		expect(first.json.status).toBe('pending_payment');
		await visit('GET', `/v1/shop/orders/${id}`, { signIn: shopper.token });
		expect(verifyCalls(paymentId)).toHaveLength(1);
		expect(JSON.parse(String(verifyCalls(paymentId)[0]?.body))).toEqual({ amount: 4300, currency: 'USD' });

		shop.payPayment(paymentId);
		shop.advance(31_000);
		const sent = shop.messages().length;
		const paid = await visit('GET', `/v1/shop/orders/${id}`, { signIn: shopper.token });
		expect(paid.json).toMatchObject({
			status: 'confirmed',
			statusLabel: 'Confirmed',
			canCancel: false,
			payment: { state: 'paid', paid: 4300, payUrl: null },
		});
		expect(paid.json.history.map((/** @type {any} */ h) => h.status)).toEqual(['pending_payment', 'confirmed']);
		expect(paid.json.history[0]).not.toHaveProperty('by');
		expect(
			shop
				.messages()
				.slice(sent)
				.map((m) => m.template),
		).toContain('ecommerce.order_status');
		expect(codeOf(await visit('POST', `/v1/shop/orders/${id}/pay`, { signIn: shopper.token }))).toBe('nothing_to_pay');
	});

	it('sends bank transfers to the bank_transfer gateway and lets the shopper retry when Payments is down', async () => {
		const item = await shop.seedProduct({ price: 1000 });
		const shopper = await newShopper();
		const normal = /** @type {any} */ (shop.responders.get(PAYMENTS));
		shop.responders.set(PAYMENTS, () => ({ status: 503, body: { code: 'unavailable' } }));
		const placed = await place(shopper.token, { lines: [{ productId: item.id }], payment: 'bank_transfer', address: ADDRESS });
		expect(placed.status).toBe(201);
		expect(placed.json.next).toEqual({ kind: 'retry' });
		expect(placed.json.order.payment.payUrl).toBeNull();
		const id = placed.json.order.id;
		const failed = await visit('POST', `/v1/shop/orders/${id}/pay`, { signIn: shopper.token, body: {} });
		expect(codeOf(failed)).toBe('payments_unavailable');
		shop.responders.set(PAYMENTS, normal);
		expect(
			(
				await visit('POST', `/v1/shop/orders/${id}/pay`, {
					signIn: shopper.token,
					body: { returnUrl: 'https://evil.example' },
				})
			).status,
		).toBe(422);
		const retried = await visit('POST', `/v1/shop/orders/${id}/pay`, {
			signIn: shopper.token,
			body: { returnUrl: 'http://localhost:3000/done' },
		});
		expect(retried.json.next.kind).toBe('pay');
		const create = JSON.parse(
			String(
				shop
					.callsTo(PAYMENTS)
					.filter((c) => c.path === '/v1/payments')
					.at(-1)?.body,
			),
		);
		expect(create).toMatchObject({
			gateway: 'bank_transfer',
			amount: 1300,
			returnUrl: `http://localhost:3000/done?ss_order=${id}`,
		});
		const again = await visit('POST', `/v1/shop/orders/${id}/pay`, { signIn: shopper.token });
		expect(again.json.next.url).toBe(retried.json.next.url);
	});
});

describe("the shopper's orders", () => {
	it('lists only their own orders, newest first, with pages', async () => {
		const item = await shop.seedProduct({
			price: 700,
			media: [{ key: 'ecommerce/products/x/a.jpg', type: 'image/jpeg', size: 1, alt: '' }],
		});
		const shopper = await newShopper();
		const ids = [];
		for (let n = 0; n < 3; n += 1) {
			shop.advance(1000);
			ids.push(
				(await place(shopper.token, { lines: [{ productId: item.id }], payment: 'online', address: ADDRESS })).json.order.id,
			);
		}
		const first = await visit('GET', '/v1/shop/orders?limit=2', { signIn: shopper.token });
		expect(first.json.items.map((/** @type {any} */ o) => o.id)).toEqual([ids[2], ids[1]]);
		expect(first.json.items[0]).toMatchObject({ itemCount: 1, total: 1000, currency: 'USD', statusLabel: 'Awaiting payment' });
		expect(first.json.items[0].image).toMatch(/^https:\/\/bucket\.example\.org\//);
		const second = await visit('GET', `/v1/shop/orders?limit=2&cursor=${first.json.nextCursor}`, { signIn: shopper.token });
		expect(second.json.items.map((/** @type {any} */ o) => o.id)).toEqual([ids[0]]);
		const other = await newShopper();
		expect((await visit('GET', `/v1/shop/orders/${ids[0]}`, { signIn: other.token })).status).toBe(404);
		expect((await visit('GET', '/v1/shop/orders', { signIn: other.token })).json.items).toEqual([]);
		await (await shop.db()).collection(COLLECTIONS.orders).updateOne(
			{ websiteId: shop.websiteId, id: ids[0] },
			{
				$set: {
					shipment: {
						courier: 'Courier',
						trackingNumber: 'TN1',
						trackingUrl: 'https://track.example/TN1',
						booked: false,
						status: '',
						checkedAt: null,
					},
				},
			},
		);
		const shipped = await visit('GET', `/v1/shop/orders/${ids[0]}`, { signIn: shopper.token });
		expect(shipped.json.shipment).toEqual({
			courier: 'Courier',
			trackingNumber: 'TN1',
			trackingUrl: 'https://track.example/TN1',
		});
	});

	it('cancels a waiting order and gives its stock back once', async () => {
		const item = await shop.seedProduct({ stock: 3 });
		const shopper = await newShopper();
		const placed = await place(shopper.token, { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS });
		expect(await stockOf(item.id)).toBe(2);
		const cancelled = await visit('POST', `/v1/shop/orders/${placed.json.order.id}/cancel`, { signIn: shopper.token });
		expect(cancelled.json.order).toMatchObject({ status: 'cancelled', canCancel: false });
		expect(await stockOf(item.id)).toBe(3);
		const again = await visit('POST', `/v1/shop/orders/${placed.json.order.id}/cancel`, { signIn: shopper.token });
		expect(codeOf(again)).toBe('move_not_allowed');
		expect(await stockOf(item.id)).toBe(3);
	});
});

describe('waiting orders that end (on use)', () => {
	it('cancels unpaid and unconfirmed orders after their window, and confirms one paid at the last moment', async () => {
		const item = await shop.seedProduct({ stock: 10 });
		const a = await newShopper();
		const b = await newShopper();
		const c = await newShopper();
		const online = (await place(a.token, { lines: [{ productId: item.id }], payment: 'online', address: ADDRESS })).json.order;
		const late = (await place(b.token, { lines: [{ productId: item.id }], payment: 'online', address: ADDRESS })).json.order;
		const codBody = { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS };
		const cod = (await visit('POST', '/v1/shop/orders', { body: codBody, signIn: c.token, key: 'sweep-cod' })).json.order;
		expect(await stockOf(item.id)).toBe(7);
		shop.payPayment((await orderRecord(late.id)).payment.paymentId);
		const sent = shop.messages().length;

		shop.advance(61 * 60_000);
		await nextUse();
		expect((await orderRecord(online.id)).status).toBe('cancelled');
		expect((await orderRecord(online.id)).history.at(-1)).toMatchObject({ by: 'system', note: 'Not paid in time' });
		expect((await orderRecord(late.id)).status).toBe('confirmed');
		expect((await orderRecord(cod.id)).status).toBe('awaiting_confirmation');
		expect(await stockOf(item.id)).toBe(8);
		expect(
			shop
				.messages()
				.slice(sent)
				.map((m) => m.template),
		).toContain('ecommerce.order_status');

		shop.advance(24 * 3_600_000);
		await nextUse();
		expect((await orderRecord(cod.id)).status).toBe('cancelled');
		// a day later the kit forgets the key; the ledger still answers with the order placed with it
		const again = await visit('POST', '/v1/shop/orders', {
			body: codBody,
			signIn: await shop.signIn({ id: c.id }),
			key: 'sweep-cod',
		});
		expect(again.status).toBe(200);
		expect(again.json.order).toMatchObject({ id: cod.id, status: 'cancelled' });
		expect(again.json.next).toEqual({ kind: 'done' });
		expect(await stockOf(item.id)).toBe(9);
	});

	it('keeps an order whose payment cannot be checked for the next use', async () => {
		const item = await shop.seedProduct({ stock: 2 });
		const shopper = await newShopper();
		const placed = (await place(shopper.token, { lines: [{ productId: item.id }], payment: 'online', address: ADDRESS })).json
			.order;
		const normal = /** @type {any} */ (shop.responders.get(PAYMENTS));
		shop.responders.set(PAYMENTS, () => ({ status: 503, body: {} }));
		shop.advance(61 * 60_000);
		await nextUse();
		expect((await orderRecord(placed.id)).status).toBe('pending_payment');
		shop.responders.set(PAYMENTS, normal);
		await nextUse();
		expect((await orderRecord(placed.id)).status).toBe('cancelled');
	});
});

describe('store pickup and the widget settings', () => {
	it('offers pickup locations and pay at pickup', async () => {
		await (await shop.db()).collection(COLLECTIONS.locations).insertMany([
			{ id: 'loc_shop', name: 'Main shop', pickup: true, sort: 1 },
			{ id: 'loc_store', name: 'Warehouse', pickup: false, sort: 2 },
		]);
		// with stock locations every variant keeps its stock per location (multi_location)
		const item = await shop.seedProduct({
			variants: [
				{
					id: 'var_located',
					sku: '',
					options: {},
					price: 1200,
					compareAtPrice: null,
					cost: null,
					stock: 5,
					locations: { loc_shop: 3, loc_store: 2 },
					grade: null,
					active: true,
				},
			],
		});
		const quote = await visit('POST', '/v1/shop/cart/quote', {
			body: { lines: [{ productId: item.id }], delivery: { method: 'pickup' } },
		});
		expect(quote.json.delivery).toMatchObject({ method: 'pickup', locationId: 'loc_shop', name: 'Main shop', fee: 0 });
		expect(quote.json.paymentMethods.find((/** @type {any} */ m) => m.method === 'pickup')).toMatchObject({ available: true });
		const shopper = await newShopper();
		const placed = await place(shopper.token, {
			lines: [{ productId: item.id }],
			delivery: { method: 'pickup', locationId: 'loc_shop' },
			payment: 'pickup',
		});
		expect(placed.status).toBe(201);
		expect(placed.json.order).toMatchObject({
			status: 'awaiting_confirmation',
			address: null,
			delivery: { method: 'pickup', locationName: 'Main shop' },
			totals: { total: 1200 },
		});
		expect((await orderRecord(placed.json.order.id)).lines[0].locationId).toBe('loc_shop');
		const wrong = await place(shopper.token, {
			lines: [{ productId: item.id }],
			delivery: { method: 'pickup', locationId: 'loc_store' },
			payment: 'pickup',
		});
		expect(wrong.json.errors[0].path).toBe('/delivery/locationId');
		const notHere = await place(shopper.token, { lines: [{ productId: item.id }], payment: 'pickup', address: ADDRESS });
		expect(notHere.json.errors[0].path).toBe('/payment');

		const config = await visit('GET', '/v1/widget/config');
		expect(config.json.settings.checkout).toMatchObject({
			paymentMethods: ['cod', 'online', 'bank_transfer', 'pickup'],
			cod: { maxOrderValue: 0 },
			pickupLocations: [{ id: 'loc_shop', name: 'Main shop' }],
			delivery: { zones: true, cities: ['Springfield'] },
			pricesIncludeTax: true,
			policies: { shipping: '', returns: '', privacy: '', terms: '' },
			bookings: true,
			digital: true,
			address: { required: ['name', 'phone', 'line1', 'city'] },
			paymentWindowMinutes: 60,
		});
	});
});
