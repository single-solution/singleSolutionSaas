/**
 * Cancelling an order cancels its Payments payment (K-13, Payments P4): the shopper's, the staff's and the window's
 * cancel, an edit and a delete cancel the open payment first; money paid just before keeps the order paid; a Payments
 * that cannot be reached is asked again on use; money paid after the cancel is found on read and on use, shows as a
 * refund due and is refunded the normal way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ORIGIN, PAYMENTS, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let ip = 0;
let users = 0;

const ADDRESS = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' };

/** @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

/** @param {string} id */
const orderRecord = async (id) =>
	/** @type {any} */ (await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id }));

/**
 * A visitor request from a fresh address, signed in.
 * @param {string} method @param {string} path @param {string} token @param {unknown} [body]
 */
const visit = (method, path, token, body) => {
	ip += 1;
	return shop.call(method, path, {
		token: shop.browser,
		origin: ORIGIN,
		...(body === undefined ? {} : { body }),
		headers: { 'ss-sign-in': token, 'x-forwarded-for': `10.9.${(ip >> 8) & 255}.${ip & 255}`, 'idempotency-key': `k-${ip}` },
	});
};

/**
 * Place an order as a new shopper; it waits for its Payments payment.
 * @param {{ payment?: string }} [options]
 */
const placeOrder = async ({ payment = 'online' } = {}) => {
	const item = await shop.seedProduct({ price: 1000, stock: 5 });
	users += 1;
	const token = await shop.signIn({ id: `usr_cancelpay${String(users).padStart(5, '0')}` });
	const placed = await visit('POST', '/v1/shop/orders', token, { lines: [{ productId: item.id }], payment, address: ADDRESS });
	expect(placed.status).toBe(201);
	const record = await orderRecord(placed.json.order.id);
	return { order: placed.json.order, token, paymentId: /** @type {string} */ (record.payment.paymentId), item };
};

/** The cancels Ecommerce asked of Payments for a payment. @param {string} paymentId */
const cancelsOf = (paymentId) => shop.callsTo(`${PAYMENTS}/v1/payments/${paymentId}/cancel`);

/** @param {string} id @param {string} to @param {Record<string, unknown>} [extra] */
const moveTo = (id, to, extra = {}) => shop.api('POST', `/v1/orders/${id}/move`, { to, ...extra });

/** Let the work on use run on the next request. */
const nextUse = async () => {
	shop.advance(61_000);
	await shop.call('POST', '/v1/shop/cart/quote', {
		token: shop.browser,
		origin: ORIGIN,
		body: { lines: [{ productId: 'prd_none' }] },
		headers: { 'x-forwarded-for': `10.10.0.${(ip += 1) & 255}` },
	});
};

/** Answer Payments' cancel of every payment with this, until `restore`. @param {{ status: number, body?: unknown }} answer */
const cancelAnswers = (answer) => {
	const normal = /** @type {any} */ (shop.responders.get(PAYMENTS));
	shop.responders.set(PAYMENTS, (call) => (call.path.endsWith('/cancel') ? answer : normal(call)));
	return () => shop.responders.set(PAYMENTS, normal);
};

beforeAll(async () => {
	shop = await readyShop();
});
afterAll(async () => shop.product.close());

describe('a cancelled order cancels its Payments payment (K-13)', () => {
	it('when the shopper cancels it, and keeps it paid when the money came just before', async () => {
		const { order, token, paymentId } = await placeOrder();
		const cancelled = await visit('POST', `/v1/shop/orders/${order.id}/cancel`, token);
		expect(cancelled.json.order.status).toBe('cancelled');
		expect(cancelsOf(paymentId).map((call) => JSON.parse(call.body))).toEqual([{ reason: 'Cancelled by the shopper' }]);
		expect((await orderRecord(order.id)).payment.voidedAt).toBeInstanceOf(Date);

		// paid just after the shopper's page asked Payments (asked at most every 30 seconds)
		const paidFirst = await placeOrder();
		await visit('GET', `/v1/shop/orders/${paidFirst.order.id}`, paidFirst.token);
		shop.payPayment(paidFirst.paymentId);
		const refused = await visit('POST', `/v1/shop/orders/${paidFirst.order.id}/cancel`, paidFirst.token);
		expect(codeOf(refused)).toBe('move_not_allowed');
		expect(refused.json.detail).toContain('paid');
		const record = await orderRecord(paidFirst.order.id);
		expect(record).toMatchObject({ status: 'confirmed', payment: { state: 'paid', paid: record.totals.total } });
		expect(record.payments).toEqual([expect.objectContaining({ method: 'online', reference: paidFirst.paymentId })]);
	});

	it('when staff cancel it, refusing once when the shopper paid meanwhile', async () => {
		const { order, paymentId } = await placeOrder();
		expect((await moveTo(order.id, 'cancelled', { note: 'Out of stock' })).json.status).toBe('cancelled');
		expect(JSON.parse(String(cancelsOf(paymentId)[0]?.body))).toEqual({ reason: 'Out of stock' });

		const paid = await placeOrder();
		shop.payPayment(paid.paymentId);
		const refused = await moveTo(paid.order.id, 'cancelled');
		expect(codeOf(refused)).toBe('move_not_allowed');
		expect((await orderRecord(paid.order.id)).status).toBe('confirmed');
		// cancelling the paid order now refunds it through Payments
		const again = await moveTo(paid.order.id, 'cancelled');
		expect(again.json).toMatchObject({ status: 'cancelled', payment: { state: 'refunded', refundDue: 0 } });
		expect(shop.callsTo(`${PAYMENTS}/v1/payments/${paid.paymentId}/refunds`)).toHaveLength(1);
	});

	it('when its window ends', async () => {
		await shop.setting('checkout', 'paymentWindowMinutes', 60);
		const { order, paymentId } = await placeOrder();
		shop.advance(61 * 60_000);
		await nextUse();
		expect((await orderRecord(order.id)).status).toBe('cancelled');
		expect(JSON.parse(String(cancelsOf(paymentId)[0]?.body))).toEqual({ reason: 'Not paid in time' });
	});

	it('when an edit drops the payment of the old total, and a delete', async () => {
		const ticket = await shop.ticket();
		const { order, paymentId, item } = await placeOrder();
		const variantId = /** @type {any} */ (item.variants[0]).id;
		const edited = await shop.admin(ticket, 'PATCH', `/v1/admin/orders/${order.id}`, { lines: [{ variantId, quantity: 2 }] });
		expect(edited.status).toBe(200);
		expect(cancelsOf(paymentId)).toHaveLength(1);
		expect((await orderRecord(order.id)).payment.paymentId).toBeNull();

		const paid = await placeOrder();
		shop.payPayment(paid.paymentId);
		const refused = await shop.admin(ticket, 'PATCH', `/v1/admin/orders/${paid.order.id}`, {
			lines: [{ variantId: /** @type {any} */ (paid.item.variants[0]).id, quantity: 2 }],
		});
		expect(codeOf(refused)).toBe('conflict');
		expect((await orderRecord(paid.order.id)).payment.state).toBe('paid');

		const down = await placeOrder();
		const restore = cancelAnswers({ status: 503, body: {} });
		const unreachable = await shop.admin(ticket, 'PATCH', `/v1/admin/orders/${down.order.id}`, {
			lines: [{ variantId: /** @type {any} */ (down.item.variants[0]).id, quantity: 2 }],
		});
		restore();
		expect(codeOf(unreachable)).toBe('payments_unavailable');

		const gone = await placeOrder();
		expect((await shop.admin(ticket, 'DELETE', `/v1/admin/orders/${gone.order.id}`)).status).toBe(204);
		expect(cancelsOf(gone.paymentId)).toHaveLength(1);
		const kept = await placeOrder();
		shop.payPayment(kept.paymentId);
		expect(codeOf(await shop.admin(ticket, 'DELETE', `/v1/admin/orders/${kept.order.id}`))).toBe('conflict');
		expect(await orderRecord(kept.order.id)).toMatchObject({ status: 'confirmed' });
	});
});

describe('when Payments cannot be reached, and money paid after the cancel (K-13)', () => {
	it('cancels the order, keeps the step and cancels the payment on a later use', async () => {
		const { order, token, paymentId } = await placeOrder();
		const restore = cancelAnswers({ status: 503, body: {} });
		const cancelled = await visit('POST', `/v1/shop/orders/${order.id}/cancel`, token);
		restore();
		expect(cancelled.json.order.status).toBe('cancelled');
		const pending = (await orderRecord(order.id)).payment;
		expect(pending.voidPendingAt).toBeInstanceOf(Date);
		expect(pending.voidedAt).toBeUndefined();
		await nextUse();
		expect(cancelsOf(paymentId)).toHaveLength(2);
		expect((await orderRecord(order.id)).payment).toMatchObject({ voidPendingAt: null, voidedAt: expect.any(Date) });

		// a payment Payments no longer knows ends the step
		const unknown = await placeOrder();
		const off = cancelAnswers({ status: 503, body: {} });
		await visit('POST', `/v1/shop/orders/${unknown.order.id}/cancel`, unknown.token);
		off();
		const missing = cancelAnswers({ status: 404, body: { type: 'https://errors.example/not_found' } });
		await nextUse();
		missing();
		expect((await orderRecord(unknown.order.id)).payment).toMatchObject({ voidPendingAt: null });
		expect((await orderRecord(unknown.order.id)).payment.voidedAt).toBeUndefined();
	});

	it('records money paid before an unreachable cancel as a refund due, found on the later use', async () => {
		const { order, token, paymentId } = await placeOrder();
		const restore = cancelAnswers({ status: 503, body: {} });
		await visit('POST', `/v1/shop/orders/${order.id}/cancel`, token);
		restore();
		shop.payPayment(paymentId);
		await nextUse();
		const record = await orderRecord(order.id);
		expect(record).toMatchObject({ status: 'cancelled', payment: { paid: record.totals.total, voidPendingAt: null } });
		expect(record.history.at(-1).note).toContain('arrived after the order was cancelled');
		expect((await shop.api('GET', `/v1/orders/${order.id}`)).json.payment.refundDue).toBe(record.totals.total);
	});

	it('finds money paid after the cancel when staff read the order, and refunds it through Payments', async () => {
		const { order, token, paymentId } = await placeOrder();
		await visit('POST', `/v1/shop/orders/${order.id}/cancel`, token);
		shop.payPayment(paymentId);
		shop.advance(31_000);
		const read = await shop.api('GET', `/v1/orders/${order.id}`);
		const total = read.json.totals.total;
		expect(read.json).toMatchObject({ status: 'cancelled', payment: { paid: total, refundDue: total, refundable: total } });
		expect(read.json.payments).toEqual([
			expect.objectContaining({ method: 'online', reference: paymentId, note: 'Paid after the order was cancelled' }),
		]);
		const refunded = await shop.api('POST', `/v1/orders/${order.id}/refunds`, { amount: total, reason: 'Cancelled order' });
		expect(refunded.status).toBe(201);
		expect(refunded.json.refund).toMatchObject({ online: total, manual: 0 });
		expect(refunded.json.order.payment).toMatchObject({ refundDue: 0, state: 'refunded' });
		// money is never recorded twice
		shop.advance(31_000);
		expect((await shop.api('GET', `/v1/orders/${order.id}`)).json.payment.paid).toBe(total);
	});

	it('finds it on use too, for a while after the cancel', async () => {
		const { order, token, paymentId } = await placeOrder();
		await visit('POST', `/v1/shop/orders/${order.id}/cancel`, token);
		await nextUse();
		expect((await orderRecord(order.id)).payment.paid).toBe(0);
		shop.payPayment(paymentId);
		shop.advance(15 * 60_000);
		await nextUse();
		expect((await orderRecord(order.id)).payment.paid).toBeGreaterThan(0);
	});
});
