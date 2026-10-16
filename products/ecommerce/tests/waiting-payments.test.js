/**
 * A waiting order's open Payments payment when staff act on the order (the Ecommerce review of 2026-10-15, H3 and L1,
 * `audit/review-ecommerce-2026-10-15.md`): staff moving it on cancel that payment at Payments first (money paid just
 * before keeps the order, paid), so a later payment is never lost; a delete, a recorded payment or an edit that loses
 * its race to another change leaves the order payable (the payment it canceled is dropped) and never drops a newer one;
 * a delete gives back what the order holds and deletes it in one transaction, and cancels an open payment even when the
 * order holds nothing any more.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ORIGIN, PAYMENTS, readyShop } from './helpers.js';
import { orderRecords } from './order-records.js';

/** Work a test runs once, while Ecommerce asks Payments to cancel a payment (another change meanwhile). */
const meanwhile = vi.hoisted(() => ({ cancel: /** @type {null | (() => Promise<void>)} */ (null) }));
vi.mock('../server/service.js', async (original) => {
	const real = /** @type {typeof import('../server/service.js')} */ (await original());
	return {
		...real,
		createService: (/** @type {any} */ product) => {
			const service = real.createService(product);
			return {
				...service,
				payments: {
					...service.payments,
					/** @type {typeof service.payments.cancel} */
					cancel: async (s, paymentId, reason) => {
						const run = meanwhile.cancel;
						meanwhile.cancel = null;
						if (run) await run();
						return service.payments.cancel(s, paymentId, reason);
					},
				},
			};
		},
	};
});

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {ReturnType<typeof orderRecords>} */
let records;

beforeAll(async () => {
	shop = await readyShop();
	records = orderRecords(shop);
});
afterAll(async () => shop.product.close());

/** @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

/** Change the saved flow for one test, then put it back. @param {(flow: any) => any} change @param {() => Promise<void>} run */
const withFlow = async (change, run) => {
	const before = await shop.flow((flow) => flow);
	await shop.flow(change);
	try {
		await run();
	} finally {
		await shop.flow(() => before);
	}
};

const ADDRESS = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' };
let ip = 0;
let users = 0;

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
		headers: { 'ss-sign-in': token, 'x-forwarded-for': `10.12.${(ip >> 8) & 255}.${ip & 255}`, 'idempotency-key': `w-${ip}` },
	});
};

/** An order a new shopper places at checkout, waiting for its online payment at Payments. */
const placeOnline = async () => {
	const item = await shop.seedProduct({ price: 1000, stock: 5 });
	users += 1;
	const token = await shop.signIn({ id: `usr_waitpay${String(users).padStart(6, '0')}` });
	const placed = await visit('POST', '/v1/shop/orders', token, {
		lines: [{ productId: item.id }],
		payment: 'online',
		address: ADDRESS,
	});
	expect(placed.status).toBe(201);
	const order = await records.recordOf(placed.json.order.id);
	expect(order).toMatchObject({ status: 'pending_payment', payment: { state: 'pending', paymentId: expect.any(String) } });
	return { order, token, paymentId: /** @type {string} */ (order.payment.paymentId), item };
};

/** A payment as Payments has it. @param {string} id */
const atPayments = (id) =>
	/** @type {any} */ (shop.responders.get(PAYMENTS))({
		method: 'GET',
		url: '',
		path: `/v1/payments/${id}`,
		headers: {},
		body: '',
	}).body;

/** The cancels Ecommerce asked of Payments for a payment. @param {string} paymentId */
const cancelsOf = (paymentId) => shop.callsTo(`${PAYMENTS}/v1/payments/${paymentId}/cancel`);

describe('a waiting online order staff move on (H3)', () => {
	it('cancels its open Payments payment first, so it can no longer be paid there', async () => {
		const { order, paymentId } = await placeOnline();
		const moved = await records.moveTo(order.id, 'confirmed');
		expect(moved.status).toBe(200);
		expect(cancelsOf(paymentId)).toHaveLength(1);
		expect(await records.recordOf(order.id)).toMatchObject({
			status: 'confirmed',
			payment: { state: 'pending', paid: 0, paymentId: null, checkoutUrl: '' },
		});
		// the shopper pays on the page still open: Payments has the payment canceled, the money flagged to go back
		shop.payPayment(paymentId);
		expect(atPayments(paymentId)).toMatchObject({ status: 'paid', refundDue: true });
	});

	it('is refused when the shopper paid just before, and the order keeps the money', async () => {
		const { order, paymentId } = await placeOnline();
		shop.payPayment(paymentId);
		const refused = await records.moveTo(order.id, 'confirmed');
		expect(codeOf(refused)).toBe('move_not_allowed');
		expect(await records.recordOf(order.id)).toMatchObject({
			status: 'confirmed',
			payment: { state: 'paid', paid: order.totals.total, paymentId },
		});
		// staff go on with it: the money stays recorded
		expect((await records.moveTo(order.id, 'packed')).status).toBe(200);
		const delivered = await records.moveTo(order.id, 'delivered');
		expect(delivered.json.payment).toMatchObject({ state: 'paid', paid: order.totals.total });
	});

	it('lets the shopper pay with a new payment when the order waits for its payment again', async () => {
		await withFlow(
			(flow) => ({ ...flow, moves: [...flow.moves, { from: 'confirmed', to: 'pending_payment' }] }),
			async () => {
				const { order, token, paymentId } = await placeOnline();
				expect((await records.moveTo(order.id, 'confirmed')).status).toBe(200);
				expect((await records.moveTo(order.id, 'pending_payment')).status).toBe(200);
				const pay = await visit('POST', `/v1/shop/orders/${order.id}/pay`, token, {});
				expect(pay.status).toBe(200);
				const next = /** @type {string} */ ((await records.recordOf(order.id)).payment.paymentId);
				expect(next).not.toBe(paymentId);
				shop.payPayment(next);
				shop.advance(31_000);
				const read = await shop.api('GET', `/v1/orders/${order.id}`);
				expect(read.json).toMatchObject({ status: 'confirmed', payment: { state: 'paid', paid: order.totals.total } });
			},
		);
	});
});

describe('a delete, a recorded payment or an edit that loses its race (L1)', () => {
	/** A waiting order (1000) with an open Payments payment, a delivery address and one unit held. */
	const waiting = async () => {
		const seeded = await records.seedOrder({
			status: 'pending_payment',
			role: 'awaiting_payment',
			patch: {
				address: { ...ADDRESS, line2: '', area: '', postalCode: '', notes: '' },
				delivery: { method: 'delivery', zone: '', rate: '', rateName: '', fee: 0, locationId: null },
				payment: {
					method: 'online',
					kind: 'gateway',
					state: 'pending',
					paymentId: 'pay_placeholder',
					checkoutUrl: '',
					advance: 0,
					paid: 0,
					refunded: 0,
					checkedAt: null,
				},
				payments: [],
			},
		});
		const { paymentId } = seeded;
		await (
			await records.orders()
		).updateOne(
			{ websiteId: shop.websiteId, id: seeded.order.id },
			{ $set: { 'payment.paymentId': paymentId, 'payment.checkoutUrl': `${PAYMENTS}/pay/w/${paymentId}` } },
		);
		return { ...seeded, order: await records.recordOf(seeded.order.id) };
	};
	/** Another change of an order while Payments is asked (`set`). @param {string} id @param {Record<string, unknown>} set */
	const changeWhileCanceling = (id, set) => {
		meanwhile.cancel = async () => {
			await (await records.orders()).updateOne({ websiteId: shop.websiteId, id }, { $set: set });
		};
	};

	it('a delete leaves the order payable: the payment it canceled is dropped', async () => {
		const { order, paymentId, product } = await waiting();
		changeWhileCanceling(order.id, { staffNote: 'Call first', updatedAt: new Date(shop.now() + 1000) });
		const refused = await shop.api('DELETE', `/v1/orders/${order.id}`);
		expect(refused.status).toBe(409);
		expect(cancelsOf(paymentId)).toHaveLength(1);
		expect(await records.recordOf(order.id)).toMatchObject({
			status: 'pending_payment',
			payment: { paymentId: null, checkoutUrl: '' },
		});
		expect(await records.stockOf(product.id)).toBe(4);
	});

	it('a delete gives back nothing when the order’s money changed meanwhile (one transaction)', async () => {
		const { order, product } = await waiting();
		// staff recorded a payment meanwhile
		changeWhileCanceling(order.id, { 'payment.paid': 300 });
		expect((await shop.api('DELETE', `/v1/orders/${order.id}`)).status).toBe(409);
		const record = await records.recordOf(order.id);
		expect(record).toMatchObject({ stockHeld: true, payment: { paid: 300 } });
		expect(await records.stockOf(product.id)).toBe(4);
	});

	it('a delete cancels an open payment of an order that holds nothing any more', async () => {
		const { order, paymentId } = await waiting();
		await (
			await records.orders()
		).updateOne(
			{ websiteId: shop.websiteId, id: order.id },
			{ $set: { status: 'delivered', role: 'delivered', ...records.delivered() } },
		);
		expect((await shop.api('DELETE', `/v1/orders/${order.id}`)).status).toBe(204);
		expect(cancelsOf(paymentId)).toHaveLength(1);
		expect(await records.recordOf(order.id)).toBeNull();
	});

	it('a recorded payment leaves the order payable when another change won', async () => {
		const { order, paymentId } = await waiting();
		changeWhileCanceling(order.id, { 'payment.paid': 300 });
		const refused = await shop.api('POST', `/v1/orders/${order.id}/payments`, { method: 'cod', amount: 700 });
		expect(refused.status).toBe(409);
		expect(cancelsOf(paymentId)).toHaveLength(1);
		expect((await records.recordOf(order.id)).payment).toMatchObject({ paymentId: null, checkoutUrl: '', paid: 300 });
	});

	it('an edit that loses its race never drops the newer payment the order took meanwhile', async () => {
		const { order, paymentId } = await waiting();
		// another edit won, and the shopper started a payment for the new total
		const newer = 'pay_newer0000001';
		changeWhileCanceling(order.id, {
			'payment.paymentId': newer,
			'payment.checkoutUrl': `${PAYMENTS}/pay/w/${newer}`,
			updatedAt: new Date(shop.now() + 1000),
		});
		const refused = await shop.api('PATCH', `/v1/orders/${order.id}`, {
			lines: [{ variantId: order.lines[0].variantId, quantity: 2 }],
		});
		expect(refused.status).toBe(409);
		expect(cancelsOf(paymentId)).toHaveLength(1);
		expect((await records.recordOf(order.id)).payment).toMatchObject({
			paymentId: newer,
			checkoutUrl: `${PAYMENTS}/pay/w/${newer}`,
		});
	});
});
