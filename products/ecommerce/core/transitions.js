/**
 * The order engine's plan (PLAN 0.8.10 "Ecommerce dynamic model", design §3.3; phase 1 the engine, phase 2 the options
 * of the flow's moves): one function for every way an order changes its status — staff and bulk moves, the shopper's
 * cancel, the end of a waiting window, Payments' confirmation, a recorded payment that confirms, refunds that cover the
 * payments — and one for a delete, which gives back what the order holds without a status. `server/transitions.js`
 * runs a plan in one database transaction.
 *
 * A plan is what the transition writes on the order (`set`, `push`, `inc`), guarded by the order as read (its status,
 * `updatedAt` and facts: compare-and-set), the **ledger** effects written in the same transaction (stock, slots, offer
 * uses, points, units sold, the RTO count, serial numbers) and the **external** effects that run after it (a refund
 * through Payments, kept on the order as `effects` until done). The effects are the difference between the order's
 * facts (`core/facts.js`) and those of the stage (role) it enters, with the choices of the move where the stage leaves
 * one (`core/flow.js` `moveOptionSpecs`; {@link choicesOf}), never a status label, so a repeated or concurrent move
 * changes nothing twice:
 *
 * - into `awaiting_payment` or `open` from `packed`: serial numbers captured go back (units → none); back to waiting,
 *   the time to pay starts again (the move's `window`: `restart`, or `none`);
 * - into `packed`, `shipped` or `delivered`: the serial numbers of the move's plan are captured (units → captured;
 *   the item types say which lines need them by which stage); any move keeps the attachments staff add with it;
 * - into `shipped`: the shipment;
 * - into `delivered`: stock held → sold, units counted sold, an order paid on delivery or at pickup paid (the move's
 *   `paidOnDelivery`), earned
 *   points credited once (`loyalty`, none → credited);
 * - into `canceled`, or `refunded` before delivery (a cancel): stock and slots back, offer uses released, redeemed
 *   points given back, serial numbers back, each only while the facts say it was not; what Payments took is refunded
 *   after the transaction when the move says so (staff: `refund: auto`; the shopper: `shopperPaid: refund`; an ended
 *   window never);
 * - into `canceled` or `refunded` after delivery or from a closed status (E40): items still with the customer (stock
 *   sold) go back in stock only when the move says so (`restock`; default no), offer uses are released by a cancel,
 *   redeemed points come back and earned points are taken back unless the move keeps them (`points: keep`, E39);
 * - into `returned_to_origin` or `returned`: stock back or kept out (the move's `restock`), serial numbers back, an RTO
 *   counted (not a customer's return); a customer's return gives redeemed points back and takes earned ones back
 *   unless the move keeps them;
 * - into `refunded`: what is left is refunded — the part Payments took through Payments after the transaction (an
 *   external effect, as a staff cancel's), the rest recorded as given back by hand; before dispatch it acts as a cancel,
 *   and an order with nothing paid is canceled with no money unless the move refuses it (`unpaid`, default `cancel`).
 *   A dispatched package is never canceled or refunded as a cancel: it comes back (`returned_to_origin`) first.
 *
 * Refusals: `move_not_allowed` (the flow's moves, who may make them and the role rules; an ended window needs no listed
 * move, and nothing else does: only a waiting order becomes canceled without one), `flow_changed` (the order's role is not the flow's role of its status any
 * more), `nothing_paid` (a refund before delivery when nothing was paid) and `input_needed` (a move that asks staff
 * whether the items go back in stock, without the answer). What the caller sends (the shipment, the serial numbers,
 * the attachments) it checks before. Pure functions, no I/O (ids are random).
 * @module
 */
import { createId } from '@ss/contracts';
import { factsGuard, factsOf } from './facts.js';
import {
	BEFORE_DELIVERY_ROLES as BEFORE_DELIVERY,
	WAITING_ROLES,
	moveOf,
	moveOptionSpecs,
	rolesAllow,
	statusOf,
} from './flow.js';
import { expiryFor, loyaltyRules, pointsToEarn } from './loyalty.js';
import { piecesOf } from './measure.js';
import { ID_PREFIX } from './model.js';
import { earnedLeft, pointsOwner, refundSplit, refundable, stateAfterRefund } from './orders.js';
import { OTHER_WAY, PAY_LATER_KINDS, VIA_PAYMENTS, isMethodKey } from './payment-methods.js';

/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {import('./model.js').FlowInput} FlowInput */
/** @typedef {import('./model.js').StatusRole} StatusRole */
/** @typedef {import('./facts.js').OrderFacts} OrderFacts */
/** @typedef {import('./orders.js').HistoryNote} HistoryNote */
/** @typedef {import('./orders.js').NoteValues} NoteValues */
/** @typedef {{ kind: string, id: string, name: string, role?: string }} Actor */
/** Whose loyalty account: a member's user id, or `{ userId }` / `{ customerId }` (E20, E21). @typedef {string | { userId?: string | null, customerId?: string | null }} PointsOwner */

/**
 * What the website's settings say for every transition.
 * @typedef {object} TransitionRules
 * @property {number} paymentWindowMinutes the time to pay (`checkout.paymentWindowMinutes`; 0 = until staff move it): an
 *   order moved back to waiting for payment gets it again when its move restarts the window
 * @property {Record<string, any> | null} loyalty the `loyalty` settings while Loyalty is on
 * @property {string} timeZone the business time zone (points' expiry)
 */

/**
 * What a transition chose where the stage contract leaves a choice ({@link choicesOf}).
 * @typedef {{ restock: boolean, points: 'take_back' | 'keep', refund: boolean, window: 'restart' | 'none',
 *   unpaid: 'refuse' | 'cancel', paidOnDelivery: boolean }} TransitionChoices
 */

/**
 * What the caller worked out before the plan (reads and calls that may refuse the move first).
 * @typedef {object} TransitionInput
 * @property {'staff' | 'shopper' | 'system'} who staff, the shopper (a cancel) or the shop itself (Payments'
 *   confirmation, an ended window, refunds that cover the payments)
 * @property {Actor} actor who it is for the payment and refund entries
 * @property {string} by the history's `by` (a staff member's name, `shopper`, `guest`, `system`)
 * @property {string} [byKind] the history's `byKind` (staff moves)
 * @property {string} note the staff note (staff read it; the shopper never does)
 * @property {string} [shopperNote] a note for the shopper: shown in the shopper's timeline and in their message
 * @property {boolean} [restock] staff's answer when the move asks whether the items go back in stock (`restock: ask`)
 * @property {HistoryNote} [code] a note the server writes itself
 * @property {NoteValues} [values]
 * @property {string} [reason] why staff cancel or a package came back: a key of the `cancel_reasons` or
 *   `delivery_failure_reasons` list (E19; `core/order-reasons.js`)
 * @property {boolean} [countsAgainst] the reason adds one to the customer's returned-packages counter (none given: a
 *   package that came back counts, unless the customer sent it back)
 * @property {'staff' | 'shopper' | 'expired'} [cancelReason] why a checkout cancel happened (kept as the reason)
 * @property {boolean} [listed] false: no listed move is needed (an ended window), only the role rules
 * @property {boolean} [trigger] the shop moves it by itself for staff (refunds that cover the payments): any listed
 *   move, and a move that asks whether the items go back in stock takes no
 * @property {boolean} [checkUpdatedAt] false: the order's `updatedAt` is not part of the compare-and-set
 * @property {Record<string, unknown>} [where] more the order must match (Payments' confirmation: still pending)
 * @property {NonNullable<OrderRecord['shipment']>} [shipment] the shipment of a move into `shipped`
 * @property {NonNullable<OrderRecord['attachments']>} [attachments] attachments staff add with the move (E20)
 * @property {{ plan: UnitsPlan }} [units] the serial numbers a move into `packed`, `shipped` or `delivered` captures
 * @property {{ set: Record<string, unknown>, entry: Record<string, unknown> }} [paid] a payment the move records
 *   (paid when staff confirm, OR-7; Payments' confirmation)
 * @property {Record<string, unknown>} [payments] what canceling the open Payments payment writes with the transition
 *   (K-13: a cancel, or a waiting order staff move on, which lets it go)
 */

/**
 * The units a capture gives each line: their serials, the ones it had, how its item type numbers them (picked from
 * `stock`, or typed at `packing` or later) and (typed units) each unit's values and keys in the serials' order.
 * @typedef {Array<{ lineId: string, productId: string, variantId: string, serials: string[], before: string[],
 *   capture: import('./item-types.js').UnitCapture, units?: import('./fields.js').UnitRecordValues[] }>} UnitsPlan
 */

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
 *   | { kind: 'capture_units', plan: UnitsPlan }} LedgerEffect
 */
/** @typedef {{ productId: string, variantId: string, quantity: number, locationId: string | null }} StockLine */

/**
 * Work outside the database, kept on the order (`effects`) until done: a refund through Payments, with its id as the
 * Idempotency-Key. A staff refund (the refund lock, phase 2) carries what it records with Payments' refund: `record`,
 * the part given back by hand (`manual`, its `entries`), the reference and claim of its entry and its history entry
 * (`note` when Payments refunded it, `recordedNote` when the refund was only recorded).
 * @typedef {{ id: string, kind: 'refund', amount: number, state: 'pending' | 'done' | 'failed' | 'skipped',
 *   reason: string, note: string, by: Actor, at: Date, tries: number, triedAt: Date | null, runningAt?: Date | null,
 *   doneAt?: Date | null, refundId?: string | null, detail?: string, record?: StaffRefundRecord }} OrderEffect
 */

/**
 * What a staff refund records with its refund through Payments (see {@link OrderEffect}); a claim's (`claim`) also
 * what the claim gets back when that refund does not happen.
 * @typedef {{ manual: number, entries: Record<string, unknown>[], reference: string, claimId: string | null,
 *   history: Record<string, unknown>, note: Record<string, unknown>, recordedNote: Record<string, unknown>,
 *   claim?: ClaimRefundUndo }} StaffRefundRecord
 */

/**
 * A claim's refund as the claim reserved it: `refundAmount` what the claim says it refunded with it, `status` the
 * refunded status it put the claim in, and `before` the claim's refund, status and role before it (`refundMethod` and
 * `refundReference` null when it had none).
 * @typedef {{ id: string, refundAmount: number, status: string, before: { status: string, role: string, refundAmount: number,
 *   refundId: string | null, refundMethod: string | null, refundReference: string | null } }} ClaimRefundUndo
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
 *   | { ok: false, code: 'move_not_allowed' | 'flow_changed' | 'nothing_paid' | 'input_needed', message: string,
 *       field?: string }} PlanResult
 */

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
 * Whether a transition may happen, before anything is called or read for it: the flow's moves, who may make them and
 * the role rules, and the order's role still the flow's role of its status. `move` is the listed move with every field
 * (null for a transition that needs none: an ended window).
 * @param {{ order: OrderRecord, flow: FlowInput, to: string, listed?: boolean,
 *   who?: 'staff' | 'shopper' | 'system' }} request
 * @returns {{ ok: true, target: import('./model.js').OrderStatusDefinition, move: ReturnType<typeof import('./flow.js').moveRules> | null }
 *   | Extract<PlanResult, { ok: false }>}
 */
export const checkTransition = ({ order, flow, to, listed = true, who = 'staff' }) => {
	const target = statusOf(flow, to);
	const label = (/** @type {string} */ key) => statusOf(flow, key)?.label ?? key;
	const refused = /** @type {const} */ ({
		ok: false,
		code: 'move_not_allowed',
		message: `An order cannot move from ${label(order.status)} to ${target ? target.label : to}.`,
	});
	if (!target || order.status === to) return refused;
	const move = listed ? moveOf(flow, order.status, to, who) : null;
	// a transition without a listed move is only a waiting order's cancel (an ended window)
	if (listed ? !move : !WAITING_ROLES.includes(order.role) || target.role !== 'canceled') return refused;
	const current = statusOf(flow, order.status);
	if (current && current.role !== order.role)
		return {
			ok: false,
			code: 'flow_changed',
			message: `The order flow changed: ${current.label} is no longer the kind of step this order is in. Reload it, or move its orders with restatus first.`,
		};
	if (!rolesAllow(order.role, target.role)) return refused;
	return { ok: true, target, move };
};

/**
 * What a transition chooses where its stage leaves a choice: the move's options (`core/flow.js` `moveOptionSpecs`; a
 * transition without a listed move takes their defaults), staff's answer where the move asks (`restock: ask`; the shop
 * itself answers no, so nothing goes back in stock unasked) and who makes it: a cancel refunds what Payments took when
 * staff make it and the move says `refund: auto`, when the shopper makes it and the move says `shopperPaid: refund`,
 * never when the shop itself does (an ended window).
 * @param {{ move: ReturnType<typeof import('./flow.js').moveRules> | null, from: StatusRole, to: StatusRole,
 *   input: Pick<TransitionInput, 'who' | 'restock' | 'trigger'> }} request
 * @returns {{ ok: true, choices: TransitionChoices } | Extract<PlanResult, { ok: false }>}
 */
export const choicesOf = ({ move, from, to, input }) => {
	/** @type {Record<string, unknown>} */
	const options = {
		...Object.fromEntries(Object.entries(moveOptionSpecs(from, to, move?.who)).map(([name, spec]) => [name, spec.default])),
	};
	Object.assign(options, move?.options ?? {});
	let restock = options.restock === 'yes';
	if (options.restock === 'ask' && input.who === 'staff' && !input.trigger) {
		if (typeof input.restock !== 'boolean')
			return {
				ok: false,
				code: 'input_needed',
				field: 'restock',
				message: 'Say whether the items go back in stock (restock true or false).',
			};
		restock = input.restock;
	}
	const refund =
		input.who === 'staff' ? options.refund === 'auto' : input.who === 'shopper' ? options.shopperPaid === 'refund' : false;
	return {
		ok: true,
		choices: {
			restock,
			points: options.points === 'keep' ? 'keep' : 'take_back',
			refund,
			window: options.window === 'none' ? 'none' : 'restart',
			unpaid: options.unpaid === 'cancel' ? 'cancel' : 'refuse',
			paidOnDelivery: options.paidOnDelivery !== 'no',
		},
	};
};

/**
 * A refund before delivery acts as a cancel (E27); with nothing paid it is refused when the move says `unpaid: refuse`
 * (by default it cancels the order with no money).
 * @param {OrderRecord} order @param {StatusRole} stage the stage entered @param {'refuse' | 'cancel'} [unpaid]
 * @returns {Extract<PlanResult, { ok: false }> | null}
 */
export const nothingPaid = (order, stage, unpaid = 'refuse') =>
	stage === 'refunded' && BEFORE_DELIVERY.includes(order.role) && order.payment.paid <= 0 && unpaid === 'refuse'
		? { ok: false, code: 'nothing_paid', message: 'Nothing was paid on this order; cancel it instead.' }
		: null;

/**
 * An id for a refund through Payments a transition asks for (its Idempotency-Key): `base`, or `base:<n>` when the order
 * has an effect of that id already (a second cancel or refund of the same order, E40), so two refunds never share a key.
 * @param {OrderRecord} order @param {string} base
 */
const effectId = (order, base) => {
	const taken = new Set((order.effects ?? []).map((effect) => effect.id));
	if (!taken.has(base)) return base;
	for (let n = 2; ; n += 1) if (!taken.has(`${base}:${n}`)) return `${base}:${n}`;
};

/**
 * A refund entry of the order's log (E26).
 * @param {Actor} by @param {number} now
 * @param {{ method: string, amount: number, reference?: string,
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
 * The refund entry of money given back through Payments: `payments`, or — when Payments only recorded the refund and
 * the shop returns the money by hand (a manual method such as a bank transfer, a gateway without a refund API, K-22) —
 * the way it goes back (the manual method's key, the same in the shop's list; else `other`), marked `manual`, with
 * Payments' refund id (OR-8).
 * @param {Actor} by @param {number} now @param {{ refundId: string, manual: boolean, gateway: string }} done
 * @param {{ amount: number, reference?: string, claimId?: string | null, note?: string }} refund
 */
export const paymentsRefundEntry = (by, now, done, refund) =>
	refundEntry(by, now, {
		...refund,
		method: done.manual ? (isMethodKey(done.gateway) ? done.gateway : OTHER_WAY) : VIA_PAYMENTS,
		refundId: done.refundId || null,
		manual: done.manual,
	});

/**
 * The part of a compare-and-set that keeps earned points right: a plan that takes them back (it counts them in
 * `promotions.pointsReversed`) happens only while what the order took back is as read, so a claim's refund taking them
 * back at the same time (it counts them there too) takes them once.
 * @param {OrderRecord} order as read @param {Record<string, number>} inc
 * @returns {Record<string, unknown>}
 */
const reversedGuard = (order, inc) =>
	inc['promotions.pointsReversed'] === undefined ? {} : { 'promotions.pointsReversed': order.promotions.pointsReversed ?? null };

/**
 * The points an order redeemed, given back to whose they were: the member's, or the guest's customer record (E20, K-6);
 * null when it redeemed none or has no owner.
 * @param {OrderRecord} order
 * @returns {LedgerEffect | null}
 */
const redeemedBack = (order) => {
	const owner = pointsOwner(order);
	if (!owner || order.promotions.pointsRedeemed <= 0) return null;
	return {
		kind: 'give_points',
		owner,
		points: order.promotions.pointsRedeemed,
		reason: 'refund',
		expiresAt: null,
		note: order.number,
	};
};

/**
 * Plan a transition of an order to the status `to`.
 * @param {{ order: OrderRecord, flow: FlowInput, to: string, input: TransitionInput, rules: TransitionRules,
 *   now: number }} request
 * @returns {PlanResult}
 */
export const planTransition = ({ order, flow, to, input, rules, now }) => {
	const checked = checkTransition({
		order,
		flow,
		to,
		listed: input.listed !== false,
		who: input.trigger ? 'system' : input.who,
	});
	if (!checked.ok) return checked;
	const stage = checked.target.role;
	const fromStage = order.role;
	const chosen = choicesOf({ move: checked.move, from: fromStage, to: stage, input });
	if (!chosen.ok) return chosen;
	const { choices } = chosen;
	const unpaid = nothingPaid(order, stage, choices.unpaid);
	if (unpaid) return unpaid;
	const before = factsOf(order);
	const after = { ...before };
	/** @type {Record<string, unknown>} */
	const set = { status: to, role: stage, holdUntil: null, ...(input.payments ?? {}) };
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
	/**
	 * A refund through Payments after the transaction (kept on the order until done).
	 * @param {string} id its Idempotency-Key @param {number} amount
	 * @param {string} reason Payments is given (a gateway may show it to the payer: the note for the shopper or plain
	 *   words, never the note staff typed) @param {string} note of the refund entry it records (staff read it)
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

	// why (E19): a package that came back or a staff cancel keeps the merchant's reason (a package without one: rto); a
	// customer's return is customer_return; a checkout cancel keeps who or what canceled it
	const reason =
		stage === 'returned_to_origin'
			? (input.reason ?? 'rto')
			: stage === 'returned'
				? 'customer_return'
				: input.who === 'staff'
					? stage === 'canceled'
						? input.reason
						: undefined
					: input.cancelReason;
	/** Whether the move adds one to the customer's returned-packages counter. */
	const countsAgainst = input.countsAgainst ?? (stage === 'returned_to_origin' && reason !== 'customer_return');
	// the reason a closing move gives is kept on the order, for its lists, counts and reports
	if ((stage === 'canceled' || stage === 'returned_to_origin') && reason) set.closeReason = reason;

	// a payment the move records (paid when staff confirm, OR-7; Payments' confirmation)
	if (input.paid) {
		Object.assign(set, input.paid.set);
		payments.push(input.paid.entry);
		recorded = input.paid.entry;
	}

	/**
	 * What is left to refund: the part through Payments less the refunds already asked of it and still pending (a
	 * cancel's refund Payments has not taken yet), and the part recorded by hand.
	 */
	const moneyLeft = () => {
		const pending = (order.effects ?? [])
			.filter((effect) => effect.state === 'pending')
			.reduce((sum, effect) => sum + effect.amount, 0);
		const { online, manual } = refundSplit(order, refundable(order));
		return { online: Math.max(0, online - pending), manual };
	};

	/** The serial numbers of the move's plan are captured (moves into packed, shipped or delivered). */
	const captureUnits = () => {
		const plan = input.units?.plan ?? [];
		if (plan.length === 0) return;
		const byLine = new Map(plan.map((line) => [line.lineId, line.serials]));
		const lines = order.lines.map((line) => (byLine.has(line.id) ? { ...line, serials: byLine.get(line.id) ?? [] } : line));
		set.lines = lines;
		ledger.push({ kind: 'capture_units', plan });
		after.units = lines.some((line) => (line.serials ?? []).length > 0) ? 'captured' : 'none';
	};

	/** Serial numbers captured go back (back to open or waiting from packed, E27). */
	const unpack = () => {
		if (fromStage !== 'packed' || !hasUnits(order)) return;
		set.lines = order.lines.map((line) => ({ ...line, serials: [] }));
		ledger.push({ kind: 'release_units' });
		after.units = 'none';
	};

	/** Offer uses back, once. */
	const releaseOffers = () => {
		if (before.offers !== 'counted') return;
		const { couponId, dealIds, bundleIds } = order.promotions;
		ledger.push({ kind: 'release_offers', couponId, dealIds, bundleIds });
		set['promotions.released'] = true;
		after.offers = 'released';
	};

	/** Everything the order holds goes back, each once (a cancel, a refund before delivery). */
	const release = () => {
		set.stockHeld = false;
		set['promotions.released'] = true;
		if (hasUnits(order) || before.units === 'captured') ledger.push({ kind: 'release_units' });
		after.units = 'none';
		if (before.stock === 'held' || before.stock === 'sold') {
			ledger.push({ kind: 'release_stock', lines: stockLines(order) }, { kind: 'release_slots' });
			after.stock = 'back';
		}
		releaseOffers();
		if (before.redeemed === 'spent') {
			const back = redeemedBack(order);
			if (back) ledger.push(back);
			after.redeemed = 'given_back';
		}
	};

	/** Units a return or a restock puts back in stock, less what claims put back (OR-10). */
	const restockLines = () =>
		order.lines
			.filter((line) => line.kind === 'physical')
			.map((line) => ({
				lineId: line.id,
				productId: line.productId,
				variantId: line.variantId,
				quantity: line.quantity,
				locationId: line.locationId ?? null,
			}));

	/**
	 * A package back: its stock back as the move says (less what claims put back), else kept out; serial numbers back.
	 * @param {boolean} countRto
	 */
	const comeBack = (countRto) => {
		set.stockHeld = false;
		ledger.push({ kind: 'release_units' });
		after.units = 'none';
		if (before.stock === 'held' || before.stock === 'sold') {
			if (choices.restock) {
				set.returnRestocked = true;
				ledger.push({ kind: 'restock_return', lines: restockLines() });
				after.stock = 'back';
			} else after.stock = 'none';
		}
		if (countRto && order.customer.customerId) ledger.push({ kind: 'count_rto', customerId: order.customer.customerId });
	};

	/**
	 * Points of a return, a refund after delivery or a cancel after it: what it earned and still has is reversed (unless
	 * the move keeps it, E39), what it redeemed given back.
	 */
	const pointsBack = () => {
		const owner = pointsOwner(order);
		if (!owner) return;
		const keep = choices.points === 'keep';
		const earned = !keep && before.earned === 'credited' ? earnedLeft(order) : 0;
		const redeemed = before.redeemed === 'spent' ? order.promotions.pointsRedeemed : 0;
		if (earned <= 0 && redeemed <= 0) return;
		if (earned > 0) ledger.push({ kind: 'take_points', owner, points: earned, note: order.number });
		if (redeemed > 0)
			ledger.push({ kind: 'give_points', owner, points: redeemed, reason: 'refund', expiresAt: null, note: order.number });
		set['promotions.released'] = true;
		inc['promotions.pointsReversed'] = earned;
		after.redeemed = 'given_back';
		if (!keep && before.earned === 'credited') after.earned = 'reversed';
	};

	/**
	 * A cancel or a refund after delivery or from a closed status (E40): items still with the customer go back in stock
	 * only when the move says so (their serial numbers with them), a cancel releases the offer uses, and the points come
	 * back as the move says.
	 * @param {{ cancel: boolean }} how
	 */
	const settleAfter = ({ cancel }) => {
		if (before.stock === 'sold' && choices.restock) {
			set.stockHeld = false;
			set.returnRestocked = true;
			ledger.push({ kind: 'release_units' }, { kind: 'restock_return', lines: restockLines() });
			after.stock = 'back';
			after.units = 'none';
		}
		if (cancel) releaseOffers();
		pointsBack();
	};

	switch (stage) {
		case 'awaiting_payment': {
			// the order waits for its payment again: its window restarts (E27), or it waits until staff move it (OR-5)
			set.holdUntil =
				choices.window === 'restart' && rules.paymentWindowMinutes > 0
					? new Date(now + rules.paymentWindowMinutes * 60_000)
					: null;
			unpack();
			break;
		}
		case 'open':
			unpack();
			break;
		case 'packed': {
			captureUnits();
			break;
		}
		case 'shipped':
			if (input.shipment) set.shipment = input.shipment;
			captureUnits();
			break;
		case 'delivered': {
			captureUnits();
			set.deliveredAt = new Date(now);
			// money taken at the door or the counter counts as paid on delivery, unless the move leaves it to staff
			// (`paidOnDelivery: no`, decision 11); the entry names the order's own method (E16)
			if (
				PAY_LATER_KINDS.includes(order.payment.kind) &&
				choices.paidOnDelivery &&
				!REFUNDED_STATES.includes(order.payment.state) &&
				order.totals.total > order.payment.paid
			) {
				const cash = {
					id: createId(ID_PREFIX.orderPayment),
					method: order.payment.method,
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
			if (BEFORE_DELIVERY.includes(fromStage)) {
				// counted in pieces: a measured line is one (`core/measure.js`)
				const lines = order.lines.map((line) => ({ productId: line.productId, quantity: piecesOf(line) }));
				ledger.push({ kind: 'count_sold', lines });
			}
			if (before.stock === 'held') after.stock = 'sold';
			break;
		}
		case 'canceled': {
			if (BEFORE_DELIVERY.includes(fromStage)) release();
			else settleAfter({ cancel: true });
			if (countsAgainst && order.customer.customerId)
				ledger.push({ kind: 'count_rto', customerId: order.customer.customerId });
			// what Payments took is refunded after the transaction, once (its id is the Idempotency-Key), when the move says so
			const { online } = moneyLeft();
			if (choices.refund && online > 0)
				external.push(
					refundEffect(
						effectId(order, `${order.id}:cancel`),
						online,
						input.shopperNote || 'Order canceled',
						input.note || 'Order canceled',
					),
				);
			break;
		}
		case 'returned_to_origin':
			comeBack(countsAgainst);
			break;
		case 'returned':
			comeBack(false);
			pointsBack();
			break;
		case 'refunded': {
			// what is left is refunded: the part Payments took through Payments right after the transaction (its id, the
			// Idempotency-Key, names the refunds before it), the rest recorded as given back by hand
			const note = input.note || 'Order refunded';
			const { online, manual } = moneyLeft();
			if (manual > 0) {
				refunded = manual;
				set['payment.refunded'] = order.payment.refunded + manual;
				set['payment.state'] = stateAfterRefund(order.payment.paid, order.payment.refunded + manual);
				refunds.push(refundEntry(input.actor, now, { method: 'other', amount: manual, note }));
			}
			if (online > 0)
				external.push(
					refundEffect(
						effectId(order, `${order.id}:refund:${order.payment.refunded}`),
						online,
						input.shopperNote || 'Order refunded',
						note,
					),
				);
			// before delivery a refund acts as a cancel (E27); after it the items and points as the move says (K-23, E39, E40)
			if (BEFORE_DELIVERY.includes(fromStage)) release();
			else settleAfter({ cancel: false });
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
		...(input.shopperNote ? { shopperNote: input.shopperNote } : {}),
		...(input.code ? { code: input.code } : {}),
		...(input.values ? { values: input.values } : {}),
		...(reason ? { reason } : {}),
	};
	/** @type {Record<string, unknown>} */
	const push = { history };
	if (payments.length > 0) push.payments = payments[0];
	if (refunds.length > 0) push.refunds = { $each: refunds };
	if (input.attachments && input.attachments.length > 0) push.attachments = { $each: input.attachments };
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
				...reversedGuard(order, inc),
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
				...(input.shopperNote ? { shopperNote: input.shopperNote } : {}),
				...(reason ? { reason } : {}),
			},
		},
	};
};

/**
 * Plan serial numbers staff type for a packed, shipped or delivered order (typed serials, E11), without a status
 * change: they are captured in the transaction that writes the order's lines, its facts (units) and a history entry,
 * guarded like a transition.
 * @param {{ order: OrderRecord, units: { plan: UnitsPlan }, history: Record<string, unknown> }} request
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
		ledger: [{ kind: 'capture_units', plan: units.plan }],
		external: [],
		history,
		recorded: null,
		refunded: 0,
		event: null,
	};
};

/**
 * Plan what an order holds going back without a status (a delete, E31): its stock and slots, offer uses, redeemed
 * points and serial numbers, as a cancel gives them, each once. A delivered or closed order keeps what was sold, unless
 * the website's deletes give everything back (`all`, `checkout.deleteGivesBack: all`): then items still with the
 * customer go back in stock, its offer uses are released and its points come back (earned taken back, redeemed given
 * back). Orders that hold nothing any more plan nothing.
 * @param {{ order: OrderRecord, all?: boolean }} request
 * @returns {TransitionPlan | null} null when there is nothing to give back
 */
export const planRelease = ({ order, all = false }) => {
	const before = factsOf(order);
	/** @type {OrderFacts} */
	const after = { ...before };
	/** @type {LedgerEffect[]} */
	const ledger = [];
	/** @type {Record<string, unknown>} */
	const set = {};
	/** @type {Record<string, number>} */
	const inc = {};
	/** Offer uses back, once. */
	const releaseOffers = () => {
		if (before.offers !== 'counted') return;
		const { couponId, dealIds, bundleIds } = order.promotions;
		ledger.push({ kind: 'release_offers', couponId, dealIds, bundleIds });
		set['promotions.released'] = true;
		after.offers = 'released';
	};
	if (BEFORE_DELIVERY.includes(order.role)) {
		ledger.push({ kind: 'release_units' });
		after.units = 'none';
		set.stockHeld = false;
		set['promotions.released'] = true;
		if (before.stock === 'held' || before.stock === 'sold') {
			ledger.push({ kind: 'release_stock', lines: stockLines(order) }, { kind: 'release_slots' });
			after.stock = 'back';
		}
		releaseOffers();
		if (before.redeemed === 'spent') {
			const back = redeemedBack(order);
			if (back) ledger.push(back);
			after.redeemed = 'given_back';
		}
	} else {
		if (!all) return null;
		if (before.stock === 'sold') {
			set.stockHeld = false;
			set.returnRestocked = true;
			ledger.push(
				{ kind: 'release_units' },
				{
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
				},
			);
			after.stock = 'back';
			after.units = 'none';
		}
		const owner = pointsOwner(order);
		const earned = owner && before.earned === 'credited' ? earnedLeft(order) : 0;
		const redeemed = owner && before.redeemed === 'spent' ? order.promotions.pointsRedeemed : 0;
		if (owner && earned > 0) ledger.push({ kind: 'take_points', owner, points: earned, note: order.number });
		if (owner && redeemed > 0)
			ledger.push({ kind: 'give_points', owner, points: redeemed, reason: 'refund', expiresAt: null, note: order.number });
		if (owner && (earned > 0 || redeemed > 0)) {
			set['promotions.released'] = true;
			inc['promotions.pointsReversed'] = earned;
			after.redeemed = 'given_back';
			if (before.earned === 'credited') after.earned = 'reversed';
		}
		releaseOffers();
	}
	if (ledger.length === 0) return null;
	set.facts = after;
	return {
		from: order.status,
		to: '',
		fromStage: order.role,
		stage: order.role,
		facts: { before, after },
		guard: { status: order.status, updatedAt: order.updatedAt, ...factsGuard(order), ...reversedGuard(order, inc) },
		set,
		push: {},
		inc,
		ledger,
		external: [],
		history: null,
		recorded: null,
		refunded: 0,
		event: null,
	};
};
