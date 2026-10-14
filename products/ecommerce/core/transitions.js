/**
 * The order engine's plan (PLAN 0.8.10 "Ecommerce dynamic model", design §3.3, phase 1): one function for every way an
 * order changes its status — staff and bulk moves, the shopper's cancel, the end of a waiting window, Payments'
 * confirmation, a recorded payment that confirms, refunds that cover the payments — and one for a delete, which gives
 * back what the order holds without a status. `server/transitions.js` runs a plan in one database transaction.
 *
 * A plan is what the transition writes on the order (`set`, `push`, `inc`), guarded by the order as read (its status,
 * `updatedAt` and facts: compare-and-set), the **ledger** effects written in the same transaction (stock, slots, offer
 * uses, points, units sold, the RTO count, serial numbers) and the **external** effects that run after it (a refund
 * through Payments, kept on the order as `effects` until done). The effects are the difference between the order's
 * facts (`core/facts.js`) and those of the stage (role) it enters, never a status label, so a repeated or concurrent
 * move changes nothing twice:
 *
 * - into `awaiting_payment` or `open` from `packed`: serial numbers captured go back (units → none); back to waiting,
 *   the time to pay starts again (`rules.rewaitMinutes`);
 * - into `packed`: the serial numbers of the packing plan are captured (units → captured); the dispatch video is kept;
 * - into `shipped`: the shipment;
 * - into `delivered`: stock held → sold, units counted sold, cash on delivery paid (`rules.paidOnDelivery`), earned
 *   points credited once (`loyalty`, none → credited);
 * - into `cancelled`, or `refunded` before delivery (a cancel): stock and slots back, offer uses released, redeemed
 *   points given back, serial numbers back, each only while the facts say it was not; what Payments took is refunded
 *   after the transaction when `rules.refundOnCancel` (staff; a shopper's cancel and an ended window leave it due);
 * - into `returned_to_origin` or `returned`: stock back (`rules.restock`) or kept out, serial numbers back, an RTO
 *   counted (not a customer's return); after delivery earned points reversed and redeemed ones given back;
 * - into `refunded`: what is left is refunded — the part Payments took through Payments after the transaction (an
 *   external effect, as a staff cancel's), the rest recorded as given back by hand; before delivery it acts as a cancel;
 *   after delivery earned points are reversed and redeemed ones given back.
 *
 * Refusals: `move_not_allowed` (the flow's moves and the role rules; a transition that needs no listed move — an ended
 * window, a shopper's cancel — still follows the role rules), `flow_changed` (the order's role is not the flow's role of
 * its status any more) and `nothing_paid` (a refund before delivery when nothing was paid). What the caller sends (the
 * shipment, the serial numbers, the dispatch video) it checks before. Pure functions, no I/O (ids are random).
 *
 * The ways in still differ as before the engine (phase 1 changes none of them; phase 2 makes them options of the flow):
 * only a staff cancel refunds what Payments took (`refundOnCancel`); staff need a listed move, while the shopper's cancel
 * and an ended window need only the role rules and go to the first listed cancelled status, else the first one;
 * Payments' confirmation moves to the first listed open status, or leaves the order paid where it is; the shopper
 * cancels only in the roles `checkout.shopperCancel` lists (an open order only while nothing was paid, a waiting one
 * also with a paid advance, which is then due to refund); only staff moves record a payment on confirmation
 * (`paidOnConfirm`) and check the dispatch video, the shipment, typed serial numbers and the refund permission; staff
 * history entries carry `byKind` and their `order.moved` event the note.
 * @module
 */
import { createId } from '@ss/contracts';
import { factsGuard, factsOf } from './facts.js';
import { canMove, rolesAllow, statusOf } from './flow.js';
import { expiryFor, loyaltyRules, pointsToEarn } from './loyalty.js';
import { ID_PREFIX } from './model.js';
import { CASH_METHODS, earnedLeft, pointsOwner, refundSplit, refundable, stateAfterRefund } from './orders.js';

/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {import('./model.js').OrderFlow} OrderFlow */
/** @typedef {import('./model.js').StatusRole} StatusRole */
/** @typedef {import('./facts.js').OrderFacts} OrderFacts */
/** @typedef {import('./orders.js').HistoryNote} HistoryNote */
/** @typedef {import('./orders.js').NoteValues} NoteValues */
/** @typedef {{ kind: string, id: string, name: string, role?: string }} Actor */
/** Whose loyalty account: a member's user id, or `{ userId }` / `{ customerId }` (E20, E21). @typedef {string | { userId?: string | null, customerId?: string | null }} PointsOwner */

/**
 * The rules today's settings imply (phase 1: read from the settings, behavior unchanged).
 * @typedef {object} TransitionRules
 * @property {boolean} restock a parcel that comes back goes back in stock (`checkout.returnRestock` not `no`)
 * @property {number} rewaitMinutes an order moved back to waiting for payment waits this long (0 = until staff move it;
 *   `checkout.rewaitWindow: none` or no `paymentWindowMinutes`)
 * @property {boolean} refundOnCancel a cancel refunds what Payments took (staff: yes; a shopper's cancel and an ended
 *   window: no, the money shows as due to refund)
 * @property {boolean} paidOnDelivery cash taken at the door counts as paid when delivered (`cod.paidOnDelivery`)
 * @property {Record<string, any> | null} loyalty the `loyalty` settings while Loyalty is on
 * @property {string} timeZone the business time zone (points' expiry)
 */

/**
 * What the caller worked out before the plan (reads and calls that may refuse the move first).
 * @typedef {object} TransitionInput
 * @property {'staff' | 'shopper' | 'system'} who
 * @property {Actor} actor who it is for the payment and refund entries
 * @property {string} by the history's `by` (a staff member's name, `shopper`, `guest`, `system`)
 * @property {string} [byKind] the history's `byKind` (staff moves)
 * @property {string} note
 * @property {HistoryNote} [code] a note the server writes itself
 * @property {NoteValues} [values]
 * @property {'rto' | 'customer_return'} [reason] why a parcel came back (staff)
 * @property {'staff' | 'shopper' | 'expired'} [cancelReason] why a checkout cancel happened (kept as the reason)
 * @property {boolean} [listed] false: no listed move is needed (an ended window, a shopper's cancel), only the role rules
 * @property {boolean} [checkUpdatedAt] false: the order's `updatedAt` is not part of the compare-and-set
 * @property {Record<string, unknown>} [where] more the order must match (Payments' confirmation: still pending)
 * @property {NonNullable<OrderRecord['shipment']>} [shipment] the shipment of a move into `shipped`
 * @property {NonNullable<OrderRecord['media']>[number]} [video] the dispatch video of a move into `packed`
 * @property {{ plan: UnitsPlan, mode: 'registered' | 'typed' }} [units] the serial numbers a move into `packed` captures
 * @property {{ set: Record<string, unknown>, entry: Record<string, unknown> }} [paid] a payment the move records
 *   (paid when staff confirm, OR-7; Payments' confirmation)
 * @property {Record<string, unknown>} [payments] what cancelling the open Payments payment writes (K-13)
 */

/** @typedef {Array<{ lineId: string, productId: string, variantId: string, serials: string[], before: string[] }>} UnitsPlan */

/**
 * A write of the ledger, in the transaction.
 * @typedef {{ kind: 'release_stock', lines: StockLine[] }
 *   | { kind: 'release_slots' }
 *   | { kind: 'release_offers', couponId: string | null, dealIds: string[], bundleIds: string[] }
 *   | { kind: 'give_points', owner: PointsOwner, points: number, reason: 'earn' | 'refund',
 *       expiresAt: Date | null, note: string }
 *   | { kind: 'take_points', owner: PointsOwner, points: number, note: string }
 *   | { kind: 'restock_return', lines: Array<StockLine & { lineId: string }> }
 *   | { kind: 'count_sold', lines: Array<{ productId: string, quantity: number }> }
 *   | { kind: 'count_rto', customerId: string }
 *   | { kind: 'release_units' }
 *   | { kind: 'capture_units', plan: UnitsPlan, mode: 'registered' | 'typed' }} LedgerEffect
 */
/** @typedef {{ productId: string, variantId: string, quantity: number, locationId: string | null }} StockLine */

/**
 * Work outside the database, kept on the order (`effects`) until done: a refund through Payments, with its id as the
 * Idempotency-Key.
 * @typedef {{ id: string, kind: 'refund', amount: number, state: 'pending' | 'done' | 'failed' | 'skipped',
 *   reason: string, note: string, by: Actor, at: Date, tries: number, triedAt: Date | null, runningAt?: Date | null,
 *   doneAt?: Date | null, refundId?: string | null, detail?: string }} OrderEffect
 */

/**
 * @typedef {object} TransitionPlan
 * @property {string} from
 * @property {string} to the status entered ('' for a release without a status)
 * @property {StatusRole} fromStage
 * @property {StatusRole} stage
 * @property {{ before: OrderFacts, after: OrderFacts }} facts
 * @property {Record<string, unknown>} guard what the order must still match (with `websiteId` and `id`)
 * @property {Record<string, unknown>} set
 * @property {Record<string, unknown>} push
 * @property {Record<string, number>} inc
 * @property {LedgerEffect[]} ledger
 * @property {OrderEffect[]} external
 * @property {Record<string, unknown> | null} history the history entry
 * @property {Record<string, unknown> | null} recorded the payment the transition records (events)
 * @property {number} refunded money the transition itself records as refunded by hand (a move into `refunded`)
 * @property {{ from: string, to: string, by: string, note?: string, reason?: string } | null} event `order.moved`
 */

/**
 * @typedef {{ ok: true, plan: TransitionPlan }
 *   | { ok: false, code: 'move_not_allowed' | 'flow_changed' | 'nothing_paid', message: string }}
 *   PlanResult
 */

/** Roles of an order before delivery (a refund then acts as a cancel). */
const BEFORE_DELIVERY = Object.freeze(
	/** @type {StatusRole[]} */ (['awaiting_payment', 'awaiting_confirmation', 'open', 'packed', 'shipped']),
);
/** Roles a refund counts as "after delivery" from (the order had its parcel). */
const AFTER_DELIVERY = Object.freeze(/** @type {StatusRole[]} */ (['delivered', 'returned_to_origin', 'returned']));
/** Payment states after which cash is no longer taken at delivery. */
const REFUNDED_STATES = Object.freeze(['refunded', 'partially_refunded']);

/**
 * The physical lines of an order as stock lines.
 * @param {OrderRecord} order
 */
const stockLines = (order) =>
	order.lines
		.filter((line) => line.kind === 'physical')
		.map((line) => ({
			productId: line.productId,
			variantId: line.variantId,
			quantity: line.quantity,
			locationId: line.locationId ?? null,
		}));

/** @param {OrderRecord} order */
const hasUnits = (order) => order.lines.some((line) => (line.serials ?? []).length > 0);

/**
 * Whether a transition may happen, before anything is called or read for it: the flow's moves and the role rules,
 * the order's role still the flow's role of its status, and a refund before delivery only when something was paid.
 * @param {{ order: OrderRecord, flow: OrderFlow, to: string, listed?: boolean }} request
 * @returns {{ ok: true, target: import('./model.js').OrderStatusDefinition } | Extract<PlanResult, { ok: false }>}
 */
export const checkTransition = ({ order, flow, to, listed = true }) => {
	const target = statusOf(flow, to);
	const label = (/** @type {string} */ key) => statusOf(flow, key)?.label ?? key;
	const refused = /** @type {const} */ ({
		ok: false,
		code: 'move_not_allowed',
		message: `An order cannot move from ${label(order.status)} to ${target ? target.label : to}.`,
	});
	if (!target || order.status === to) return refused;
	if (listed ? !canMove(flow, order.status, to) : !rolesAllow(order.role, target.role)) return refused;
	const current = statusOf(flow, order.status);
	if (current && current.role !== order.role)
		return {
			ok: false,
			code: 'flow_changed',
			message: `The order flow changed: ${current.label} is no longer the kind of step this order is in. Reload it, or move its orders with restatus first.`,
		};
	if (!rolesAllow(order.role, target.role)) return refused;
	return { ok: true, target };
};

/**
 * A refund before delivery acts as a cancel, and only when something was paid (E27).
 * @param {OrderRecord} order @param {StatusRole} stage the stage entered
 * @returns {Extract<PlanResult, { ok: false }> | null}
 */
export const nothingPaid = (order, stage) =>
	stage === 'refunded' && BEFORE_DELIVERY.includes(order.role) && order.payment.paid <= 0
		? { ok: false, code: 'nothing_paid', message: 'Nothing was paid on this order; cancel it instead.' }
		: null;

/**
 * A refund entry of the order's log (E26).
 * @param {Actor} by @param {number} now
 * @param {{ method: 'online' | 'bank_transfer' | 'cash' | 'other', amount: number, reference?: string,
 *   refundId?: string | null, claimId?: string | null, note?: string, manual?: boolean }} refund
 */
export const refundEntry = (
	by,
	now,
	{ method, amount, reference = '', refundId = null, claimId = null, note = '', manual = false },
) => ({
	id: createId(ID_PREFIX.orderRefund),
	method,
	amount,
	reference,
	claimId,
	note,
	by,
	at: new Date(now),
	refundId,
	...(manual ? { manual: true } : {}),
});

/**
 * The refund entry of money given back through Payments: `online`, or — when Payments only recorded the refund and the
 * shop returns the money by hand (a bank transfer, a gateway without a refund API, K-22) — the way it goes back
 * (`bank_transfer` for a transfer, else `other`), marked `manual`, with Payments' refund id (OR-8).
 * @param {Actor} by @param {number} now @param {{ refundId: string, manual: boolean, gateway: string }} done
 * @param {{ amount: number, reference?: string, claimId?: string | null, note?: string }} refund
 */
export const paymentsRefundEntry = (by, now, done, refund) =>
	refundEntry(by, now, {
		...refund,
		method: done.manual ? (done.gateway === 'bank_transfer' ? 'bank_transfer' : 'other') : 'online',
		refundId: done.refundId || null,
		manual: done.manual,
	});

/**
 * Plan a transition of an order to the status `to`.
 * @param {{ order: OrderRecord, flow: OrderFlow, to: string, input: TransitionInput, rules: TransitionRules,
 *   now: number }} request
 * @returns {PlanResult}
 */
export const planTransition = ({ order, flow, to, input, rules, now }) => {
	const checked = checkTransition({ order, flow, to, listed: input.listed !== false });
	if (!checked.ok) return checked;
	const stage = checked.target.role;
	const unpaid = nothingPaid(order, stage);
	if (unpaid) return unpaid;
	const fromStage = order.role;
	const before = factsOf(order);
	const after = { ...before };
	/** @type {Record<string, unknown>} */
	const set = { status: to, role: stage, holdUntil: null };
	/** @type {Record<string, number>} */
	const inc = {};
	/** @type {LedgerEffect[]} */
	const ledger = [];
	/** @type {OrderEffect[]} */
	const external = [];
	/** @type {Record<string, unknown> | null} */
	let recorded = null;
	let refunded = 0;
	/** @type {Record<string, unknown>[]} */
	const payments = [];
	/** @type {Record<string, unknown>[]} */
	const refunds = [];
	/** @type {Record<string, unknown>} */
	const media = {};
	/**
	 * A refund through Payments after the transaction (kept on the order until done).
	 * @param {string} id its Idempotency-Key @param {number} amount @param {string} reason Payments is given
	 * @param {string} note of the refund entry it records
	 * @returns {OrderEffect}
	 */
	const refundEffect = (id, amount, reason, note) => ({
		id,
		kind: 'refund',
		amount,
		state: 'pending',
		reason,
		note,
		by: input.actor,
		at: new Date(now),
		tries: 0,
		triedAt: null,
	});

	// why: a parcel that came back is a return to origin (counted) or a customer's return (not counted, E27); a checkout
	// cancel keeps who or what cancelled it
	const reason =
		stage === 'returned_to_origin'
			? (input.reason ?? 'rto')
			: stage === 'returned'
				? 'customer_return'
				: input.who === 'staff'
					? undefined
					: input.cancelReason;

	// a payment the move records (paid when staff confirm, OR-7; Payments' confirmation)
	if (input.paid) {
		Object.assign(set, input.paid.set);
		payments.push(input.paid.entry);
		recorded = input.paid.entry;
	}

	/** Serial numbers captured go back (back to open or waiting from packed, E27). */
	const unpack = () => {
		if (fromStage !== 'packed' || !hasUnits(order)) return;
		set.lines = order.lines.map((line) => ({ ...line, serials: [] }));
		ledger.push({ kind: 'release_units' });
		after.units = 'none';
	};

	/** Everything the order holds goes back, each once (a cancel, a refund before delivery). */
	const release = () => {
		Object.assign(set, input.payments ?? {});
		set.stockHeld = false;
		set['promotions.released'] = true;
		if (hasUnits(order) || before.units === 'captured') ledger.push({ kind: 'release_units' });
		after.units = 'none';
		if (before.stock === 'held' || before.stock === 'sold') {
			ledger.push({ kind: 'release_stock', lines: stockLines(order) }, { kind: 'release_slots' });
			after.stock = 'back';
		}
		if (before.offers === 'counted') {
			const { couponId, dealIds, bundleIds } = order.promotions;
			ledger.push({ kind: 'release_offers', couponId, dealIds, bundleIds });
			after.offers = 'released';
		}
		if (before.redeemed === 'spent') {
			if (order.promotions.pointsRedeemed > 0)
				ledger.push({
					kind: 'give_points',
					owner: order.customer.userId,
					points: order.promotions.pointsRedeemed,
					reason: 'refund',
					expiresAt: null,
					note: order.number,
				});
			after.redeemed = 'given_back';
		}
	};

	/**
	 * A parcel back: its stock back as `rules.restock` says (less what claims put back), else kept out; serial numbers back.
	 * @param {boolean} countRto
	 */
	const comeBack = (countRto) => {
		set.stockHeld = false;
		ledger.push({ kind: 'release_units' });
		after.units = 'none';
		if (before.stock === 'held' || before.stock === 'sold') {
			if (rules.restock) {
				set.returnRestocked = true;
				ledger.push({
					kind: 'restock_return',
					lines: order.lines
						.filter((line) => line.kind === 'physical')
						.map((line) => ({
							lineId: line.id,
							productId: line.productId,
							variantId: line.variantId,
							quantity: line.quantity,
							locationId: line.locationId ?? null,
						})),
				});
				after.stock = 'back';
			} else after.stock = 'none';
		}
		if (countRto && order.customer.customerId) ledger.push({ kind: 'count_rto', customerId: order.customer.customerId });
	};

	/** Points of a return or a refund after delivery: what it earned and still has is reversed, what it redeemed given back. */
	const pointsBack = () => {
		const owner = pointsOwner(order);
		if (!owner) return;
		const earned = before.earned === 'credited' ? earnedLeft(order) : 0;
		const redeemed = before.redeemed === 'spent' ? order.promotions.pointsRedeemed : 0;
		if (earned <= 0 && redeemed <= 0) return;
		if (earned > 0) ledger.push({ kind: 'take_points', owner, points: earned, note: order.number });
		if (redeemed > 0)
			ledger.push({ kind: 'give_points', owner, points: redeemed, reason: 'refund', expiresAt: null, note: order.number });
		set['promotions.released'] = true;
		inc['promotions.pointsReversed'] = earned;
		after.redeemed = 'given_back';
		if (before.earned === 'credited') after.earned = 'reversed';
	};

	switch (stage) {
		case 'awaiting_payment': {
			// the order waits for its payment again: its window restarts (E27), or it waits until staff move it (OR-5)
			set.holdUntil = rules.rewaitMinutes > 0 ? new Date(now + rules.rewaitMinutes * 60_000) : null;
			unpack();
			break;
		}
		case 'open':
			unpack();
			break;
		case 'packed': {
			if (input.video) media.media = input.video;
			const plan = input.units?.plan ?? [];
			if (plan.length > 0) {
				const byLine = new Map(plan.map((line) => [line.lineId, line.serials]));
				const lines = order.lines.map((line) =>
					byLine.has(line.id) ? { ...line, serials: byLine.get(line.id) ?? [] } : line,
				);
				set.lines = lines;
				ledger.push({ kind: 'capture_units', plan, mode: input.units?.mode ?? 'registered' });
				after.units = lines.some((line) => (line.serials ?? []).length > 0) ? 'captured' : 'none';
			}
			break;
		}
		case 'shipped':
			if (input.shipment) set.shipment = input.shipment;
			break;
		case 'delivered': {
			set.deliveredAt = new Date(now);
			// cash taken at the door counts as paid on delivery, unless staff record it (E23 `paidOnDelivery: false`)
			if (
				CASH_METHODS.includes(order.payment.method) &&
				rules.paidOnDelivery &&
				!REFUNDED_STATES.includes(order.payment.state) &&
				order.totals.total > order.payment.paid
			) {
				const cash = {
					id: createId(ID_PREFIX.orderPayment),
					method: 'cash',
					amount: order.totals.total - order.payment.paid,
					reference: '',
					proofKey: null,
					note: 'Paid on delivery',
					by: input.actor,
					at: new Date(now),
				};
				set['payment.state'] = 'paid';
				set['payment.paid'] = order.totals.total;
				payments.splice(0, payments.length, cash);
				recorded = cash;
			}
			// points go to the member, or to the guest's customer record when guests earn (E20); fixed at placement (0 for a
			// member whose role the loyalty settings leave out) or worked out now, and credited once
			const owner = pointsOwner(order);
			if (rules.loyalty && owner && before.earned === 'none') {
				const earns = order.customer.userId ? true : loyaltyRules(rules.loyalty).guests === 'earn';
				const points = !earns
					? 0
					: order.promotions.pointsFixed
						? order.promotions.pointsEarned
						: Math.max(0, Math.floor(pointsToEarn(order.totals, rules.loyalty)));
				if (points > 0) {
					set['promotions.pointsEarned'] = points;
					set['promotions.pointsCredited'] = true;
					ledger.push({
						kind: 'give_points',
						owner,
						points,
						reason: 'earn',
						expiresAt: expiryFor(now, rules.loyalty, rules.timeZone),
						note: order.number,
					});
					after.earned = 'credited';
				}
			}
			if (BEFORE_DELIVERY.includes(fromStage))
				ledger.push({
					kind: 'count_sold',
					lines: order.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
				});
			if (before.stock === 'held') after.stock = 'sold';
			break;
		}
		case 'cancelled': {
			release();
			// what Payments took is refunded after the transaction, once (its id is the Idempotency-Key)
			const { online } = refundSplit(order, refundable(order));
			if (rules.refundOnCancel && online > 0)
				external.push(refundEffect(`${order.id}:cancel`, online, input.note || 'Order cancelled', 'Order cancelled'));
			break;
		}
		case 'returned_to_origin':
			comeBack(reason !== 'customer_return');
			break;
		case 'returned':
			comeBack(false);
			pointsBack();
			break;
		case 'refunded': {
			// what is left is refunded: the part Payments took through Payments right after the transaction (its id, the
			// Idempotency-Key, names the refunds before it), the rest recorded as given back by hand
			const note = input.note || 'Order refunded';
			const { online, manual } = refundSplit(order, refundable(order));
			if (manual > 0) {
				refunded = manual;
				set['payment.refunded'] = order.payment.refunded + manual;
				set['payment.state'] = stateAfterRefund(order.payment.paid, order.payment.refunded + manual);
				refunds.push(refundEntry(input.actor, now, { method: 'other', amount: manual, note }));
			}
			if (online > 0) external.push(refundEffect(`${order.id}:refund:${order.payment.refunded}`, online, note, note));
			// before delivery a refund acts as a cancel (E27); after delivery its points come back (K-23)
			if (AFTER_DELIVERY.includes(fromStage)) pointsBack();
			else release();
			break;
		}
		default:
			break;
	}
	set.facts = after;

	const history = {
		at: new Date(now),
		from: order.status,
		to,
		by: input.by,
		...(input.byKind ? { byKind: input.byKind } : {}),
		note: input.note,
		...(input.code ? { code: input.code } : {}),
		...(input.values ? { values: input.values } : {}),
		...(reason ? { reason } : {}),
	};
	/** @type {Record<string, unknown>} */
	const push = { history };
	if (payments.length > 0) push.payments = payments[0];
	if (refunds.length > 0) push.refunds = { $each: refunds };
	if (media.media) push.media = media.media;
	if (external.length > 0) push.effects = { $each: external };
	return {
		ok: true,
		plan: {
			from: order.status,
			to,
			fromStage,
			stage,
			facts: { before, after },
			guard: {
				status: order.status,
				...(input.checkUpdatedAt === false ? {} : { updatedAt: order.updatedAt }),
				...(input.where ?? {}),
				...factsGuard(order),
			},
			set,
			push,
			inc,
			ledger,
			external,
			history,
			recorded,
			refunded,
			event: {
				from: order.status,
				to,
				by: input.by,
				...(input.who === 'staff' ? { note: input.note } : {}),
				...(reason ? { reason } : {}),
			},
		},
	};
};

/**
 * Plan serial numbers staff type for a packed, shipped or delivered order (typed serials, E11), without a status
 * change: they are captured in the transaction that writes the order's lines, its facts (units) and a history entry,
 * guarded like a transition.
 * @param {{ order: OrderRecord, units: { plan: UnitsPlan, mode: 'registered' | 'typed' },
 *   history: Record<string, unknown> }} request
 * @returns {TransitionPlan}
 */
export const planUnits = ({ order, units, history }) => {
	const before = factsOf(order);
	const byLine = new Map(units.plan.map((line) => [line.lineId, line.serials]));
	const lines = order.lines.map((line) => (byLine.has(line.id) ? { ...line, serials: byLine.get(line.id) ?? [] } : line));
	/** @type {OrderFacts} */
	const after = { ...before, units: lines.some((line) => (line.serials ?? []).length > 0) ? 'captured' : 'none' };
	return {
		from: order.status,
		to: order.status,
		fromStage: order.role,
		stage: order.role,
		facts: { before, after },
		guard: { status: order.status, updatedAt: order.updatedAt, ...factsGuard(order) },
		set: { lines, facts: after },
		push: { history },
		inc: {},
		ledger: [{ kind: 'capture_units', plan: units.plan, mode: units.mode }],
		external: [],
		history,
		recorded: null,
		refunded: 0,
		event: null,
	};
};

/**
 * Plan what an order holds going back without a status (a delete, E31): its stock and slots, offer uses, redeemed
 * points and serial numbers, as a cancel gives them, each once. Orders that hold nothing any more plan nothing.
 * @param {{ order: OrderRecord }} request
 * @returns {TransitionPlan | null} null when it holds nothing (delivered, returned and settled orders keep what was sold)
 */
export const planRelease = ({ order }) => {
	if (!BEFORE_DELIVERY.includes(order.role)) return null;
	const before = factsOf(order);
	const after = { ...before, units: /** @type {OrderFacts['units']} */ ('none') };
	/** @type {LedgerEffect[]} */
	const ledger = [{ kind: 'release_units' }];
	if (before.stock === 'held' || before.stock === 'sold') {
		ledger.push({ kind: 'release_stock', lines: stockLines(order) }, { kind: 'release_slots' });
		after.stock = 'back';
	}
	if (before.offers === 'counted') {
		const { couponId, dealIds, bundleIds } = order.promotions;
		ledger.push({ kind: 'release_offers', couponId, dealIds, bundleIds });
		after.offers = 'released';
	}
	if (before.redeemed === 'spent') {
		if (order.promotions.pointsRedeemed > 0)
			ledger.push({
				kind: 'give_points',
				owner: order.customer.userId,
				points: order.promotions.pointsRedeemed,
				reason: 'refund',
				expiresAt: null,
				note: order.number,
			});
		after.redeemed = 'given_back';
	}
	return {
		from: order.status,
		to: '',
		fromStage: order.role,
		stage: order.role,
		facts: { before, after },
		guard: { status: order.status, updatedAt: order.updatedAt, ...factsGuard(order) },
		set: { stockHeld: false, 'promotions.released': true, facts: after },
		push: {},
		inc: {},
		ledger,
		external: [],
		history: null,
		recorded: null,
		refunded: 0,
		event: null,
	};
};
