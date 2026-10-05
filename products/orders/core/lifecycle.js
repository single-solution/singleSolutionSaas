/**
 * The order lifecycle as data (pure): the merchant's status set and transition matrix from the `lifecycle` settings,
 * with the checks a move needs and the catalogued event it publishes. Ported from the store's lifecycle rules, with
 * the review's lessons built in: one definition of revenue statuses used everywhere (A11), a shipped order may only
 * be delivered or returned (A21 — the default matrix has no dispatched → cancelled door), the pay-on-delivery
 * confirmation step (A12) and auto-expiry per status.
 * @module
 */
import { isKey } from './text.js';

/** Who moves orders: dashboard staff, `sk_` integrations, customers (pk_ + verified identity), the product itself. */
export const ACTORS = Object.freeze(/** @type {const} */ (['staff', 'api', 'customer', 'system']));
/** Checks a transition may require. */
export const CHECKS = Object.freeze(
	/** @type {const} */ (['serials', 'tracking', 'dispatch_video', 'full_refund', 'paid_in_full', 'return_reason']),
);
/** Catalogued events a transition may publish (order.refunded@1 belongs to the ledger, one per refund). */
export const TRANSITION_EVENTS = Object.freeze(/** @type {const} */ (['order.completed', 'order.cancelled']));

const HOUR = 3_600_000;

/**
 * @typedef {object} StatusDef
 * @property {string} key
 * @property {string | null} label
 * @property {boolean} revenue
 * @property {boolean} open
 * @property {boolean} customerCancellable
 * @property {boolean} terminal
 * @property {number} expireAfterHours
 * @property {string} expireTo
 */

/**
 * @typedef {object} TransitionDef
 * @property {string} from
 * @property {string} to
 * @property {string[]} actors
 * @property {string[]} requires
 * @property {'none' | 'order.completed' | 'order.cancelled'} publish
 * @property {string[]} reasons
 */

/**
 * @typedef {object} Matrix
 * @property {StatusDef[]} statuses
 * @property {TransitionDef[]} transitions
 * @property {{ unpaid: string, paid: string, cod: string }} initial
 * @property {string[]} codMethods
 */

/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} value */
const keys = (value) => list(value).filter(isKey);

/**
 * Normalise the matrix from the `lifecycle` settings: unknown or duplicate statuses dropped, transitions between
 * known statuses only (the first of duplicates wins), no transition out of a terminal status.
 * @param {Record<string, any>} config effective `lifecycle` configuration
 * @returns {Matrix}
 */
export const createMatrix = (config) => {
	/** @type {StatusDef[]} */
	const statuses = [];
	for (const raw of list(config.statuses)) {
		if (!isKey(raw?.key) || statuses.some((status) => status.key === raw.key)) continue;
		statuses.push({
			key: raw.key,
			label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : null,
			revenue: raw.revenue === true,
			open: raw.open === true,
			customerCancellable: raw.customer_cancellable === true,
			terminal: raw.terminal === true,
			expireAfterHours:
				Number.isSafeInteger(raw.expire_after_hours) && raw.expire_after_hours > 0 ? raw.expire_after_hours : 0,
			expireTo: isKey(raw.expire_to) ? raw.expire_to : 'cancelled',
		});
	}
	const known = new Set(statuses.map((status) => status.key));
	const terminal = new Set(statuses.filter((status) => status.terminal).map((status) => status.key));
	/** @type {TransitionDef[]} */
	const transitions = [];
	for (const raw of list(config.transitions)) {
		if (!known.has(raw?.from) || !known.has(raw?.to) || raw.from === raw.to || terminal.has(raw.from)) continue;
		if (transitions.some((t) => t.from === raw.from && t.to === raw.to)) continue;
		transitions.push({
			from: raw.from,
			to: raw.to,
			actors: list(raw.actors).filter((actor) => /** @type {readonly string[]} */ (ACTORS).includes(actor)),
			requires: list(raw.requires).filter((check) => /** @type {readonly string[]} */ (CHECKS).includes(check)),
			publish: /** @type {readonly string[]} */ (TRANSITION_EVENTS).includes(raw.publish) ? raw.publish : 'none',
			reasons: keys(raw.reasons),
		});
	}
	const first = statuses[0]?.key ?? 'pending';
	/** @param {unknown} key */
	const pick = (key) => (typeof key === 'string' && known.has(key) ? key : first);
	return {
		statuses,
		transitions,
		initial: {
			unpaid: pick(config.initial_status),
			paid: pick(config.initial_status_paid),
			cod: pick(config.initial_status_cod),
		},
		codMethods: keys(config.cod_methods),
	};
};

/**
 * @param {Matrix} matrix
 * @param {string} key
 * @returns {StatusDef | null}
 */
export const statusOf = (matrix, key) => matrix.statuses.find((status) => status.key === key) ?? null;

/**
 * The one definition of "counts as a sale" (A11): every KPI, export, customer total and invoice uses it.
 * @param {Matrix} matrix
 * @param {string} key
 */
export const isRevenue = (matrix, key) => statusOf(matrix, key)?.revenue === true;

/** @param {Matrix} matrix */
export const revenueStatuses = (matrix) => matrix.statuses.filter((status) => status.revenue).map((status) => status.key);

/** @param {Matrix} matrix */
export const openStatuses = (matrix) => matrix.statuses.filter((status) => status.open).map((status) => status.key);

/**
 * @param {Matrix} matrix
 * @param {string} from
 * @param {string} to
 * @returns {TransitionDef | null}
 */
export const transitionOf = (matrix, from, to) => matrix.transitions.find((t) => t.from === from && t.to === to) ?? null;

/**
 * Moves out of a status an actor may make.
 * @param {Matrix} matrix
 * @param {string} from
 * @param {string} [actor]
 */
export const nextStatuses = (matrix, from, actor) =>
	matrix.transitions.filter((t) => t.from === from && (!actor || t.actors.includes(actor))).map((t) => t.to);

/**
 * Status of a new order: paid in full → the paid status; pay on delivery without an advance → the confirmation step;
 * anything else (unpaid, or a pay-on-delivery order whose advance is due) → the unpaid status.
 * @param {Matrix} matrix
 * @param {{ paidInFull: boolean, cod: boolean, advanceDue: number }} input
 */
export const initialStatus = (matrix, { paidInFull, cod, advanceDue }) => {
	if (paidInFull) return matrix.initial.paid;
	if (cod && advanceDue <= 0) return matrix.initial.cod;
	return matrix.initial.unpaid;
};

/**
 * When an order entering `status` at `at` expires (null = never), and where it then goes. The move must exist in
 * the matrix for the `system` actor, otherwise the status never expires.
 * @param {Matrix} matrix
 * @param {string} status
 * @param {number} at epoch ms
 * @returns {{ at: Date, to: string } | null}
 */
export const expiryOf = (matrix, status, at) => {
	const def = statusOf(matrix, status);
	if (!def || def.expireAfterHours <= 0) return null;
	const move = transitionOf(matrix, status, def.expireTo);
	if (!move || !move.actors.includes('system')) return null;
	return { at: new Date(at + def.expireAfterHours * HOUR), to: def.expireTo };
};

/**
 * @typedef {object} MoveContext what the checks look at
 * @property {string[]} [missingSerials] titles of lines still missing serials
 * @property {boolean} [hasTracking]
 * @property {boolean} [hasDispatchVideo]
 * @property {{ total: number, paid: number, refunded: number }} [money]
 * @property {string | null} [reason] return reason given with the move
 */

/**
 * @typedef {{ ok: true, transition: TransitionDef } | { ok: false, code: string, detail?: string }} MoveCheck
 */

/**
 * Whether `actor` may move an order from its status to `to`: the matrix door, the actor, then each required check.
 * Pure — the caller loads what the checks need and claims the move atomically.
 * @param {Matrix} matrix
 * @param {{ status: string }} order
 * @param {string} to
 * @param {string} actor
 * @param {MoveContext} [context]
 * @returns {MoveCheck}
 */
export const checkMove = (matrix, order, to, actor, context = {}) => {
	if (!statusOf(matrix, to)) return { ok: false, code: 'unknown_status' };
	if (order.status === to) return { ok: false, code: 'status_unchanged' };
	const transition = transitionOf(matrix, order.status, to);
	if (!transition) return { ok: false, code: 'transition_not_allowed', detail: `${order.status} → ${to}` };
	if (!transition.actors.includes(actor)) return { ok: false, code: 'actor_not_allowed', detail: actor };
	for (const check of transition.requires) {
		const failed = failedCheck(check, transition, context);
		if (failed) return failed;
	}
	return { ok: true, transition };
};

/**
 * @param {string} check
 * @param {TransitionDef} transition
 * @param {MoveContext} context
 * @returns {{ ok: false, code: string, detail?: string } | null}
 */
const failedCheck = (check, transition, context) => {
	const money = context.money ?? { total: 0, paid: 0, refunded: 0 };
	switch (check) {
		case 'serials':
			return (context.missingSerials ?? []).length > 0
				? { ok: false, code: 'serials_missing', detail: (context.missingSerials ?? []).join(', ') }
				: null;
		case 'tracking':
			return context.hasTracking ? null : { ok: false, code: 'tracking_missing' };
		case 'dispatch_video':
			return context.hasDispatchVideo ? null : { ok: false, code: 'dispatch_video_missing' };
		case 'full_refund':
			// refunded only once refunds cover everything received (a partial refund keeps the status)
			return money.refunded >= money.paid ? null : { ok: false, code: 'refund_incomplete' };
		case 'paid_in_full':
			return money.paid - money.refunded >= money.total ? null : { ok: false, code: 'balance_due' };
		default: {
			const reason = context.reason ?? null;
			if (!reason) return { ok: false, code: 'reason_required' };
			return transition.reasons.length === 0 || transition.reasons.includes(reason)
				? null
				: { ok: false, code: 'reason_not_allowed', detail: reason };
		}
	}
};

/**
 * The move a customer may make to cancel an order now (null = not cancellable): the status must be customer-cancellable,
 * the matrix must hold a customer move that publishes `order.cancelled` (or leads to a status named `cancelled`), and
 * the order must be within the cancellation window when one is set.
 * @param {Matrix} matrix
 * @param {Record<string, any>} order `{ status, placedAt }`
 * @param {{ now: number, windowMinutes: number }} options
 * @returns {TransitionDef | null}
 */
export const customerCancelMove = (matrix, order, { now, windowMinutes }) => {
	if (!statusOf(matrix, order.status)?.customerCancellable) return null;
	if (windowMinutes > 0 && now - new Date(order.placedAt).getTime() > windowMinutes * 60_000) return null;
	return (
		matrix.transitions.find(
			(t) =>
				t.from === order.status &&
				t.actors.includes('customer') &&
				(t.publish === 'order.cancelled' || t.to === 'cancelled') &&
				!t.requires.some((check) => check !== 'paid_in_full' && check !== 'full_refund'),
		) ?? null
	);
};

/**
 * The paid status an order may move to once payments cover what is due, if the matrix lets the system make that move.
 * @param {Matrix} matrix
 * @param {string} status
 */
export const confirmMoveOf = (matrix, status) => {
	const target = matrix.initial.paid;
	if (status === target) return null;
	const move = transitionOf(matrix, status, target);
	return move && move.actors.includes('system') ? move : null;
};

/**
 * Whether an order is paid by the customer on delivery (its payment flag or a pay-on-delivery method key).
 * @param {Matrix} matrix
 * @param {{ payment?: { method?: string | null, cod?: boolean } | null }} order
 */
export const isPayOnDelivery = (matrix, order) =>
	order.payment?.cod === true || (typeof order.payment?.method === 'string' && matrix.codMethods.includes(order.payment.method));
