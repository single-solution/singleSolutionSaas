/**
 * The Payments side of an order (PLAN 0.3; PLAN 0.8.10 E26, P4, K-13). Nothing runs on a timer.
 *
 * - Paid: an order is paid only when Payments says, server to server, that its payment is paid for exactly the order's
 *   amount (or COD advance) and currency; the payment is an `online` entry of its payments log (E26). A waiting payment
 *   is asked again when the order is read (at most every 30 seconds) and on use.
 * - Canceled: when an order whose Payments payment is still open is canceled (by staff, the shopper or the end of its
 *   window), deleted or edited, that payment is canceled at Payments first, so it can no longer be paid. Money paid just
 *   before keeps the order: it is recorded as paid and the cancel is refused, so a paid order is never canceled without
 *   a refund someone decides. When Payments cannot be reached the cancel goes on and the step is tried again on the next
 *   uses (for three days).
 * - After the cancel: money that still arrives (a gateway's late notice, a transfer confirmed in Payments; Payments flags
 *   it `refundDue`) is recorded on the canceled order, which then shows the refund due and is refunded the normal way.
 *   It is looked for when the order is read and on use, for three days after the cancel.
 * @module
 */
import { createId } from '@ss/contracts';
import { createOrdersStore } from '../adapters/orders-store.js';
import { canMove, statusOf, triggersOfFlow } from '../core/flow.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { paymentStateOf, serverNote } from '../core/orders.js';
import { VIA_PAYMENTS } from '../core/payment-methods.js';
import { planTransition } from '../core/transitions.js';
import { createTransitions, rulesOf } from './transitions.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').PaymentFacts} PaymentFacts */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').OrderFlow} OrderFlow */

/** A waiting payment is asked of Payments at most this often per order. */
export const RECHECK_MS = 30_000;
/** A cancel Payments could not take is tried again on use at most this often per order. */
const VOID_RETRY_MS = 60_000;
/** A canceled order's payment is asked about on use at most this often, for this long after the cancel. */
const LATE_EVERY_MS = 15 * 60_000;
const WATCH_MS = 3 * 86_400_000;
/** Who confirms what Payments confirmed. */
const PAYMENTS_ACTOR = Object.freeze({ kind: 'system', id: 'payments', name: 'Payments' });
/** What an order writes when it lets its Payments payment go: the shopper's next pay starts one for it as it is. */
export const DROPPED = Object.freeze({ 'payment.paymentId': null, 'payment.checkoutUrl': '', 'payment.checkedAt': null });

/**
 * What Payments must confirm for an order: its advance (COD) or its total.
 * @param {OrderRecord} order
 */
export const expectedOf = (order) => ({
	amount: order.payment.advance > 0 ? order.payment.advance : order.totals.total,
	currency: order.totals.currency,
});

/**
 * Whether the payments log has Payments' money of the order's payment.
 * @param {OrderRecord} order
 */
const tookIn = (order) =>
	(order.payments ?? []).some((entry) => entry.method === VIA_PAYMENTS && entry.reference === order.payment.paymentId);

/**
 * Whether an order's Payments payment may still be paid: started, not canceled at Payments, and not paid yet (records
 * from before the payments log, E26: while the order waits for it).
 * @param {OrderRecord} order
 */
export const openAtPayments = (order) =>
	Boolean(order.payment.paymentId) &&
	!order.payment.voidedAt &&
	((order.payments ?? []).length === 0 ? order.payment.state === 'pending' : !tookIn(order));

/**
 * Whether money may still arrive for a canceled order whose payment was canceled at Payments (K-13).
 * @param {OrderRecord} order
 */
const watched = (order) =>
	order.role === 'cancelled' && Boolean(order.payment.paymentId) && Boolean(order.payment.voidedAt) && !tookIn(order);

/**
 * What canceling an order's payment at Payments means for the cancel: `paid` the order, recorded as paid, when the money
 * came before (the cancel is refused); `reached` false when Payments could not be reached (the step is kept); `set` what
 * the cancel writes with it; `late` money paid after an earlier cancel, recorded on the canceled order.
 * @typedef {{ paid: OrderRecord | null, reached: boolean, set: Record<string, unknown>, late: PaymentFacts | null }} CancelStep
 */

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createOrderPayments = (product, service) => {
	const transitions = createTransitions(product, service);
	/** @param {Site} s @returns {Promise<OrderFlow>} */
	const flowOf = async (s) => /** @type {OrderFlow} */ (/** @type {unknown} */ (await s.list('order_flow')));

	/**
	 * Mark an order paid (Payments confirmed it: an `online` entry of its payments log, E26) and move it to the status the
	 * flow's `paid` trigger names, through the order engine (a transition guarded by the payment still pending). The flow
	 * may name none (or not list the move): the order is then paid but stays where it is.
	 * @param {Site} s @param {OrderRecord} order
	 * @returns {Promise<OrderRecord>}
	 */
	const confirmPaid = async (s, order) => {
		const store = createOrdersStore(await s.data());
		const flow = await flowOf(s);
		const now = service.now();
		const trigger = triggersOfFlow(flow).paid;
		const to = trigger && canMove(flow, order.status, trigger) ? trigger : null;
		const advance = order.payment.advance > 0;
		const amount = expectedOf(order).amount;
		/** @type {Record<string, unknown>} */
		const set = {
			'payment.state': advance ? 'unpaid' : 'paid',
			'payment.paid': amount,
			'payment.checkedAt': new Date(now),
			holdUntil: null,
		};
		const entry = {
			id: createId(ID_PREFIX.orderPayment),
			method: VIA_PAYMENTS,
			amount,
			reference: order.payment.paymentId ?? '',
			proofKey: null,
			note: advance ? 'Advance' : '',
			by: PAYMENTS_ACTOR,
			at: new Date(now),
		};
		const planned = to
			? planTransition({
					order,
					flow,
					to,
					input: {
						who: 'system',
						actor: PAYMENTS_ACTOR,
						by: 'system',
						...serverNote('payment_confirmed', 'Payment confirmed'),
						paid: { set, entry },
						where: { 'payment.state': 'pending' },
						checkUpdatedAt: false,
					},
					rules: await rulesOf(s),
					now,
				})
			: null;
		if (!planned?.ok) {
			// paid, staying where it is
			const paid = await store.change(order, set, { where: { 'payment.state': 'pending' }, push: { payments: entry } });
			if (!paid) return (await store.order(order.id)) ?? order;
			await service.emit('order.paid', s, { order: paid, entry });
			return (await store.order(order.id)) ?? paid;
		}
		const { plan } = planned;
		/** @type {OrderRecord} */
		let moved;
		try {
			moved = await transitions.apply(s, order, plan);
		} catch (error) {
			if (/** @type {any} */ (error)?.code === 'conflict') return (await store.order(order.id)) ?? order;
			throw error;
		}
		await service.emit('order.paid', s, { order: moved, entry });
		await product.activity.record(
			{ websiteId: s.websiteId, merchantId: s.merchantId, after: s.ctx.after },
			{
				actor: PAYMENTS_ACTOR,
				action: 'order.moved',
				target: order.id,
				label: order.number,
				detail: `${statusOf(flow, order.status)?.label ?? order.status} → ${statusOf(flow, to ?? '')?.label ?? to}`,
			},
		);
		await service.emit('order.moved', s, { order: moved, ...plan.event });
		return (await store.order(order.id)) ?? moved;
	};

	/**
	 * Record money Payments took for an order's payment outside the usual confirmation: paid before a cancel on an order
	 * that no longer waits for it, or paid after the cancel (`late`: the canceled order then shows the refund due). Once
	 * per payment; never moves the order.
	 * @param {Site} s @param {OrderRecord} order @param {PaymentFacts} payment @param {{ late: boolean }} how
	 * @returns {Promise<OrderRecord | null>} null when the order changed meanwhile
	 */
	const takeIn = async (s, order, payment, { late }) => {
		const store = createOrdersStore(await s.data());
		const now = service.now();
		const paymentId = /** @type {string} */ (order.payment.paymentId);
		const paid = order.payment.paid + payment.amount;
		const money = (await s.format()).money(payment.amount, order.totals.currency);
		const entry = {
			id: createId(ID_PREFIX.orderPayment),
			method: VIA_PAYMENTS,
			amount: payment.amount,
			reference: paymentId,
			proofKey: null,
			note: late ? 'Paid after the order was canceled' : '',
			by: PAYMENTS_ACTOR,
			at: new Date(now),
		};
		const state = paymentStateOf({
			total: order.totals.total,
			paid,
			refunded: order.payment.refunded,
			state: order.payment.state,
		});
		const changed = await store.change(
			order,
			{
				'payment.paid': paid,
				'payment.state': state,
				'payment.checkedAt': new Date(now),
				'payment.voidPendingAt': null,
				...(late ? { 'payment.voidedAt': order.payment.voidedAt ?? new Date(now) } : {}),
			},
			{
				where: {
					'payment.paid': order.payment.paid,
					payments: { $not: { $elemMatch: { method: VIA_PAYMENTS, reference: paymentId } } },
				},
				push: {
					payments: entry,
					history: {
						at: new Date(now),
						from: order.status,
						to: order.status,
						by: 'system',
						...(late
							? serverNote('paid_after_cancel', `Payment of ${money} arrived after the order was canceled: refund it`, {
									amount: payment.amount,
								})
							: serverNote('payments_took', `Payment of ${money} confirmed by Payments`, { amount: payment.amount })),
						kind: 'payment',
					},
				},
			},
		);
		if (!changed) return null;
		await service.emit('order.payment_recorded', s, { order: changed, entry });
		if (late) await service.emit('order.refund_due', s, { order: changed, amount: payment.amount });
		if (!late && state === 'paid' && order.payment.state !== 'paid')
			await service.emit('order.paid', s, { order: changed, entry });
		return changed;
	};

	/**
	 * Ask Payments about an order's payment (at most every {@link RECHECK_MS} unless `force`): a waiting one is confirmed
	 * once paid; a canceled order's canceled payment that was paid after all is recorded (refund due, K-13). Never
	 * throws: when Payments cannot be reached the order is returned as it was.
	 * @param {Site} s @param {OrderRecord} order @param {{ force?: boolean }} [options]
	 * @returns {Promise<{ order: OrderRecord, reached: boolean }>}
	 */
	const recheck = async (s, order, { force = false } = {}) => {
		const waiting = order.role === 'awaiting_payment' && order.payment.state === 'pending' && Boolean(order.payment.paymentId);
		if (!waiting && !watched(order)) return { order, reached: true };
		const now = service.now();
		const checkedAt = order.payment.checkedAt ? new Date(order.payment.checkedAt).getTime() : null;
		if (!force && checkedAt !== null && now - checkedAt < RECHECK_MS) return { order, reached: true };
		const paymentId = /** @type {string} */ (order.payment.paymentId);
		const store = createOrdersStore(await s.data());
		if (!waiting) {
			/** @type {PaymentFacts} */
			let facts;
			try {
				facts = await service.payments.read(s, paymentId);
			} catch {
				return { order, reached: false };
			}
			const taken = facts.status === 'paid' ? await takeIn(s, order, facts, { late: true }) : null;
			return { order: taken ?? (await store.change(order, { 'payment.checkedAt': new Date(now) })) ?? order, reached: true };
		}
		let verified = false;
		try {
			verified = (await service.payments.verify(s, paymentId, expectedOf(order))).verified;
		} catch {
			return { order, reached: false };
		}
		if (verified) return { order: await confirmPaid(s, order), reached: true };
		return { order: (await store.change(order, { 'payment.checkedAt': new Date(now) })) ?? order, reached: true };
	};

	/**
	 * Cancel an order's open Payments payment before the order is canceled, deleted or edited (K-13).
	 * @param {Site} s @param {OrderRecord} order as read @param {string} reason kept in the payment's history
	 * @returns {Promise<CancelStep>}
	 */
	const beforeCancel = async (s, order, reason) => {
		if (!openAtPayments(order)) return { paid: null, reached: true, set: {}, late: null };
		const now = new Date(service.now());
		const answer = await service.payments.cancel(s, /** @type {string} */ (order.payment.paymentId), reason);
		if (answer.outcome === 'voided') return { paid: null, reached: true, set: { 'payment.voidedAt': now }, late: null };
		if (answer.outcome === 'gone') return { paid: null, reached: true, set: {}, late: null };
		if (answer.outcome === 'unreachable')
			return {
				paid: null,
				reached: false,
				set: { 'payment.voidPendingAt': now, 'payment.checkedAt': now },
				late: null,
			};
		const expected = expectedOf(order);
		const before =
			!answer.payment.refundDue && answer.payment.amount === expected.amount && answer.payment.currency === expected.currency;
		// paid after an earlier cancel (or for another amount): the cancel goes on, the money is to be refunded
		if (!before) return { paid: null, reached: true, set: { 'payment.voidedAt': now }, late: answer.payment };
		// paid before the cancel: the order is paid, not canceled (confirmed as Payments' confirmation does, or, when it
		// no longer waits for the payment, the money recorded as it is)
		const checked = await recheck(s, order, { force: true });
		const paid =
			tookIn(checked.order) || !checked.reached ? checked.order : await takeIn(s, order, answer.payment, { late: false });
		return {
			paid: paid ?? /** @type {OrderRecord} */ (await createOrdersStore(await s.data()).order(order.id)),
			reached: true,
			set: {},
			late: null,
		};
	};

	/**
	 * Record on a just canceled order the money a {@link CancelStep} found was paid after an earlier cancel.
	 * @param {Site} s @param {OrderRecord} order the order after the cancel @param {CancelStep} step
	 */
	const afterCancel = async (s, order, step) => {
		if (step.late?.status === 'paid') await takeIn(s, order, step.late, { late: true });
	};

	/**
	 * Work on use: cancels Payments could not take are tried again, and canceled orders are watched for money that still
	 * arrives (bounded batches, for three days after the cancel).
	 * @param {Site} s
	 */
	const sweep = async (s) => {
		const store = createOrdersStore(await s.data());
		const now = service.now();
		for (const order of await store.voidsPending(now, VOID_RETRY_MS, WATCH_MS)) {
			const answer = await service.payments.cancel(s, /** @type {string} */ (order.payment.paymentId), 'Order canceled');
			const at = new Date(service.now());
			if (answer.outcome === 'paid' && answer.payment.status === 'paid')
				await takeIn(s, order, answer.payment, { late: true });
			else
				await store.change(order, {
					'payment.checkedAt': at,
					...(answer.outcome === 'unreachable'
						? {}
						: { 'payment.voidPendingAt': null, ...(answer.outcome === 'gone' ? {} : { 'payment.voidedAt': at }) }),
				});
		}
		for (const order of await store.toWatch(now, LATE_EVERY_MS, WATCH_MS)) await recheck(s, order, { force: true });
	};

	/**
	 * Drop the payment Payments canceled for a cancel or a move that then did not happen (it lost its race to another
	 * change, or failed after): only while the order still names that payment and nothing canceled the order meanwhile
	 * (that keeps it, watched for money that still comes), so the shopper's next pay starts one for the order as it is,
	 * as after an edit. Nothing to do when the step canceled nothing.
	 * @param {Site} s @param {OrderRecord} order as read @param {CancelStep | null} step
	 */
	const dropVoided = async (s, order, step) => {
		if (!step || !('payment.voidedAt' in step.set)) return;
		await (
			await s.data()
		)
			.collection(COLLECTIONS.orders)
			.updateOne(
				{ websiteId: s.websiteId, id: order.id, 'payment.paymentId': order.payment.paymentId, 'payment.voidedAt': null },
				{ $set: { ...DROPPED } },
			);
	};

	return Object.freeze({ confirmPaid, recheck, beforeCancel, afterCancel, dropVoided, sweep });
};

/** @typedef {ReturnType<typeof createOrderPayments>} OrderPayments */
