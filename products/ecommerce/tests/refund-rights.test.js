/**
 * Who may give money back (the Ecommerce review of 2026-10-15, H1 and H2, `audit/review-ecommerce-2026-10-15.md`): a
 * refund that moves the order by the flow's `refundsCover` trigger needs that move's permission before any money moves,
 * and once the money is recorded the move never undoes the refund, its claim or its points; a move that gives money
 * back (a cancel after delivery, or before it, with `refund: auto`) needs the refund permission whatever permission the
 * move names.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { givePoints, loyaltyAccount } from '../adapters/ledger.js';
import { COLLECTIONS } from '../core/model.js';
import { readyShop } from './helpers.js';
import { orderRecords } from './order-records.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {ReturnType<typeof orderRecords>} */
let records;
/** The member the seeded orders belong to. */
const MEMBER = 'usr_engine000001';

beforeAll(async () => {
	shop = await readyShop();
	records = orderRecords(shop);
	await shop.setting('returns', 'pointsBack', 'proportional');
});
afterAll(async () => shop.product.close());

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

/** The flow's refunds that cover the payments move the order to refunded. @param {any} flow */
const covered = (flow) => ({ ...flow, triggers: { ...flow.triggers, refundsCover: 'refunded' } });

const balanceOf = async () => (await loyaltyAccount(await shop.db(), MEMBER, { now: shop.now() })).balance;

/** @param {string} id */
const claimOf = async (id) =>
	/** @type {any} */ (
		await (
			await shop.db()
		)
			.collection(COLLECTIONS.returns)
			.findOne({ websiteId: shop.websiteId, id }, { projection: { _id: 0 } })
	);

/** Delivered, as the engine's facts say. */
const DELIVERED = () => ({
	facts: { stock: 'sold', offers: 'counted', redeemed: 'spent', earned: 'none', units: 'none' },
	deliveredAt: new Date(shop.now()),
});

/**
 * A delivered order paid online (1000) that earned 20 points, with an approved return claim of its one line.
 * @param {{ role?: string }} [options] `role`: the step the order is in (as the flow had it)
 */
const claimed = async ({ role = 'delivered' } = {}) => {
	const { order, paymentId } = await records.seedOrder({
		status: 'delivered',
		role,
		patch: {
			...DELIVERED(),
			facts: { stock: 'sold', offers: 'counted', redeemed: 'spent', earned: 'credited', units: 'none' },
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
		},
	});
	const data = await shop.db();
	await givePoints(data, { userId: MEMBER, points: 20, orderId: order.id, kind: 'earn', expiresAt: null }, { now: shop.now() });
	const claimId = createId('ret');
	await data.collection(COLLECTIONS.returns).insertOne({
		id: claimId,
		orderId: order.id,
		orderNumber: order.number,
		userId: MEMBER,
		kind: 'return',
		lines: [{ lineId: order.lines[0].id, quantity: 1, serials: [] }],
		reason: 'Broken',
		photos: [],
		status: 'approved',
		refundAmount: 0,
		refundId: null,
		restockedAt: null,
		history: [],
		notes: [],
	});
	return { order, paymentId, claimId };
};

describe('a claim refund that covers the payments (H1)', () => {
	it('needs the permission of the move it triggers before any money moves', async () => {
		await withFlow(covered, async () => {
			const { order, paymentId, claimId } = await claimed();
			const start = await balanceOf();
			const returnsOnly = await shop.ticket(['returns.manage', 'orders.read']);
			/** @param {string} ticket @param {Record<string, unknown>} body */
			const refund = (ticket, body) => shop.admin(ticket, 'POST', `/v1/admin/returns/${claimId}/refund`, body);
			// the whole payment would move the order to refunded: refused before Payments is asked
			const refused = await refund(returnsOnly, { amount: 1000 });
			expect(refused.status).toBe(403);
			expect(records.refundCalls(paymentId)).toHaveLength(0);
			expect(await records.recordOf(order.id)).toMatchObject({ status: 'delivered', payment: { refunded: 0 }, refunds: [] });
			expect(await claimOf(claimId)).toMatchObject({ status: 'approved', refundAmount: 0 });
			expect(await balanceOf()).toBe(start);
			// a part that leaves the order where it is needs only the claims permission
			const part = await refund(returnsOnly, { amount: 400 });
			expect(part.status).toBe(200);
			expect(part.json).toMatchObject({ status: 'refunded', refundAmount: 400 });
			expect(await balanceOf()).toBe(start - 20);
			expect((await refund(returnsOnly, { amount: 600 })).status).toBe(403);
			// the rest, by staff who may also refund orders: the order moves to refunded, its points taken back once
			const refunder = await shop.ticket(['returns.manage', 'orders.read', 'orders.refund']);
			const rest = await refund(refunder, { amount: 600 });
			expect(rest.status).toBe(200);
			expect(rest.json).toMatchObject({ status: 'refunded', refundAmount: 1000 });
			expect(await records.recordOf(order.id)).toMatchObject({
				status: 'refunded',
				payment: { refunded: 1000, state: 'refunded' },
				promotions: { pointsReversed: 20 },
			});
			expect(records.refundCalls(paymentId).map((call) => JSON.parse(call.body).amount)).toEqual([400, 600]);
			expect(await balanceOf()).toBe(start - 20);
		});
	});

	it('never undoes the refund once the money is recorded: a move the order cannot make is left to staff', async () => {
		await withFlow(covered, async () => {
			// the order's step is not the flow's step of its status any more, so no move can be made for it
			const { order, paymentId, claimId } = await claimed({ role: 'shipped' });
			const start = await balanceOf();
			const done = await shop.api('POST', `/v1/returns/${claimId}/refund`, { amount: 1000 });
			expect(done.status).toBe(200);
			expect(done.json).toMatchObject({ status: 'refunded', refundAmount: 1000 });
			expect(records.refundCalls(paymentId)).toHaveLength(1);
			const record = await records.recordOf(order.id);
			expect(record).toMatchObject({ status: 'delivered', payment: { refunded: 1000, state: 'refunded' } });
			expect(record.lines[0].returnedQuantity).toBe(1);
			expect(await balanceOf()).toBe(start - 20);
		});
	});

	it('the staff refund route reports the refund even when the move after it cannot be made', async () => {
		await withFlow(covered, async () => {
			const { order, paymentId } = await claimed({ role: 'shipped' });
			const done = await shop.api('POST', `/v1/orders/${order.id}/refunds`, { amount: 1000, reason: 'Broken' });
			expect(done.status).toBe(201);
			expect(done.json.order).toMatchObject({ status: 'delivered', payment: { refunded: 1000 } });
			expect(records.refundCalls(paymentId)).toHaveLength(1);
		});
	});
});

describe('a move that gives money back (H2)', () => {
	/** @param {string} ticket @param {string} id @param {string} to */
	const moveAs = (ticket, id, to) => shop.admin(ticket, 'POST', `/v1/admin/orders/${id}/move`, { to });
	/** A delivered order paid online (1000). */
	const delivered = () => records.seedOrder({ status: 'delivered', role: 'delivered', patch: DELIVERED() });

	it('needs the refund permission, whatever permission the move names', async () => {
		await withFlow(
			(flow) => ({ ...flow, moves: [...flow.moves, { from: 'delivered', to: 'cancelled' }] }),
			async () => {
				const manager = await shop.ticket(['orders.read', 'orders.manage']);
				// after delivery: the cancel would give back what Payments took
				const after = await delivered();
				expect((await moveAs(manager, after.order.id, 'refunded')).status).toBe(403);
				expect((await moveAs(manager, after.order.id, 'cancelled')).status).toBe(403);
				expect(records.refundCalls(after.paymentId)).toHaveLength(0);
				expect(await records.recordOf(after.order.id)).toMatchObject({ status: 'delivered', payment: { refunded: 0 } });
				// before delivery too: a paid order's cancel refunds it
				const before = await records.seedOrder();
				expect((await moveAs(manager, before.order.id, 'cancelled')).status).toBe(403);
				expect(records.refundCalls(before.paymentId)).toHaveLength(0);
				expect((await records.recordOf(before.order.id)).status).toBe('confirmed');
				// nothing paid, nothing given back: the move's own permission is enough
				const unpaid = await records.seedOrder({ cod: true });
				expect((await moveAs(manager, unpaid.order.id, 'cancelled')).status).toBe(200);
				// staff who may refund: the money goes back
				const refunder = await shop.ticket(['orders.read', 'orders.manage', 'orders.refund']);
				const moved = await moveAs(refunder, after.order.id, 'cancelled');
				expect(moved.status).toBe(200);
				expect(moved.json).toMatchObject({ status: 'cancelled', payment: { refunded: 1000 } });
				expect(records.refundCalls(after.paymentId)).toHaveLength(1);
			},
		);
	});

	it('is not needed for a cancel that leaves the refund to staff', async () => {
		await withFlow(
			(flow) => ({ ...flow, moves: [...flow.moves, { from: 'delivered', to: 'cancelled', options: { refund: 'staff' } }] }),
			async () => {
				const manager = await shop.ticket(['orders.read', 'orders.manage']);
				const { order, paymentId } = await delivered();
				const moved = await moveAs(manager, order.id, 'cancelled');
				expect(moved.status).toBe(200);
				expect(moved.json).toMatchObject({ status: 'cancelled', payment: { refunded: 0 } });
				expect(records.refundCalls(paymentId)).toHaveLength(0);
			},
		);
	});
});
