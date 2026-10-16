/**
 * The order engine keeps stock, money and points right where a path could lose or double them (the engine review of
 * 2026-10-14, `audit/review-order-engine-2026-10-14.md`): an edit of a waiting order that held no stock, a refund whose
 * answer was lost (also after Payments forgot its key), two refunds at once, a delete while money is still due, a refund
 * through Payments not sent once the order was refunded meanwhile, a guest's points, a claim's points with a return at
 * the same time, and a move that loses its race after Payments or a courier was called.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { givePoints, loyaltyAccount } from '../adapters/ledger.js';
import { DEFAULT_FLOW } from '../core/flow.js';
import { COLLECTIONS } from '../core/model.js';
import { createCheckout } from '../server/checkout.js';
import { createMoves } from '../server/orders-moves.js';
import { createService } from '../server/service.js';
import { createTransitions } from '../server/transitions.js';
import { COURIER, DOMAIN, PAYMENTS, readyShop } from './helpers.js';
import { orderRecords } from './order-records.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {ReturnType<typeof createService>} */
let service;
/** @type {ReturnType<typeof createMoves>} */
let moves;
/** @type {ReturnType<typeof orderRecords>} */
let records;

beforeAll(async () => {
	shop = await readyShop();
	service = createService(shop.product);
	moves = createMoves(shop.product, service);
	records = orderRecords(shop);
});
afterAll(async () => shop.product.close());

/** A server-token request context, as the routes give the moves module. */
const ctx = () => ({
	websiteId: shop.websiteId,
	merchantId: null,
	status: { domain: DOMAIN },
	headers: new Headers(),
	ticket: null,
	after: () => {},
});

/** Delivery to an address. */
const DELIVERY = {
	address: {
		name: 'Eve',
		phone: '+15550001111',
		line1: '1 Main St',
		line2: '',
		city: 'Springfield',
		area: '',
		region: 'IL',
		postalCode: '62701',
		country: 'US',
		notes: '',
	},
	delivery: { method: 'delivery', zone: '', rate: '', rateName: '', fee: 0, locationId: null },
};

/** A move's input as the routes check it. @param {string} to @param {Record<string, unknown>} [extra] */
const input = (to, extra = {}) => ({ to, note: '', serials: {}, shipment: null, updatedAt: null, ...extra });

/** Someone else changes the order meanwhile (a note): its `updatedAt` moves on. @param {string} id */
const changeMeanwhile = async (id) => {
	shop.advance(1000);
	await (
		await records.orders()
	).updateOne({ websiteId: shop.websiteId, id }, { $set: { staffNote: 'changed', updatedAt: new Date(shop.now()) } });
};

/**
 * Payments as it is when a refund went through but its answer never came: the first refund of the payment is done (the
 * shop gets no answer), later ones are refused (nothing left, or the key forgotten after 24 hours); reading the
 * payment shows the refunds done, unless `state.readFails`. `state.extra` answers more refunds normally.
 * @param {string} paymentId
 */
const lostAnswer = (paymentId) => {
	const normal = /** @type {any} */ (shop.responders.get(PAYMENTS));
	/** @type {{ readFails: boolean, extra: boolean, done: Array<{ id: string, amount: number, manual: boolean }> }} */
	const state = { readFails: false, extra: false, done: [] };
	shop.responders.set(PAYMENTS, (call) => {
		if (call.path.endsWith(`/${paymentId}/refunds`)) {
			const amount = JSON.parse(call.body).amount;
			if (state.done.length === 0 || state.extra) {
				const refund = { id: `rfd_lost_${state.done.length + 1}`, amount, manual: false };
				state.done.push(refund);
				return state.done.length === 1
					? { status: 503, body: {} }
					: { status: 201, body: { id: paymentId, status: 'partially_refunded', refunds: [refund] } };
			}
			return {
				status: 422,
				type: 'application/problem+json',
				body: { status: 422, detail: 'Nothing is left to refund.' },
			};
		}
		if (call.method === 'GET' && call.path.endsWith(`/${paymentId}`)) {
			if (state.readFails) return { status: 503, body: {} };
			const refunded = state.done.reduce((sum, refund) => sum + refund.amount, 0);
			return {
				status: 200,
				body: { ...normal(call).body, status: 'paid', amount: 1000, refunded, refunds: state.done },
			};
		}
		return normal(call);
	});
	return { state, restore: () => shop.responders.set(PAYMENTS, normal) };
};

describe('an edit of a waiting order', () => {
	it('holds the stock of an imported order that held none, and a cancel gives it back (review 1)', async () => {
		const { order, product } = await records.seedOrder({
			status: 'awaiting_confirmation',
			role: 'awaiting_confirmation',
			cod: true,
			// imported: its stock was never held here
			patch: {
				...DELIVERY,
				stockHeld: false,
				facts: { stock: 'back', offers: 'counted', redeemed: 'spent', earned: 'none', units: 'none' },
			},
		});
		expect(await records.stockOf(product.id)).toBe(5);
		const edited = await shop.api('PATCH', `/v1/orders/${order.id}`, {
			lines: [{ variantId: order.lines[0].variantId, quantity: 2 }],
		});
		expect(edited.status).toBe(200);
		expect(await records.stockOf(product.id)).toBe(3);
		expect(await records.recordOf(order.id)).toMatchObject({ stockHeld: true, facts: { stock: 'held' } });
		expect((await records.moveTo(order.id, 'canceled')).status).toBe(200);
		expect(await records.stockOf(product.id)).toBe(5);
		expect((await records.recordOf(order.id)).facts.stock).toBe('back');
	});

	it('is refused when the order’s facts changed meanwhile, with the stock as it was', async () => {
		const { order, product } = await records.seedOrder({
			status: 'awaiting_confirmation',
			role: 'awaiting_confirmation',
			cod: true,
			patch: { ...DELIVERY, facts: { stock: 'held', offers: 'counted', redeemed: 'spent', earned: 'none', units: 'none' } },
		});
		// the facts moved on, the rest of the order as read
		await (
			await records.orders()
		).updateOne({ websiteId: shop.websiteId, id: order.id }, { $set: { 'facts.offers': 'released' } });
		const s = await service.site(ctx());
		const { ordering } = createCheckout(shop.product, service);
		await expect(
			ordering.editWaiting(s, ctx(), order, { lines: [{ variantId: order.lines[0].variantId, quantity: 2 }] }),
		).rejects.toMatchObject({ code: 'conflict' });
		expect(await records.stockOf(product.id)).toBe(4);
	});
});

describe('a refund whose answer was lost', () => {
	it('is recorded once Payments shows it, never sent again, also after Payments forgot its key (review 2)', async () => {
		const { order, paymentId } = await records.seedOrder();
		const payments = lostAnswer(paymentId);
		try {
			const canceled = await records.moveTo(order.id, 'canceled');
			expect(canceled.json.effects[0]).toMatchObject({ state: 'pending', tries: 1 });
			expect(records.refundCalls(paymentId)).toHaveLength(1);
			// a day later Payments forgot the key; it cannot be read right now: the refund waits, nothing is sent
			payments.state.readFails = true;
			shop.advance(25 * 3_600_000);
			const unread = await shop.api('GET', `/v1/orders/${order.id}`);
			expect(unread.json.effects[0]).toMatchObject({ state: 'pending' });
			expect(records.refundCalls(paymentId)).toHaveLength(1);
			// it can be read: the refund it shows is recorded, not sent again (a new refund would be refused, or paid twice)
			payments.state.readFails = false;
			shop.advance(61_000);
			const read = await shop.api('GET', `/v1/orders/${order.id}`);
			expect(read.json.effects[0]).toMatchObject({ state: 'done', refundId: 'rfd_lost_1' });
			expect(read.json.payment).toMatchObject({ state: 'refunded', refunded: 1000 });
			expect(read.json.refunds).toEqual([
				expect.objectContaining({ method: 'payments', amount: 1000, refundId: 'rfd_lost_1' }),
			]);
			expect(records.refundCalls(paymentId)).toHaveLength(1);
		} finally {
			payments.restore();
		}
	});

	it('of a staff refund, then a move into refunded: each part refunded once (review 3)', async () => {
		const { order, paymentId } = await records.seedOrder({ status: 'delivered', role: 'delivered' });
		const payments = lostAnswer(paymentId);
		payments.state.extra = true;
		try {
			const part = await shop.api('POST', `/v1/orders/${order.id}/refunds`, { amount: 300, reason: 'Late' });
			expect(part.status).toBe(201);
			expect(part.json.refund).toMatchObject({ amount: 300, pending: true });
			expect(part.json.warningCodes).toEqual([{ code: 'refund_pending', values: { amount: 300 } }]);
			// the rest goes back with the move, the 300 kept pending is not asked twice
			const moved = await records.moveTo(order.id, 'refunded');
			expect(moved.status).toBe(200);
			expect(moved.json.payment).toMatchObject({ refunded: 700 });
			expect(records.refundCalls(paymentId).map((call) => JSON.parse(call.body ?? '{}').amount)).toEqual([300, 700]);
			// on use the 300 Payments did is recorded from what Payments shows
			shop.advance(61_000);
			const read = await shop.api('GET', `/v1/orders/${order.id}`);
			expect(read.json.payment).toMatchObject({ refunded: 1000, state: 'refunded', refundable: 0 });
			expect(read.json.effects.map((/** @type {any} */ effect) => effect.state)).toEqual(['done', 'done']);
			expect(records.refundCalls(paymentId)).toHaveLength(2);
		} finally {
			payments.restore();
		}
	});

	it('two staff refunds at once: one wins, the other changes nothing (409)', async () => {
		const { order, paymentId } = await records.seedOrder();
		const s = await service.site(ctx());
		const refund = { amount: 400, method: null, reason: 'Twice', reference: '', claimId: null };
		const both = await Promise.allSettled([
			moves.refund(s, ctx(), order, refund),
			moves.refund(await service.site(ctx()), ctx(), order, refund),
		]);
		expect(both.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(/** @type {PromiseRejectedResult} */ (both.find((result) => result.status === 'rejected')).reason.code).toBe(
			'conflict',
		);
		expect(records.refundCalls(paymentId)).toHaveLength(1);
		expect((await records.recordOf(order.id)).payment).toMatchObject({ refunded: 400 });
	});
});

describe('a delete', () => {
	it('is refused while a refund is pending or the order still holds money to give back (review 4)', async () => {
		const pending = await records.seedOrder();
		const restore = records.refundsAnswer({ status: 503, body: {} });
		try {
			expect((await records.moveTo(pending.order.id, 'canceled')).status).toBe(200);
		} finally {
			restore();
		}
		const refused = await shop.api('DELETE', `/v1/orders/${pending.order.id}`);
		expect(refused.status).toBe(409);
		expect(refused.json.detail).toMatch(/refund through Payments is pending/);
		shop.advance(61_000);
		expect((await shop.api('GET', `/v1/orders/${pending.order.id}`)).json.effects[0].state).toBe('done');
		expect((await shop.api('DELETE', `/v1/orders/${pending.order.id}`)).status).toBe(204);

		// canceled with the refund left to staff: the money is still the shopper's
		await shop.moveOptions('confirmed', 'canceled', { refund: 'staff' });
		try {
			const held = await records.seedOrder();
			expect((await records.moveTo(held.order.id, 'canceled')).json.payment).toMatchObject({ refundDue: 1000 });
			const holds = await shop.api('DELETE', `/v1/orders/${held.order.id}`);
			expect(holds.status).toBe(409);
			expect(holds.json.detail).toMatch(/Refund the USD 10\.00 it still holds/);
			expect((await shop.api('POST', `/v1/orders/${held.order.id}/refunds`, { amount: 1000, reason: 'Gone' })).status).toBe(
				201,
			);
			expect((await shop.api('DELETE', `/v1/orders/${held.order.id}`)).status).toBe(204);
		} finally {
			await shop.moveOptions('confirmed', 'canceled', {});
		}

		// a delivered order keeps what was paid for it
		const delivered = await records.seedOrder({ status: 'delivered', role: 'delivered' });
		expect((await shop.api('DELETE', `/v1/orders/${delivered.order.id}`)).status).toBe(204);
	});

	it('is refused while the parcel is with the courier: its units are not back in stock (review M5)', async () => {
		const { order, product } = await records.seedOrder({ status: 'dispatched', role: 'shipped', cod: true });
		const before = await records.stockOf(product.id);
		const refused = await shop.api('DELETE', `/v1/orders/${order.id}`);
		expect(refused.status).toBe(409);
		expect(refused.json.detail).toMatch(/returned to origin/);
		expect(await records.stockOf(product.id)).toBe(before);
		expect(await records.recordOf(order.id)).toMatchObject({ status: 'dispatched', stockHeld: true });
	});
});

describe('a refund through Payments', () => {
	it('warn when a refund through Payments is not sent because the order was refunded meanwhile', async () => {
		const { order, paymentId } = await records.seedOrder({
			status: 'canceled',
			role: 'canceled',
			patch: {
				stockHeld: false,
				payment: {
					method: 'online',
					kind: 'gateway',
					state: 'refunded',
					paymentId: 'pay_placeholder',
					advance: 0,
					paid: 1000,
					refunded: 1000,
					checkedAt: null,
				},
			},
		});
		const effect = {
			id: `${order.id}:cancel`,
			kind: 'refund',
			amount: 1000,
			state: 'pending',
			reason: 'Order canceled',
			note: 'Order canceled',
			by: { kind: 'staff', id: 'usr_staff', name: 'Sam' },
			at: new Date(shop.now()),
			tries: 0,
			triedAt: null,
		};
		await (
			await records.orders()
		).updateOne(
			{ websiteId: shop.websiteId, id: order.id },
			{
				$set: {
					'payment.paymentId': paymentId,
					effects: [effect],
					refunds: [
						{
							id: createId('orf'),
							method: 'payments',
							amount: 1000,
							reference: '',
							claimId: null,
							note: '',
							by: effect.by,
							at: new Date(shop.now()),
							refundId: 'rfd_before',
						},
					],
				},
			},
		);
		const s = await service.site(ctx());
		const transitions = createTransitions(shop.product, service);
		const { outcomes } = await transitions.runEffects(s, await records.recordOf(order.id), { ids: [effect.id] });
		expect(outcomes).toEqual([
			expect.objectContaining({
				state: 'skipped',
				warning: expect.objectContaining({ code: 'refund_skipped', values: { amount: 1000 } }),
			}),
		]);
		expect(records.refundCalls(paymentId)).toHaveLength(0);
	});
});

describe('loyalty points', () => {
	/** @param {any} owner */
	const balanceOf = async (owner) => (await loyaltyAccount(await shop.db(), owner, { now: shop.now() })).balance;
	const GUEST = { userId: '', name: 'Gus', email: '', phone: '+15550002222', customerId: 'cus_guestpoints01' };

	it('a guest redeemed go back to the guest’s own record on a cancel and a delete (review 6)', async () => {
		/** A waiting guest order that redeemed 40 points. */
		const guestOrder = () =>
			records.seedOrder({
				status: 'awaiting_confirmation',
				role: 'awaiting_confirmation',
				cod: true,
				patch: {
					customer: GUEST,
					promotions: {
						couponId: null,
						couponCode: '',
						dealIds: [],
						bundleIds: [],
						pointsRedeemed: 40,
						pointsValue: 400,
						pointsEarned: 0,
						pointsFixed: false,
						pointsCredited: false,
						released: false,
					},
				},
			});
		const owner = { customerId: GUEST.customerId };
		const start = await balanceOf(owner);
		const canceled = await guestOrder();
		expect((await records.moveTo(canceled.order.id, 'canceled')).status).toBe(200);
		expect(await balanceOf(owner)).toBe(start + 40);
		const deleted = await guestOrder();
		expect((await shop.api('DELETE', `/v1/orders/${deleted.order.id}`)).status).toBe(204);
		expect(await balanceOf(owner)).toBe(start + 80);
		// nothing went to an account without an owner
		const loyalty = (await shop.db()).collection(COLLECTIONS.loyalty);
		expect(await loyalty.countDocuments({ websiteId: shop.websiteId, userId: '' })).toBe(0);
	});

	it('earned are taken back once when a claim’s refund and a return of the order meet (review 7)', async () => {
		const MEMBER = 'usr_engine000001';
		await shop.setting('returns', 'pointsBack', 'proportional');
		// the flow takes customer returns of delivered orders (kept: the order stays in that status)
		const flow = await shop.flow((saved) => ({
			...saved,
			statuses: [...saved.statuses, { key: 'customer_returned', label: 'Returned', role: 'returned' }],
			moves: [...saved.moves, { from: 'delivered', to: 'customer_returned' }],
		}));
		const { order } = await records.seedOrder({
			status: 'delivered',
			role: 'delivered',
			cod: true,
			patch: {
				payment: {
					method: 'cod',
					kind: 'on_delivery',
					state: 'paid',
					paymentId: null,
					advance: 0,
					paid: 1000,
					refunded: 0,
					checkedAt: null,
				},
				promotions: {
					couponId: null,
					couponCode: '',
					dealIds: [],
					bundleIds: [],
					pointsRedeemed: 0,
					pointsValue: 0,
					pointsEarned: 20,
					pointsFixed: true,
					pointsCredited: true,
					released: false,
				},
				facts: { stock: 'sold', offers: 'counted', redeemed: 'spent', earned: 'credited', units: 'none' },
				deliveredAt: new Date(shop.now()),
			},
		});
		const data = await shop.db();
		await givePoints(
			data,
			{ userId: MEMBER, points: 20, orderId: order.id, kind: 'earn', expiresAt: null },
			{ now: shop.now() },
		);
		// points from other orders, which a second reversal would eat into
		await givePoints(
			data,
			{ userId: MEMBER, points: 100, orderId: null, kind: 'adjust', expiresAt: null },
			{ now: shop.now() },
		);
		const start = await balanceOf(MEMBER);
		const claimId = createId('ret');
		await data.collection(COLLECTIONS.returns).insertOne({
			id: claimId,
			orderId: order.id,
			orderNumber: order.number,
			userId: MEMBER,
			kind: 'return',
			window: 'return',
			outcomes: ['refund'],
			lines: [{ lineId: order.lines[0].id, quantity: 1, serials: [] }],
			reason: 'Broken',
			photos: [],
			status: 'approved',
			role: 'approved',
			refundAmount: 0,
			refundId: null,
			restockedAt: null,
			history: [],
			notes: [],
		});
		// staff take the return with the order as read before the claim's refund took the points back
		const read = await records.recordOf(order.id);
		expect((await shop.api('POST', `/v1/returns/${claimId}/refund`, { amount: 1000, method: 'cod' })).status).toBe(200);
		expect(await balanceOf(MEMBER)).toBe(start - 20);
		const s = await service.site(ctx());
		await expect(moves.move(s, ctx(), read, input('customer_returned'), flow)).rejects.toMatchObject({ code: 'conflict' });
		// read again: nothing left to take back
		const returned = await records.moveTo(order.id, 'customer_returned');
		expect(returned.status).toBe(200);
		expect(await balanceOf(MEMBER)).toBe(start - 20);
		expect((await records.recordOf(order.id)).promotions.pointsReversed).toBe(20);
	});
});

describe('a move that loses its race after calling out', () => {
	it('leaves a waiting order payable when its Payments payment was canceled for it (review 8)', async () => {
		const paymentId = `pay_${createId('ord').slice(4, 16)}`;
		const { order } = await records.seedOrder({
			status: 'pending_payment',
			role: 'awaiting_payment',
			patch: {
				payment: {
					method: 'online',
					kind: 'gateway',
					state: 'pending',
					paymentId,
					checkoutUrl: `${PAYMENTS}/pay/w/${paymentId}`,
					advance: 0,
					paid: 0,
					refunded: 0,
					checkedAt: null,
				},
				payments: [],
			},
		});
		await changeMeanwhile(order.id);
		const s = await service.site(ctx());
		await expect(moves.move(s, ctx(), order, input('canceled'), DEFAULT_FLOW)).rejects.toMatchObject({ code: 'conflict' });
		expect(shop.callsTo(`${PAYMENTS}/v1/payments/${paymentId}/cancel`)).toHaveLength(1);
		// the payment Payments canceled is dropped: the shopper's next pay starts a new one
		expect(await records.recordOf(order.id)).toMatchObject({
			status: 'pending_payment',
			payment: { paymentId: null, checkoutUrl: '', state: 'pending' },
		});
	});

	it('keeps a courier booking on the order and uses it when the move is made again (review 8)', async () => {
		await shop.list('couriers', [
			{ key: 'swift', name: 'Swift Post', trackingUrl: 'https://track.example.org/{tracking}', connection: 'courier_1' },
		]);
		await shop.connect('courier_1', {
			bookUrl: `${COURIER}/book`,
			trackUrl: `${COURIER}/track/{tracking}`,
			apiKey: 'courier-key-123',
			headers: '{"X-Api-Key":"{apiKey}"}',
			bodyTemplate: '{"ref":"{number}"}',
			trackingPath: 'data.cn',
			statusPath: 'data.state',
		});
		await shop.setting('courier_apis', 'courier', 'swift');
		let booked = 0;
		shop.responders.set(`${COURIER}/book`, () => {
			booked += 1;
			return { status: 200, body: { data: { cn: `CN ${booked}` } } };
		});
		const { order } = await records.seedOrder({
			status: 'packed',
			role: 'packed',
			cod: true,
			patch: DELIVERY,
		});
		await changeMeanwhile(order.id);
		const s = await service.site(ctx());
		await expect(
			moves.move(s, ctx(), order, input('dispatched', { shipment: { book: true } }), DEFAULT_FLOW),
		).rejects.toMatchObject({ code: 'conflict' });
		expect(booked).toBe(1);
		expect((await records.recordOf(order.id)).shipment).toMatchObject({ trackingNumber: 'CN 1', booked: true });
		// made again: the package booked already ships, it is not booked twice
		const shipped = await records.moveTo(order.id, 'dispatched', { shipment: { book: true } });
		expect(shipped.status).toBe(200);
		expect(shipped.json.shipment).toMatchObject({ trackingNumber: 'CN 1', booked: true, courier: 'Swift Post' });
		expect(booked).toBe(1);
	});
});
