/**
 * Staff refunds Payments finishes later (the Ecommerce review of 2026-10-15, its suspected money findings,
 * `audit/review-ecommerce-2026-10-15.md`): one Payments did not answer at once moves the order by the flow's
 * `refundsCover` trigger once it is done (when staff open the order, and on any use of the shop), and a claim never says
 * it refunded money whose refund through Payments was then refused or not sent: it gets its refund back and can be
 * refunded again, its units and points counted once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loyaltyAccount } from '../adapters/ledger.js';
import { ORIGIN, readyShop } from './helpers.js';
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

/** Payments takes no refund of a payment (no answer) while `run` runs. @param {string} paymentId @param {() => Promise<any>} run */
const unanswered = async (paymentId, run) => {
	const restore = records.refundsAnswer({ status: 503, body: {} }, paymentId);
	try {
		return await run();
	} finally {
		restore();
	}
};

let ip = 0;
/** A use of the shop by a visitor (the work on use runs with it). */
const useShop = async () => {
	ip += 1;
	await shop.call('POST', '/v1/shop/cart/quote', {
		token: shop.browser,
		origin: ORIGIN,
		body: { lines: [{ productId: 'prd_none' }] },
		headers: { 'x-forwarded-for': `10.11.0.${ip}` },
	});
};

describe('a staff refund Payments finishes later', () => {
	it('moves the order to the refunded status once it is done, when staff open the order', async () => {
		await withFlow(covered, async () => {
			const { order, paymentId } = await records.seedOrder({
				status: 'delivered',
				role: 'delivered',
				patch: records.delivered(),
			});
			const pending = await unanswered(paymentId, () =>
				shop.api('POST', `/v1/orders/${order.id}/refunds`, { amount: 1000, reason: 'Broken' }),
			);
			expect(pending.status).toBe(201);
			expect(pending.json.warningCodes).toEqual([{ code: 'refund_pending', values: { amount: 1000 } }]);
			expect(pending.json.order).toMatchObject({ status: 'delivered', payment: { refunded: 0 } });
			shop.advance(61_000);
			const read = await shop.api('GET', `/v1/orders/${order.id}`);
			expect(read.json).toMatchObject({ status: 'refunded', payment: { refunded: 1000, state: 'refunded' } });
			expect(read.json.history.at(-1)).toMatchObject({
				from: 'delivered',
				to: 'refunded',
				code: 'refunds_cover_payments',
				by: 'Test Staff',
			});
			// sent again with the same key, never twice
			expect(new Set(records.refundCalls(paymentId).map((call) => call.headers['idempotency-key'])).size).toBe(1);
		});
	});

	it('and on any use of the shop, its earned points taken back with the move', async () => {
		await withFlow(covered, async () => {
			const { order, paymentId } = await records.seedClaimed();
			const start = await balanceOf();
			await unanswered(paymentId, () =>
				shop.api('POST', `/v1/orders/${order.id}/refunds`, { amount: 1000, reason: 'Broken' }),
			);
			shop.advance(61_000);
			await useShop();
			expect(await records.recordOf(order.id)).toMatchObject({
				status: 'refunded',
				payment: { refunded: 1000 },
				promotions: { pointsReversed: 20 },
			});
			expect(await balanceOf()).toBe(start - 20);
		});
	});
});

describe('a claim whose refund through Payments is not done', () => {
	it('gets its refund back when Payments then refuses it, and is refunded again with its units and points counted once', async () => {
		const { order, paymentId, claimId } = await records.seedClaimed();
		const start = await balanceOf();
		const pending = await unanswered(paymentId, () => shop.api('POST', `/v1/returns/${claimId}/refund`, { amount: 1000 }));
		expect(pending.status).toBe(200);
		expect(pending.json).toMatchObject({ status: 'refunded', refundAmount: 1000 });
		expect(pending.json.warningCodes).toEqual([{ code: 'refund_pending', values: { amount: 1000 } }]);
		// Payments then refuses it for good
		const restore = records.refundsAnswer(
			{ status: 422, type: 'application/problem+json', body: { status: 422, detail: 'The card cannot take refunds.' } },
			paymentId,
		);
		shop.advance(61_000);
		const read = await shop.api('GET', `/v1/orders/${order.id}`);
		restore();
		expect(read.json.effects).toEqual([expect.objectContaining({ state: 'failed', amount: 1000 })]);
		expect(read.json.payment).toMatchObject({ refunded: 0 });
		// the claim does not say it refunded money that never went back
		const claim = await shop.api('GET', `/v1/returns/${claimId}`);
		expect(claim.json).toMatchObject({ status: 'approved', refundAmount: 0, refundMethod: null, refundId: null });
		expect(claim.json.history.at(-1)).toMatchObject({ status: 'approved', by: 'system' });
		// refunded again: its units count as returned once, its points are taken back once
		const again = await shop.api('POST', `/v1/returns/${claimId}/refund`, { amount: 1000, method: 'cod' });
		expect(again.status).toBe(200);
		expect(again.json).toMatchObject({ status: 'refunded', refundAmount: 1000, refundMethod: 'cod' });
		const record = await records.recordOf(order.id);
		expect(record.payment).toMatchObject({ refunded: 1000, state: 'refunded' });
		expect(record.lines[0].returnedQuantity).toBe(1);
		expect(record.promotions.pointsReversed).toBe(20);
		expect(await balanceOf()).toBe(start - 20);
	});

	it('gets its refund back when staff refund the order by hand instead', async () => {
		const { order, paymentId, claimId } = await records.seedClaimed();
		await unanswered(paymentId, () => shop.api('POST', `/v1/returns/${claimId}/refund`, { amount: 1000 }));
		shop.advance(61_000);
		const byHand = await shop.api('POST', `/v1/orders/${order.id}/refunds`, {
			amount: 1000,
			reason: 'Paid back in the shop',
			method: 'cod',
		});
		expect(byHand.status).toBe(201);
		expect(byHand.json.order.effects).toEqual([expect.objectContaining({ state: 'skipped', amount: 1000 })]);
		expect(await records.claimOf(claimId)).toMatchObject({ status: 'approved', refundAmount: 0 });
	});

	it('keeps its refund once Payments does it', async () => {
		const { order, paymentId, claimId } = await records.seedClaimed();
		await unanswered(paymentId, () => shop.api('POST', `/v1/returns/${claimId}/refund`, { amount: 1000 }));
		shop.advance(61_000);
		const read = await shop.api('GET', `/v1/orders/${order.id}`);
		expect(read.json.payment).toMatchObject({ refunded: 1000 });
		expect(await records.claimOf(claimId)).toMatchObject({ status: 'refunded', refundAmount: 1000 });
	});
});
