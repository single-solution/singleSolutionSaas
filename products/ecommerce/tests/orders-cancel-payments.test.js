/**
 * Canceling an order cancels its Payments payment (K-13, Payments P4): the shopper's, the staff's and the window's
 * cancel, an edit and a delete cancel the open payment first; money paid just before keeps the order paid; a Payments
 * that cannot be reached is asked again on use; money paid after the cancel is found on read and on use, shows as a
 * refund due and is refunded the normal way; money staff record by hand, "delete all" and two "pay" at once cancel the
 * open payment too (CK-21).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { createCheckout } from '../server/checkout.js';
import { createService } from '../server/service.js';
import { DOMAIN, ORIGIN, PAYMENTS, readyShop } from './helpers.js';

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

describe('a canceled order cancels its Payments payment (K-13)', () => {
	it('when the shopper cancels it, and keeps it paid when the money came just before', async () => {
		const { order, token, paymentId } = await placeOrder();
		const cancelled = await visit('POST', `/v1/shop/orders/${order.id}/cancel`, token);
		expect(cancelled.json.order.status).toBe('cancelled');
		expect(cancelsOf(paymentId).map((call) => JSON.parse(call.body))).toEqual([{ reason: 'Canceled by the shopper' }]);
		expect((await orderRecord(order.id)).payment.voidedAt).toBeInstanceOf(Date);
		expect((await orderRecord(order.id)).history.at(-1)).toMatchObject({ by: 'shopper', reason: 'shopper', code: 'shopper' });

		// paid just after the shopper's page asked Payments (asked at most every 30 seconds)
		const paidFirst = await placeOrder();
		await visit('GET', `/v1/shop/orders/${paidFirst.order.id}`, paidFirst.token);
		shop.payPayment(paidFirst.paymentId);
		const refused = await visit('POST', `/v1/shop/orders/${paidFirst.order.id}/cancel`, paidFirst.token);
		expect(codeOf(refused)).toBe('move_not_allowed');
		expect(refused.json.detail).toContain('paid');
		const record = await orderRecord(paidFirst.order.id);
		expect(record).toMatchObject({ status: 'confirmed', payment: { state: 'paid', paid: record.totals.total } });
		expect(record.payments).toEqual([expect.objectContaining({ method: 'payments', reference: paidFirst.paymentId })]);
		expect(record.history.at(-1)).toMatchObject({ by: 'system', code: 'payment_confirmed' });
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
		// canceling the paid order now refunds it through Payments, with the event other refunds raise
		const again = await moveTo(paid.order.id, 'cancelled');
		expect(again.json).toMatchObject({ status: 'cancelled', payment: { state: 'refunded', refundDue: 0 } });
		expect(shop.callsTo(`${PAYMENTS}/v1/payments/${paid.paymentId}/refunds`)).toHaveLength(1);
		const total = (await orderRecord(paid.order.id)).totals.total;
		/** @param {string} id */
		const refundEvents = async (id) =>
			(await shop.api('GET', '/v1/events?types=ecommerce.order.refunded')).json.items
				.filter((/** @type {any} */ event) => event.data.orderId === id)
				.map((/** @type {any} */ event) => event.data);
		expect(await refundEvents(paid.order.id)).toEqual([expect.objectContaining({ amount: total, claimId: null })]);
		// so does a move to a refunded status
		const refundedToo = await placeOrder();
		shop.payPayment(refundedToo.paymentId);
		await visit('GET', `/v1/shop/orders/${refundedToo.order.id}`, refundedToo.token);
		expect((await moveTo(refundedToo.order.id, 'delivered')).status).toBe(200);
		expect((await moveTo(refundedToo.order.id, 'refunded')).json).toMatchObject({ payment: { state: 'refunded' } });
		expect(await refundEvents(refundedToo.order.id)).toEqual([expect.objectContaining({ amount: total })]);
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
		expect(record.history.at(-1).note).toContain('arrived after the order was canceled');
		expect(record.history.at(-1)).toMatchObject({ code: 'paid_after_cancel', values: { amount: record.totals.total } });
		expect((await shop.api('GET', `/v1/orders/${order.id}`)).json.payment.refundDue).toBe(record.totals.total);
	});

	it('finds money paid after the cancel when staff read the order, and refunds it through Payments', async () => {
		await shop.setting('staff_alerts', 'recipients', ['ops@shop.example.com']);
		const { order, token, paymentId } = await placeOrder();
		await visit('POST', `/v1/shop/orders/${order.id}/cancel`, token);
		shop.payPayment(paymentId);
		shop.advance(31_000);
		const sent = shop.messages().length;
		const read = await shop.api('GET', `/v1/orders/${order.id}`);
		const total = read.json.totals.total;
		expect(read.json).toMatchObject({ status: 'cancelled', payment: { paid: total, refundDue: total, refundable: total } });
		expect(read.json.payments).toEqual([
			expect.objectContaining({ method: 'payments', reference: paymentId, note: 'Paid after the order was canceled' }),
		]);
		// staff are told (staff alert event refund_due, on by default), and the refunds to make are listed
		const alerts = shop
			.messages()
			.slice(sent)
			.filter((message) => message.template === 'ecommerce.staff_refund_due');
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.values).toMatchObject({ number: order.number, amount: expect.stringMatching(/^USD /) });
		const due = await shop.api('GET', '/v1/orders?refundDue=1');
		expect(due.json.items.map((/** @type {any} */ item) => item.id)).toContain(order.id);
		expect((await shop.api('GET', '/v1/orders/count?refundDue=1')).json.count).toBeGreaterThanOrEqual(1);
		const refunded = await shop.api('POST', `/v1/orders/${order.id}/refunds`, { amount: total, reason: 'Canceled order' });
		expect(refunded.status).toBe(201);
		expect(refunded.json.refund).toMatchObject({ online: total, manual: 0 });
		expect(refunded.json.order.payment).toMatchObject({ refundDue: 0, state: 'refunded' });
		const after = await shop.api('GET', '/v1/orders?refundDue=1');
		expect(after.json.items.map((/** @type {any} */ item) => item.id)).not.toContain(order.id);
		await shop.setting('staff_alerts', 'recipients', []);
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

describe('money staff take, deletes and two "pay" at once (CK-21)', () => {
	it('cancels the open payment before staff record money by hand, refusing when it was paid or cannot be canceled', async () => {
		const { order, paymentId } = await placeOrder({ payment: 'bank_transfer' });
		const recorded = await shop.api('POST', `/v1/orders/${order.id}/payments`, {
			method: 'bank_transfer',
			amount: 400,
			reference: 'TRX-1',
		});
		expect(recorded.status).toBe(201);
		expect(cancelsOf(paymentId).map((call) => JSON.parse(call.body))).toEqual([{ reason: 'Paid by hand' }]);
		expect((await orderRecord(order.id)).payment).toMatchObject({ paid: 400, state: 'unpaid', voidedAt: expect.any(Date) });
		// the rest is recorded without asking Payments again
		expect((await shop.api('POST', `/v1/orders/${order.id}/payments`, { method: 'cod', amount: 600 })).status).toBe(201);
		expect(cancelsOf(paymentId)).toHaveLength(1);

		const paid = await placeOrder();
		shop.payPayment(paid.paymentId);
		const refused = await shop.api('POST', `/v1/orders/${paid.order.id}/payments`, { method: 'cod', amount: 1000 });
		expect(codeOf(refused)).toBe('conflict');
		const record = await orderRecord(paid.order.id);
		expect(record.payment).toMatchObject({ state: 'paid', paid: 1000 });
		expect(record.payments.map((/** @type {any} */ entry) => entry.method)).toEqual(['payments']);

		const down = await placeOrder();
		const restore = cancelAnswers({ status: 503, body: {} });
		const unreachable = await shop.api('POST', `/v1/orders/${down.order.id}/payments`, { method: 'cod', amount: 500 });
		const notDeleted = await shop.api('DELETE', `/v1/orders/${down.order.id}`);
		restore();
		expect(codeOf(unreachable)).toBe('payments_unavailable');
		expect(codeOf(notDeleted)).toBe('payments_unavailable');
		expect((await orderRecord(down.order.id)).payment.paid).toBe(0);
	});

	it('keeps one payment when two "pay" start one at once, canceling the other at Payments', async () => {
		// a guest order whose payment could not be started waits for "pay"
		await shop.setting('checkout', 'guests', 'on');
		const normal = /** @type {any} */ (shop.responders.get(PAYMENTS));
		shop.responders.set(PAYMENTS, (call) =>
			call.method === 'POST' && call.path === '/v1/payments' ? { status: 503, body: {} } : normal(call),
		);
		const item = await shop.seedProduct({ price: 1000, stock: 5 });
		const placed = await shop.call('POST', '/v1/shop/orders', {
			token: shop.browser,
			origin: ORIGIN,
			body: {
				lines: [{ productId: item.id }],
				payment: 'online',
				address: ADDRESS,
				customer: { name: 'Gina Guest', phone: '+15550007777' },
			},
			headers: { 'x-forwarded-for': '10.11.0.1', 'idempotency-key': 'race-1' },
		});
		shop.responders.set(PAYMENTS, normal);
		expect(placed.json.next).toEqual({ kind: 'retry' });
		const id = placed.json.order.id;
		const winner = 'pay_other0000000001';
		// another "pay" takes the order's payment while this one is starting its own
		const service = createService(shop.product);
		const { ordering } = createCheckout(shop.product, {
			...service,
			payments: {
				...service.payments,
				create: async (s, input) => {
					const made = await service.payments.create(s, input);
					await (
						await shop.db()
					)
						.collection(COLLECTIONS.orders)
						.updateOne(
							{ websiteId: shop.websiteId, id },
							{ $set: { 'payment.paymentId': winner, 'payment.checkoutUrl': `${PAYMENTS}/pay/w/${winner}` } },
						);
					return made;
				},
			},
		});
		const since = shop.calls.length;
		const answer = await ordering.pay({
			websiteId: shop.websiteId,
			merchantId: null,
			status: { domain: DOMAIN },
			headers: new Headers({ 'ss-order-key': placed.json.orderKey }),
			params: { id },
			body: {},
		});
		expect(answer.next).toEqual({ kind: 'pay', url: `${PAYMENTS}/pay/w/${winner}` });
		expect((await orderRecord(id)).payment.paymentId).toBe(winner);
		const calls = shop.calls.slice(since).filter((call) => call.url.startsWith(PAYMENTS));
		const started = calls.find((call) => call.method === 'POST' && call.path === '/v1/payments');
		const cancelled = calls.filter((call) => call.path.endsWith('/cancel')).map((call) => call.path);
		expect(started).toBeDefined();
		expect(cancelled).toHaveLength(1);
		expect(cancelled[0]).not.toContain(winner);
		await shop.setting('checkout', 'guests', 'off');
	});

	it('cancels every open payment before all orders are deleted, deleting none while Payments cannot be reached', async () => {
		const first = await placeOrder();
		const second = await placeOrder({ payment: 'bank_transfer' });
		const restore = cancelAnswers({ status: 503, body: {} });
		const refused = await shop.api('POST', '/v1/data/delete-all', { scope: 'orders', confirm: DOMAIN });
		restore();
		expect(codeOf(refused)).toBe('payments_unavailable');
		expect(await orderRecord(first.order.id)).not.toBeNull();
		const done = await shop.api('POST', '/v1/data/delete-all', { scope: 'orders', confirm: DOMAIN });
		expect(done.status).toBe(200);
		for (const { paymentId } of [first, second])
			expect(cancelsOf(paymentId).map((call) => JSON.parse(call.body))).toContainEqual({ reason: 'Order deleted' });
		expect(await orderRecord(first.order.id)).toBeNull();
	});
});
