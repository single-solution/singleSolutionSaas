/**
 * Who may give money back (the Ecommerce review of 2026-10-15, H1 and H2, `audit/review-ecommerce-2026-10-15.md`): a
 * refund that moves the order by the flow's `refundsCover` trigger needs that move's permission before any money moves,
 * and once the money is recorded the move never undoes the refund, its claim or its points; a move that gives money
 * back (a cancel after delivery, or before it, with `refund: auto`) needs the refund permission whatever permission the
 * move names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loyaltyAccount } from '../adapters/ledger.js';
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

describe('a claim refund that covers the payments (H1)', () => {
	it('needs the permission of the move it triggers before any money moves', async () => {
		await withFlow(covered, async () => {
			const { order, paymentId, claimId } = await records.seedClaimed();
			const start = await balanceOf();
			const returnsOnly = await shop.ticket(['returns.manage', 'orders.read']);
			/** @param {string} ticket @param {Record<string, unknown>} body */
			const refund = (ticket, body) => shop.admin(ticket, 'POST', `/v1/admin/returns/${claimId}/refund`, body);
			// money back needs the refund permission, a part or the whole (SR-5b-6): refused before Payments is asked
			const refused = await refund(returnsOnly, { amount: 1000 });
			expect(refused.status).toBe(403);
			expect((await refund(returnsOnly, { amount: 400 })).status).toBe(403);
			expect(records.refundCalls(paymentId)).toHaveLength(0);
			expect(await records.recordOf(order.id)).toMatchObject({ status: 'delivered', payment: { refunded: 0 }, refunds: [] });
			expect(await records.claimOf(claimId)).toMatchObject({ status: 'approved', refundAmount: 0 });
			expect(await balanceOf()).toBe(start);
			// staff who may refund: a part that leaves the order where it is, then the rest, which moves the order to refunded
			// (the move into it needs the refund permission too), its points taken back once
			const refunder = await shop.ticket(['returns.manage', 'orders.read', 'orders.refund']);
			const part = await refund(refunder, { amount: 400 });
			expect(part.status).toBe(200);
			expect(part.json).toMatchObject({ status: 'refunded', refundAmount: 400 });
			expect(await balanceOf()).toBe(start - 20);
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
			const { order, paymentId, claimId } = await records.seedClaimed({ role: 'shipped' });
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
			const { order, paymentId } = await records.seedClaimed({ role: 'shipped' });
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
	const delivered = () => records.seedOrder({ status: 'delivered', role: 'delivered', patch: records.delivered() });

	it('needs the refund permission, whatever permission the move names', async () => {
		await withFlow(
			(flow) => ({ ...flow, moves: [...flow.moves, { from: 'delivered', to: 'canceled' }] }),
			async () => {
				const manager = await shop.ticket(['orders.read', 'orders.manage']);
				// after delivery: the cancel would give back what Payments took
				const after = await delivered();
				expect((await moveAs(manager, after.order.id, 'refunded')).status).toBe(403);
				expect((await moveAs(manager, after.order.id, 'canceled')).status).toBe(403);
				expect(records.refundCalls(after.paymentId)).toHaveLength(0);
				expect(await records.recordOf(after.order.id)).toMatchObject({ status: 'delivered', payment: { refunded: 0 } });
				// before delivery too: a paid order's cancel refunds it
				const before = await records.seedOrder();
				expect((await moveAs(manager, before.order.id, 'canceled')).status).toBe(403);
				expect(records.refundCalls(before.paymentId)).toHaveLength(0);
				expect((await records.recordOf(before.order.id)).status).toBe('confirmed');
				// nothing paid, nothing given back: the move's own permission is enough
				const unpaid = await records.seedOrder({ cod: true });
				expect((await moveAs(manager, unpaid.order.id, 'canceled')).status).toBe(200);
				// staff who may refund: the money goes back
				const refunder = await shop.ticket(['orders.read', 'orders.manage', 'orders.refund']);
				const moved = await moveAs(refunder, after.order.id, 'canceled');
				expect(moved.status).toBe(200);
				expect(moved.json).toMatchObject({ status: 'canceled', payment: { refunded: 1000 } });
				expect(records.refundCalls(after.paymentId)).toHaveLength(1);
			},
		);
	});

	it('is not needed for a cancel that leaves the refund to staff', async () => {
		await withFlow(
			(flow) => ({ ...flow, moves: [...flow.moves, { from: 'delivered', to: 'canceled', options: { refund: 'staff' } }] }),
			async () => {
				const manager = await shop.ticket(['orders.read', 'orders.manage']);
				const { order, paymentId } = await delivered();
				const moved = await moveAs(manager, order.id, 'canceled');
				expect(moved.status).toBe(200);
				expect(moved.json).toMatchObject({ status: 'canceled', payment: { refunded: 0 } });
				expect(records.refundCalls(paymentId)).toHaveLength(0);
			},
		);
	});
});

describe('the same rules on the server routes (SR-5b-1)', () => {
	/** The server token with the sign-in of a staff member whose role holds some permissions of this product. @param {string[]} keys */
	const staffWith = (keys) => ({ permissions: keys.map((key) => `ecommerce:${key}`) });
	/** @param {string[]} keys @param {string} path @param {unknown} body */
	const asStaff = (keys, path, body) => shop.call('POST', path, { token: shop.server, staff: staffWith(keys), body });
	/** A delivered order paid online (1000). */
	const delivered = () => records.seedOrder({ status: 'delivered', role: 'delivered', patch: records.delivered() });

	it('a move that gives money back needs orders.refund: one move, one bulk move, from a role that may only manage', async () => {
		await withFlow(
			(flow) => ({ ...flow, moves: [...flow.moves, { from: 'delivered', to: 'canceled' }] }),
			async () => {
				const manager = ['orders.read', 'orders.manage', 'bulk.run'];
				const one = await delivered();
				const refused = await asStaff(manager, `/v1/orders/${one.order.id}/move`, { to: 'canceled' });
				expect(refused.status).toBe(403);
				const toRefunded = await asStaff(manager, `/v1/orders/${one.order.id}/move`, { to: 'refunded' });
				expect(toRefunded.status).toBe(403);
				const many = await delivered();
				const bulk = await asStaff(manager, '/v1/orders/bulk-move', { ids: [one.order.id, many.order.id], to: 'canceled' });
				expect(bulk.status).toBe(200);
				expect(bulk.json.moved).toBe(0);
				expect(bulk.json.results.map((/** @type {any} */ result) => result.code)).toEqual(['forbidden', 'forbidden']);
				expect(records.refundCalls(one.paymentId)).toHaveLength(0);
				expect(records.refundCalls(many.paymentId)).toHaveLength(0);
				expect(await records.recordOf(one.order.id)).toMatchObject({ status: 'delivered', payment: { refunded: 0 } });
				// a role that may refund: the money goes back
				const refunder = [...manager, 'orders.refund'];
				const moved = await asStaff(refunder, `/v1/orders/${one.order.id}/move`, { to: 'canceled' });
				expect(moved.status).toBe(200);
				expect(moved.json).toMatchObject({ status: 'canceled', payment: { refunded: 1000 } });
				expect(records.refundCalls(one.paymentId)).toHaveLength(1);
				// the Owner's `*` and the merchant's own server (no staff member) are not held back
				const owner = await shop.call('POST', `/v1/orders/${many.order.id}/move`, {
					token: shop.server,
					staff: { permissions: ['*'] },
					body: { to: 'canceled' },
				});
				expect(owner.status).toBe(200);
			},
		);
	});

	it('a move that names another permission needs it too: a bulk operator without orders.manage moves nothing', async () => {
		const placed = await records.seedOrder();
		const bulk = await asStaff(['bulk.run'], '/v1/orders/bulk-move', { ids: [placed.order.id], to: 'packed' });
		expect(bulk.status).toBe(200);
		expect(bulk.json.moved).toBe(0);
		expect(bulk.json.results[0]).toMatchObject({ ok: false, code: 'forbidden' });
		expect((await records.recordOf(placed.order.id)).status).toBe('confirmed');
		const allowed = await asStaff(['bulk.run', 'orders.manage'], '/v1/orders/bulk-move', {
			ids: [placed.order.id],
			to: 'packed',
		});
		expect(allowed.json.moved).toBe(1);
	});
});

describe('a refund on a return needs orders.refund as well (SR-5b-6)', () => {
	/** @param {string[]} keys @param {string} claimId @param {unknown} body */
	const asStaff = (keys, claimId, body) =>
		shop.call('POST', `/v1/returns/${claimId}/refund`, {
			token: shop.server,
			staff: { permissions: keys.map((key) => `ecommerce:${key}`) },
			body,
		});

	it('a returns agent without it is refused before any money moves, by sign-in and by ticket', async () => {
		const { order, paymentId, claimId } = await records.seedClaimed();
		const start = await balanceOf();
		expect((await asStaff(['returns.manage', 'orders.read'], claimId, { amount: 400 })).status).toBe(403);
		const agent = await shop.ticket(['returns.manage', 'orders.read']);
		expect((await shop.admin(agent, 'POST', `/v1/admin/returns/${claimId}/refund`, { amount: 400 })).status).toBe(403);
		expect(records.refundCalls(paymentId)).toHaveLength(0);
		expect(await records.recordOf(order.id)).toMatchObject({ payment: { refunded: 0 }, refunds: [] });
		expect(await records.claimOf(claimId)).toMatchObject({ status: 'approved', refundAmount: 0 });
		expect(await balanceOf()).toBe(start);
		// with the refund permission the money goes back
		const done = await asStaff(['returns.manage', 'orders.refund'], claimId, { amount: 400 });
		expect(done.status).toBe(200);
		expect(done.json).toMatchObject({ status: 'refunded', refundAmount: 400 });
		expect(records.refundCalls(paymentId)).toHaveLength(1);
	});

	it('a part that leaves the order where it is still needs the refund permission, and a covering one the move’s too', async () => {
		await withFlow(covered, async () => {
			const { order, paymentId, claimId } = await records.seedClaimed();
			const refunder = ['returns.manage', 'orders.refund'];
			expect((await asStaff(refunder, claimId, { amount: 400 })).status).toBe(200);
			expect((await asStaff(refunder, claimId, { amount: 600 })).status).toBe(200);
			expect(await records.recordOf(order.id)).toMatchObject({ status: 'refunded', payment: { refunded: 1000 } });
			expect(records.refundCalls(paymentId)).toHaveLength(2);
		});
	});
});
