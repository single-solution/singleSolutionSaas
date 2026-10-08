/**
 * The order flow (PLAN 0.8.8: merchant-defined statuses and allowed moves, defaulting to the ibrahimMobiles flow:
 * placed → confirmed → packed with serials → dispatched → delivered, with cancel and return-to-origin rules). The
 * merchant names the statuses, adds their own and chooses the moves; each status has a role (`core/model.js`
 * `STATUS_ROLES`) and the role rules below hold whatever the flow, so stock, offer uses, points and money stay right:
 *
 * - exactly one `awaiting_payment` and one `awaiting_confirmation` status: orders start there and nothing moves into
 *   them;
 * - `cancelled` and `refunded` are final; `cancelled` only before shipping (from waiting, open or packed statuses);
 * - a `shipped` parcel is delivered, comes back (`returned_to_origin`) or moves to another `shipped` status;
 * - `delivered` may only become `refunded`; `returned_to_origin` only `refunded`, and only from `shipped`.
 *
 * Pure functions, no I/O.
 * @module
 */
import { STATUS_ROLES } from './model.js';

/** @typedef {import('./model.js').OrderFlow} OrderFlow */
/** @typedef {import('./model.js').StatusRole} StatusRole */

/** At most this many statuses in a flow. */
export const MAX_STATUSES = 30;
/** A status key. */
const KEY = /^[a-z][a-z0-9_]{1,39}$/;

/** The default flow (ibrahimMobiles). @type {OrderFlow} */
export const DEFAULT_FLOW = {
	statuses: [
		{ key: 'pending_payment', label: 'Awaiting payment', role: /** @type {StatusRole} */ ('awaiting_payment') },
		{ key: 'awaiting_confirmation', label: 'Awaiting confirmation', role: /** @type {StatusRole} */ ('awaiting_confirmation') },
		{ key: 'confirmed', label: 'Confirmed', role: /** @type {StatusRole} */ ('open') },
		{ key: 'packed', label: 'Packed', role: /** @type {StatusRole} */ ('packed') },
		{ key: 'dispatched', label: 'Dispatched', role: /** @type {StatusRole} */ ('shipped') },
		{ key: 'delivered', label: 'Delivered', role: /** @type {StatusRole} */ ('delivered') },
		{ key: 'cancelled', label: 'Cancelled', role: /** @type {StatusRole} */ ('cancelled') },
		{ key: 'returned', label: 'Returned to origin', role: /** @type {StatusRole} */ ('returned_to_origin') },
		{ key: 'refunded', label: 'Refunded', role: /** @type {StatusRole} */ ('refunded') },
	],
	moves: [
		{ from: 'pending_payment', to: 'confirmed' },
		{ from: 'pending_payment', to: 'cancelled' },
		{ from: 'awaiting_confirmation', to: 'confirmed' },
		{ from: 'awaiting_confirmation', to: 'cancelled' },
		{ from: 'confirmed', to: 'packed' },
		{ from: 'confirmed', to: 'delivered' },
		{ from: 'confirmed', to: 'cancelled' },
		{ from: 'packed', to: 'dispatched' },
		{ from: 'packed', to: 'delivered' },
		{ from: 'packed', to: 'cancelled' },
		{ from: 'dispatched', to: 'delivered' },
		{ from: 'dispatched', to: 'returned' },
		{ from: 'delivered', to: 'refunded' },
		{ from: 'returned', to: 'refunded' },
	],
};

/** Roles that may move into each role (the role rules). @type {Record<StatusRole, ReadonlyArray<StatusRole>>} */
const ALLOWED_FROM = /** @type {Record<StatusRole, ReadonlyArray<StatusRole>>} */ ({
	awaiting_payment: [],
	awaiting_confirmation: [],
	open: ['awaiting_payment', 'awaiting_confirmation', 'open', 'packed'],
	packed: ['awaiting_payment', 'awaiting_confirmation', 'open', 'packed'],
	shipped: ['open', 'packed', 'shipped'],
	delivered: ['awaiting_payment', 'awaiting_confirmation', 'open', 'packed', 'shipped'],
	cancelled: ['awaiting_payment', 'awaiting_confirmation', 'open', 'packed'],
	returned_to_origin: ['shipped'],
	refunded: ['delivered', 'returned_to_origin'],
});
Object.freeze(ALLOWED_FROM);

/** Roles whose orders still wait (counted by the open-order cap; cancelled when their window ends). */
export const WAITING_ROLES = Object.freeze(/** @type {StatusRole[]} */ (['awaiting_payment', 'awaiting_confirmation']));
/** Roles in which an order is finished and never moves again. */
export const FINAL_ROLES = Object.freeze(/** @type {StatusRole[]} */ (['cancelled', 'refunded']));

/**
 * Check a flow the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: OrderFlow } | { ok: false, errors: string[] }}
 */
export const checkOrderFlow = (value) => {
	/** @type {string[]} */
	const errors = [];
	const input = typeof value === 'object' && value !== null ? /** @type {Record<string, unknown>} */ (value) : {};
	const statuses = Array.isArray(input.statuses) ? input.statuses : null;
	const moves = Array.isArray(input.moves) ? input.moves : null;
	if (!statuses || !moves) return { ok: false, errors: ['The flow needs statuses and moves.'] };
	if (statuses.length > MAX_STATUSES) errors.push(`At most ${MAX_STATUSES} statuses.`);
	/** @type {Map<string, StatusRole>} */
	const roles = new Map();
	/** @type {OrderFlow['statuses']} */
	const cleanStatuses = [];
	for (const raw of statuses) {
		const status = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		const key = typeof status.key === 'string' ? status.key : '';
		const label = typeof status.label === 'string' ? status.label.trim() : '';
		const role = /** @type {StatusRole} */ (status.role);
		if (!KEY.test(key)) {
			errors.push(`Status key '${key}' must be 2–40 lowercase letters, digits or _ starting with a letter.`);
			continue;
		}
		if (roles.has(key)) errors.push(`Status '${key}' is listed twice.`);
		if (!label || label.length > 60) errors.push(`Status '${key}' needs a name of at most 60 characters.`);
		if (!STATUS_ROLES.includes(role)) errors.push(`Status '${key}' has an unknown role.`);
		roles.set(key, role);
		cleanStatuses.push({ key, label, role });
	}
	for (const role of /** @type {StatusRole[]} */ (['awaiting_payment', 'awaiting_confirmation']))
		if ([...roles.values()].filter((r) => r === role).length !== 1) errors.push(`Exactly one status has the role ${role}.`);
	for (const role of /** @type {StatusRole[]} */ (['open', 'delivered', 'cancelled']))
		if (![...roles.values()].includes(role)) errors.push(`At least one status has the role ${role}.`);
	/** @type {OrderFlow['moves']} */
	const cleanMoves = [];
	const seen = new Set();
	for (const raw of moves) {
		const move = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		const from = typeof move.from === 'string' ? move.from : '';
		const to = typeof move.to === 'string' ? move.to : '';
		const fromRole = roles.get(from);
		const toRole = roles.get(to);
		if (!fromRole || !toRole) {
			errors.push(`The move ${from} → ${to} names an unknown status.`);
			continue;
		}
		if (from === to || !(ALLOWED_FROM[toRole] ?? []).includes(fromRole))
			errors.push(`The move ${from} → ${to} is not allowed (${fromRole} cannot become ${toRole}).`);
		if (seen.has(`${from}|${to}`)) continue;
		seen.add(`${from}|${to}`);
		cleanMoves.push({ from, to });
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { statuses: cleanStatuses, moves: cleanMoves } };
};

/**
 * The status definition of a key, or null.
 * @param {OrderFlow} flow @param {string} key
 */
export const statusOf = (flow, key) => flow.statuses.find((status) => status.key === key) ?? null;

/**
 * The first status with a role.
 * @param {OrderFlow} flow @param {StatusRole} role
 * @returns {string} its key ('' when none, which a checked flow never allows for the required roles)
 */
export const statusWithRole = (flow, role) => flow.statuses.find((status) => status.role === role)?.key ?? '';

/**
 * Whether the flow allows moving an order from one status to another (the role rules are checked again, so an order
 * whose status was renamed or removed meanwhile cannot slip through).
 * @param {OrderFlow} flow @param {string} from @param {string} to
 */
export const canMove = (flow, from, to) => {
	const fromRole = statusOf(flow, from)?.role;
	const toRole = statusOf(flow, to)?.role;
	if (!fromRole || !toRole || from === to) return false;
	return (ALLOWED_FROM[toRole] ?? []).includes(fromRole) && flow.moves.some((move) => move.from === from && move.to === to);
};

/**
 * The statuses an order may move to next.
 * @param {OrderFlow} flow @param {string} from
 */
export const nextStatuses = (flow, from) => flow.statuses.filter((status) => canMove(flow, from, status.key));

/**
 * Where a waiting order goes once it is paid or confirmed: the first allowed move into an `open` status.
 * @param {OrderFlow} flow @param {string} from
 * @returns {string | null}
 */
export const confirmedStatus = (flow, from) => nextStatuses(flow, from).find((status) => status.role === 'open')?.key ?? null;

/**
 * Where a waiting order goes when its window ends: the first allowed move into a `cancelled` status.
 * @param {OrderFlow} flow @param {string} from
 * @returns {string | null}
 */
export const cancelledStatus = (flow, from) =>
	nextStatuses(flow, from).find((status) => status.role === 'cancelled')?.key ?? statusWithRole(flow, 'cancelled');
