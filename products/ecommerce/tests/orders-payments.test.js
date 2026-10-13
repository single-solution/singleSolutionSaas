/**
 * The payments log and the extra moves through the API (PLAN 0.8.10 E26, E27): payments staff record (with the
 * confirm move), refunds with their method, reference and claim, the refunded status reached by refunds, cash paid on
 * delivery or recorded by staff, moving back to waiting or open, recalling a shipped parcel, refunding before delivery
 * only when something was paid, returns to origin with a reason and customer returns with points and restocking.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_FLOW } from '../core/flow.js';
import { COLLECTIONS } from '../core/model.js';
import { ORIGIN, PAYMENTS, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let ip = 0;
let users = 0;

const ADDRESS = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' };

/** The default flow with the E27 moves listed. */
const FLOW = {
	statuses: [...DEFAULT_FLOW.statuses, { key: 'customer-returned', label: 'Returned', role: 'returned' }],
	moves: [
		...DEFAULT_FLOW.moves,
		{ from: 'confirmed', to: 'pending_payment' },
		{ from: 'packed', to: 'confirmed' },
		{ from: 'dispatched', to: 'cancelled' },
		{ from: 'confirmed', to: 'refunded' },
		{ from: 'pending_payment', to: 'refunded' },
		{ from: 'delivered', to: 'customer-returned' },
		{ from: 'customer-returned', to: 'refunded' },
	],
};

/** @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

/** @param {string} id */
const orderRecord = async (id) =>
	/** @type {any} */ (await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id }));

/** @param {string} id */
const stockOf = async (id) =>
	/** @type {any} */ (await (await shop.db()).collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id }))
		.variants[0].stock;

/**
 * Place an order as a new shopper.
 * @param {{ payment?: string, price?: number, stock?: number }} [options]
 */
const placeOrder = async ({ payment = 'cod', price = 1000, stock = 10 } = {}) => {
	const item = await shop.seedProduct({ price, stock });
	users += 1;
	ip += 1;
	const token = await shop.signIn({ id: `usr_payments${String(users).padStart(6, '0')}` });
	const placed = await shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: { lines: [{ productId: item.id }], payment, address: ADDRESS },
		headers: { 'x-forwarded-for': `10.7.0.${ip}`, 'ss-sign-in': token, 'idempotency-key': `pay-${users}` },
	});
	expect(placed.status).toBe(201);
	return { item, order: placed.json.order, token };
};

/** @param {string} id @param {string} to @param {Record<string, unknown>} [extra] */
const moveTo = (id, to, extra = {}) => shop.api('POST', `/v1/orders/${id}/move`, { to, ...extra });

/** @param {string} id @param {Record<string, unknown>} body */
const pay = (id, body) =>
	shop.call('POST', `/v1/orders/${id}/payments`, {
		token: shop.server,
		body,
		headers: { 'idempotency-key': `rec-${Math.random()}` },
	});

/** @param {string} id @param {Record<string, unknown>} body */
const refund = (id, body) =>
	shop.call('POST', `/v1/orders/${id}/refunds`, {
		token: shop.server,
		body,
		headers: { 'idempotency-key': `rfd-${Math.random()}` },
	});

beforeAll(async () => {
	shop = await readyShop();
	const saved = await shop.list('order_flow', FLOW);
	expect(saved).toBeTruthy();
});
afterAll(async () => shop.product.close());

describe('the payments log (E26)', () => {
	it('records payments up to the balance, confirms a waiting order and shows the shopper the entries', async () => {
		const { order, token } = await placeOrder();
		const half = await pay(order.id, { method: 'bank_transfer', amount: 400, reference: 'TRX-1' });
		expect(half.status).toBe(201);
		expect(half.json.order.payment).toMatchObject({ paid: 400, state: 'unpaid' });
		expect(codeOf(await pay(order.id, { method: 'cash', amount: 700 }))).toBe('validation_failed');
		expect(codeOf(await pay(order.id, { method: 'online', amount: 100 }))).toBe('validation_failed');
		const rest = await pay(order.id, { method: 'cash', amount: 600, confirm: true });
		expect(rest.json.order).toMatchObject({ status: 'confirmed', payment: { paid: 1000, state: 'paid' } });
		const record = await orderRecord(order.id);
		expect(record.payments.map((/** @type {any} */ e) => [e.method, e.amount, e.reference])).toEqual([
			['bank_transfer', 400, 'TRX-1'],
			['cash', 600, ''],
		]);
		const mine = await shop.call('GET', `/v1/shop/orders/${order.id}`, {
			token: shop.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': token, 'x-forwarded-for': '10.7.1.1' },
		});
		expect(mine.json.payment).toMatchObject({ paid: 1000, balanceDue: 0 });
		expect(mine.json.payment.entries[0]).toEqual({
			method: 'bank_transfer',
			amount: 400,
			reference: 'TRX-1',
			at: expect.any(String),
		});
	});

	it('records refunds with their method, reference and claim, and moves to refunded when they cover the payments', async () => {
		await shop.setting('checkout', 'autoRefundedStatus', true);
		const { order } = await placeOrder();
		await pay(order.id, { method: 'cash', amount: 1000, confirm: true });
		const part = await refund(order.id, { amount: 300, reason: 'Late', method: 'cash', reference: 'R-1' });
		expect(part.status).toBe(201);
		expect(part.json.order.status).toBe('confirmed');
		const rest = await refund(order.id, { amount: 700, reason: 'Gone', method: 'bank_transfer', claimId: 'ret_abc' });
		expect(rest.json.order).toMatchObject({ status: 'refunded', payment: { state: 'refunded', refunded: 1000 } });
		const record = await orderRecord(order.id);
		expect(record.refunds.map((/** @type {any} */ e) => [e.method, e.amount, e.reference, e.claimId])).toEqual([
			['cash', 300, 'R-1', null],
			['bank_transfer', 700, '', 'ret_abc'],
		]);
		expect(codeOf(await refund(order.id, { amount: 1, reason: 'x', method: 'cheque' }))).toBe('validation_failed');
		await shop.setting('checkout', 'autoRefundedStatus', false);
	});

	it('never sends money staff recorded to Payments, even when the order has a Payments payment (PM-2)', async () => {
		const { order } = await placeOrder({ payment: 'online' });
		expect((await orderRecord(order.id)).payment.paymentId).toMatch(/^pay_/);
		await pay(order.id, { method: 'bank_transfer', amount: order.totals.total, reference: 'TRX-9', confirm: true });
		const calls = shop.callsTo(PAYMENTS).filter((call) => call.path.endsWith('/refunds')).length;
		expect(codeOf(await refund(order.id, { amount: 100, reason: 'x', method: 'online' }))).toBe('validation_failed');
		const refunded = await moveTo(order.id, 'refunded');
		expect(refunded.status).toBe(200);
		expect(refunded.json.payment).toMatchObject({ state: 'refunded', refunded: order.totals.total });
		expect(shop.callsTo(PAYMENTS).filter((call) => call.path.endsWith('/refunds'))).toHaveLength(calls);
		expect((await orderRecord(order.id)).refunds.map((/** @type {any} */ e) => e.method)).toEqual(['other']);
	});

	it('counts paid, refunded and due one way: a refund is never owed, a closed order owes and takes nothing (CK-5)', async () => {
		const { order, token } = await placeOrder();
		await moveTo(order.id, 'confirmed');
		await moveTo(order.id, 'delivered');
		await refund(order.id, { amount: 300, reason: 'Scratched', method: 'cash' });
		const mine = await shop.call('GET', `/v1/shop/orders/${order.id}`, {
			token: shop.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': token, 'x-forwarded-for': '10.7.1.9' },
		});
		expect(mine.json.payment).toMatchObject({ paid: 1000, refunded: 300, balanceDue: 0 });
		const staff = await shop.api('GET', `/v1/orders/${order.id}`);
		expect(staff.json.payment).toMatchObject({ balanceDue: 0, refundable: 700, refundDue: 0 });

		// a cancelled cash order: nothing due, no cash to collect on its invoice, and no payment recorded on it
		const cancelled = await placeOrder();
		await moveTo(cancelled.order.id, 'cancelled');
		expect((await shop.api('GET', `/v1/orders/${cancelled.order.id}`)).json.payment).toMatchObject({ balanceDue: 0 });
		const invoice = await shop.api('GET', `/v1/orders/${cancelled.order.id}/invoice`);
		expect(invoice.text).not.toContain('Cash due on delivery');
		const closed = await pay(cancelled.order.id, { method: 'cash', amount: 1000 });
		expect(closed.status).toBe(422);
		expect(closed.json.errors[0].message).toContain('closed');
	});

	it('shows a refund Payments only recorded as money to return by hand, with a warning (OR-8)', async () => {
		const { order, token } = await placeOrder({ payment: 'bank_transfer' });
		const { paymentId } = (await orderRecord(order.id)).payment;
		shop.payPayment(paymentId);
		const read = await shop.call('GET', `/v1/shop/orders/${order.id}`, {
			token: shop.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': token, 'x-forwarded-for': '10.7.1.10' },
		});
		expect(read.json.payment).toMatchObject({ state: 'paid', paid: order.totals.total });
		shop.responders.set(`${PAYMENTS}/v1/payments/${paymentId}/refunds`, (call) => ({
			status: 201,
			body: {
				id: paymentId,
				gateway: 'bank_transfer',
				status: 'refunded',
				refunds: [{ id: `rfd_${paymentId}_1`, amount: JSON.parse(call.body).amount, manual: true }],
			},
		}));
		const cancelled = await moveTo(order.id, 'cancelled');
		expect(cancelled.json.warnings).toEqual([
			`Return USD ${(order.totals.total / 100).toFixed(2)} to the shopper by hand: Payments only recorded the refund.`,
		]);
		const record = await orderRecord(order.id);
		expect(record.refunds).toEqual([
			expect.objectContaining({ method: 'bank_transfer', manual: true, refundId: `rfd_${paymentId}_1` }),
		]);
		expect(record.payment).toMatchObject({ refunded: order.totals.total, state: 'refunded' });
	});

	it('takes cash on delivery as paid unless staff record it', async () => {
		const first = await placeOrder();
		await moveTo(first.order.id, 'confirmed');
		const delivered = await moveTo(first.order.id, 'delivered');
		expect(delivered.json.payment).toMatchObject({ state: 'paid', paid: 1000 });
		expect((await orderRecord(first.order.id)).payments).toEqual([
			expect.objectContaining({ method: 'cash', amount: 1000, note: 'Paid on delivery' }),
		]);

		await shop.setting('cod', 'paidOnDelivery', false);
		const second = await placeOrder();
		await moveTo(second.order.id, 'confirmed');
		const waiting = await moveTo(second.order.id, 'delivered');
		expect(waiting.json.payment).toMatchObject({ paid: 0 });
		const recorded = await pay(second.order.id, { method: 'cash', amount: 1000 });
		expect(recorded.json.order.payment).toMatchObject({ state: 'paid', paid: 1000 });
		await shop.setting('cod', 'paidOnDelivery', true);
	});
});

describe('paid when staff confirm (OR-7)', () => {
	it('records nothing by default, and the balance of a listed method when staff move the order out of waiting', async () => {
		const plain = await placeOrder({ payment: 'bank_transfer' });
		expect((await moveTo(plain.order.id, 'confirmed')).json.payment).toMatchObject({ paid: 0 });

		await shop.setting('checkout', 'paidOnConfirm', ['bank_transfer']);
		await shop.setting('checkout', 'bankTransferVia', 'manual');
		const manual = await placeOrder({ payment: 'bank_transfer' });
		const confirmed = await moveTo(manual.order.id, 'confirmed');
		expect(confirmed.json).toMatchObject({ status: 'confirmed', payment: { state: 'paid', paid: manual.order.totals.total } });
		expect(confirmed.json.payments).toEqual([
			expect.objectContaining({ method: 'bank_transfer', amount: manual.order.totals.total, note: 'Paid on confirmation' }),
		]);
		// cash on delivery is not listed: confirming it records nothing
		expect((await moveTo((await placeOrder()).order.id, 'confirmed')).json.payment).toMatchObject({ paid: 0 });

		// through Payments: its payment there is cancelled first, so it can no longer be paid twice
		await shop.setting('checkout', 'bankTransferVia', 'payments');
		const viaPayments = await placeOrder({ payment: 'bank_transfer' });
		const { paymentId } = (await orderRecord(viaPayments.order.id)).payment;
		const moved = await moveTo(viaPayments.order.id, 'confirmed');
		expect(moved.json.payment).toMatchObject({ state: 'paid', voidedAt: expect.any(String) });
		expect(shop.callsTo(`${PAYMENTS}/v1/payments/${paymentId}/cancel`)).toHaveLength(1);
		// paid at Payments meanwhile: the move is refused and the order is confirmed by Payments' payment
		const paidThere = await placeOrder({ payment: 'bank_transfer' });
		shop.payPayment((await orderRecord(paidThere.order.id)).payment.paymentId);
		expect(codeOf(await moveTo(paidThere.order.id, 'confirmed'))).toBe('move_not_allowed');
		expect((await orderRecord(paidThere.order.id)).payments).toEqual([expect.objectContaining({ method: 'online' })]);
		await shop.setting('checkout', 'paidOnConfirm', []);
	});
});

describe('more moves (E27)', () => {
	it('sends an open order back to wait for payment, with a new window', async () => {
		await shop.setting('checkout', 'paymentWindowMinutes', 60);
		const { order } = await placeOrder();
		await moveTo(order.id, 'confirmed');
		const back = await moveTo(order.id, 'pending_payment');
		expect(back.status).toBe(200);
		const record = await orderRecord(order.id);
		expect(record.role).toBe('awaiting_payment');
		expect(new Date(record.holdUntil).getTime()).toBe(shop.now() + 60 * 60_000);

		// with rewaitWindow none it waits until staff move it again (OR-5)
		await shop.setting('checkout', 'rewaitWindow', 'none');
		const held = await placeOrder();
		await moveTo(held.order.id, 'confirmed');
		await moveTo(held.order.id, 'pending_payment');
		expect((await orderRecord(held.order.id)).holdUntil).toBeNull();
		await shop.setting('checkout', 'rewaitWindow', 'restart');
	});

	it('recalls a shipped parcel and gives everything back', async () => {
		await shop.list('couriers', [{ key: 'post', name: 'Post', trackingUrl: 'https://track.example/{tracking}' }]);
		const { item, order } = await placeOrder({ stock: 3 });
		await moveTo(order.id, 'confirmed');
		await moveTo(order.id, 'packed');
		await moveTo(order.id, 'dispatched', { shipment: { courier: 'post', trackingNumber: 'T1' } });
		expect(await stockOf(item.id)).toBe(2);
		const recalled = await moveTo(order.id, 'cancelled');
		expect(recalled.json.status).toBe('cancelled');
		expect(await stockOf(item.id)).toBe(3);
	});

	it('refunds before delivery only when something was paid, as a cancel', async () => {
		const unpaid = await placeOrder({ stock: 2 });
		await moveTo(unpaid.order.id, 'confirmed');
		expect(codeOf(await moveTo(unpaid.order.id, 'refunded'))).toBe('nothing_paid');

		const paid = await placeOrder({ stock: 2 });
		await pay(paid.order.id, { method: 'bank_transfer', amount: 1000, confirm: true });
		expect(await stockOf(paid.item.id)).toBe(1);
		const done = await moveTo(paid.order.id, 'refunded');
		expect(done.json).toMatchObject({ status: 'refunded', payment: { state: 'refunded', refunded: 1000 } });
		expect(await stockOf(paid.item.id)).toBe(2);
		expect((await orderRecord(paid.order.id)).refunds).toHaveLength(1);
	});

	it('takes a reason when a parcel comes back and counts only RTOs', async () => {
		await shop.list('couriers', [{ key: 'post', name: 'Post', trackingUrl: 'https://track.example/{tracking}' }]);
		const { order } = await placeOrder();
		await moveTo(order.id, 'confirmed');
		await moveTo(order.id, 'packed');
		await moveTo(order.id, 'dispatched', { shipment: { courier: 'post', trackingNumber: 'T2' } });
		expect((await moveTo(order.id, 'returned', { reason: 'later' })).status).toBe(422);
		const back = await moveTo(order.id, 'returned', { reason: 'customer_return' });
		expect(back.json.history.at(-1)).toMatchObject({ reason: 'customer_return' });
		const customer = /** @type {any} */ (
			await (
				await shop.db()
			)
				.collection(COLLECTIONS.customers)
				.findOne({ websiteId: shop.websiteId, id: (await orderRecord(order.id)).customer.customerId })
		);
		expect(customer?.rtoCount ?? 0).toBe(0);
	});

	it('takes a customer return after delivery, restocking as the setting says and taking back earned points', async () => {
		await shop.setting('loyalty', 'earnPercent', 10);
		await shop.setting('checkout', 'returnRestock', 'no');
		const { item, order, token } = await placeOrder({ price: 10_000, stock: 5 });
		await moveTo(order.id, 'confirmed');
		await moveTo(order.id, 'delivered');
		const before = await shop.call('GET', '/v1/shop/loyalty', {
			token: shop.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': token, 'x-forwarded-for': '10.7.2.1' },
		});
		expect(before.json.balance).toBeGreaterThan(0);
		const back = await moveTo(order.id, 'customer-returned');
		expect(back.json.status).toBe('customer-returned');
		expect(await stockOf(item.id)).toBe(4);
		const after = await shop.call('GET', '/v1/shop/loyalty', {
			token: shop.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': token, 'x-forwarded-for': '10.7.2.2' },
		});
		expect(after.json.balance).toBe(0);
		expect((await moveTo(order.id, 'refunded')).json.status).toBe('refunded');
		await shop.setting('checkout', 'returnRestock', 'yes');
	});

	it('needs the refund permission to move into refunded through a ticket', async () => {
		const { order } = await placeOrder();
		await pay(order.id, { method: 'cash', amount: 1000, confirm: true });
		const ticket = await shop.ticket(['orders.manage']);
		const refused = await shop.admin(ticket, 'POST', `/v1/admin/orders/${order.id}/move`, { to: 'refunded' });
		expect(refused.status).toBe(403);
	});
});
