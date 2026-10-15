/**
 * The order flow (PLAN 0.8.8: merchant-defined statuses and allowed moves, defaulting to this flow:
 * placed → confirmed → packed with serials → dispatched → delivered, with cancel and return-to-origin rules; PLAN
 * 0.8.10 "Ecommerce dynamic model" §3, phase 2: options per move, triggers and starts). The merchant names the
 * statuses, adds their own and chooses the moves; each status has a role, its kind of step (`core/model.js`
 * `STATUS_ROLES`), and the role rules below hold whatever the flow, so stock, offer uses, points and money stay right:
 *
 * - exactly one `awaiting_payment` status and at most one `awaiting_confirmation` status: orders start there (a flow
 *   without a confirmation step starts orders paid on delivery or at pickup and free orders in an open status, `starts`); an `open`
 *   or `packed` order may wait for its payment again (PLAN 0.8.10 E27), nothing else moves into them;
 * - `cancelled` from waiting, open or packed statuses; `refunded` from waiting, open or packed statuses (E27: it acts
 *   as a cancel; with nothing paid only when the move says `unpaid: cancel`, the default), and after delivery;
 * - a `shipped` package is delivered, comes back (`returned_to_origin`) or moves to another `shipped` status: once
 *   dispatched it is never canceled or refunded as a cancel — it comes back first (owner, 2026-10-14), while money
 *   paid can still be refunded without a status change (`POST /v1/orders/:id/refunds`);
 * - `delivered` may become `refunded` or `returned` (a customer return, E27); `returned_to_origin` and `returned` only
 *   `refunded`; `returned_to_origin` only from `shipped`;
 * - the extra moves of E40, only when the flow lists them: a cancel after delivery or of a closed order, a refund of a
 *   canceled order, and a move between two closed statuses (canceled ↔ refunded, a return → canceled). What each does follows the facts the order has (`core/transitions.js`),
 *   so nothing is given back or taken twice.
 *
 * A move says who may make it (`who`: staff; staff and the shopper — a cancel before dispatch —; or only the shop
 * itself, `system`), the permission a staff ticket needs (into a refunded status always `orders.refund`), what staff
 * give with it (`needs`: a staff note, a reason the shopper reads; the serial numbers a stage needs follow the item
 * types, `core/item-types.js`) and its options where the
 * stage contract leaves a choice ({@link moveOptionSpecs}). Each status has the name shoppers read, a line per payment
 * method, whether entering it sends the shopper a message and whether it alerts the staff (E36). `triggers` name the
 * statuses the shop moves orders to by itself and `starts` where orders that need no payment first start. Anything
 * missing takes its default ({@link checkOrderFlow} fills it).
 *
 * Pure functions, no I/O.
 * @module
 */
import { STATUS_ROLES } from './model.js';
import { isMethodKey } from './payment-methods.js';

/** @typedef {import('./model.js').OrderFlow} OrderFlow */
/** @typedef {import('./model.js').OrderMove} OrderMove */
/** @typedef {import('./model.js').MoveOptions} MoveOptions */
/** @typedef {import('./model.js').StatusRole} StatusRole */
/** @typedef {import('./model.js').OrderStatusDefinition} OrderStatusDefinition */
/** @typedef {import('./model.js').ShopperTexts} ShopperTexts */
/** @typedef {'staff' | 'shopper' | 'system'} Mover */

/** At most this many statuses in a flow. */
const MAX_STATUSES = 30;
/** A status key. */
const KEY = /^[a-z][a-z0-9_-]{1,39}$/;
/** The longest name of a status, staff's or the shopper's. */
const MAX_LABEL = 60;
/** The longest line a shopper reads under a status for one payment method. */
const MAX_SHOPPER_TEXT = 300;
/** A status has a shopper line for at most this many payment methods (the `payment_methods` list's most). */
const MAX_TEXT_METHODS = 20;
/** Who may make a move: one of these sets. */
const WHO_SETS = Object.freeze([['staff'], ['staff', 'shopper'], ['shopper'], ['system']]);
/** What staff give with a move (`reason`: the shopper note, which the shopper reads in the order's timeline). */
export const MOVE_NEEDS = Object.freeze(/** @type {Array<'note' | 'reason'>} */ (['note', 'reason']));
/** The permissions a move may need of a staff ticket. */
export const MOVE_PERMISSIONS = Object.freeze(
	/** @type {Array<'orders.manage' | 'orders.refund'>} */ (['orders.manage', 'orders.refund']),
);
/** The statuses whose entering sends the shopper a message unless the flow says otherwise (today's default list). */
const NOTIFIED_KEYS = Object.freeze(['confirmed', 'dispatched', 'delivered', 'cancelled', 'refunded']);

/** Roles whose orders still wait (counted by the open-order cap; canceled when their window ends). */
export const WAITING_ROLES = Object.freeze(/** @type {StatusRole[]} */ (['awaiting_payment', 'awaiting_confirmation']));
/** Roles of an order before delivery (a refund then acts as a cancel). */
export const BEFORE_DELIVERY_ROLES = Object.freeze(
	/** @type {StatusRole[]} */ (['awaiting_payment', 'awaiting_confirmation', 'open', 'packed', 'shipped']),
);
/** Roles before dispatch: the shopper may cancel only from these (when a move lets them). */
const BEFORE_DISPATCH_ROLES = Object.freeze(
	/** @type {StatusRole[]} */ (['awaiting_payment', 'awaiting_confirmation', 'open', 'packed']),
);
/** Roles of a closed order: nothing is left to pay on it and no payment is recorded on it any more. */
export const CLOSED_ROLES = Object.freeze(
	/** @type {StatusRole[]} */ (['cancelled', 'returned_to_origin', 'refunded', 'returned']),
);

/** Roles that may move into each role (the role rules). @type {Record<StatusRole, ReadonlyArray<StatusRole>>} */
const ALLOWED_FROM = /** @type {Record<StatusRole, ReadonlyArray<StatusRole>>} */ ({
	awaiting_payment: ['open', 'packed'],
	awaiting_confirmation: [],
	open: ['awaiting_payment', 'awaiting_confirmation', 'open', 'packed'],
	packed: ['awaiting_payment', 'awaiting_confirmation', 'open', 'packed'],
	shipped: ['open', 'packed', 'shipped'],
	delivered: ['awaiting_payment', 'awaiting_confirmation', 'open', 'packed', 'shipped'],
	// E40: a cancel after delivery and between closed statuses, when listed
	cancelled: [
		'awaiting_payment',
		'awaiting_confirmation',
		'open',
		'packed',
		'delivered',
		'cancelled',
		'returned_to_origin',
		'returned',
		'refunded',
	],
	returned_to_origin: ['shipped'],
	// E40: a refund of a canceled order, when listed (a shipped package comes back first)
	refunded: [
		'awaiting_payment',
		'awaiting_confirmation',
		'open',
		'packed',
		'delivered',
		'cancelled',
		'returned_to_origin',
		'returned',
		'refunded',
	],
	returned: ['delivered'],
});
Object.freeze(ALLOWED_FROM);

/**
 * @typedef {{ kind: 'one', values: ReadonlyArray<string>, default: string }
 *   | { kind: 'methods', default: ReadonlyArray<string> }} OptionSpec
 */

/**
 * The options a move takes (only where the stage contract leaves a choice, design §3.4) with their values and defaults:
 *
 * - out of waiting into an open, packed or shipped status: `paidOnConfirm`, the payment methods whose balance staff
 *   moving it record as paid (OR-7; default none);
 * - into awaiting payment again: `window`, the time to pay `restart`s (default) or there is `none` (OR-5);
 * - into packed: `video`, the dispatch video `off` (default), `optional` or `required` (E28);
 * - into delivered: `paidOnDelivery`, an order paid on delivery or at pickup counts as paid with it (`yes`, the
 *   default: the money was taken at the door or the counter) or staff record that money (`no`; decision 11);
 * - into shipped: `tracking`, the tracking number `required` (default) or `optional`;
 * - into cancelled: `refund`, what Payments took is refunded `auto`matically when staff cancel (default) or by `staff`
 *   from the order; with the shopper among `who`, `shopperPaid`: a paid order the shopper cancels is refused
 *   (`refuse`, the default out of open or packed), canceled with the refund left due (`flag`, the default out of
 *   waiting) or canceled and refunded (`refund`);
 * - into refunded before dispatch: `unpaid`, an order with nothing paid is canceled with no money (`cancel`, the
 *   default, owner 2026-10-14) or refused (`refuse`);
 * - into returned to origin or returned: `restock`, the package goes back in stock (`yes`, the default), stays out
 *   (`no`) or staff say so with each move (`ask`);
 * - into cancelled or refunded from delivered or a closed status (the items may still be with the customer): `restock`,
 *   default `no` (owner, 2026-10-14);
 * - into returned, and into cancelled or refunded from delivered or a closed status: `points`, earned points are taken
 *   back (`take_back`, the default) or kept (`keep`, E39); redeemed points always come back.
 * @param {StatusRole} from @param {StatusRole} to @param {ReadonlyArray<Mover>} [who]
 * @returns {Record<keyof MoveOptions, OptionSpec>}
 */
export const moveOptionSpecs = (from, to, who = ['staff']) => {
	/** @type {Partial<Record<keyof MoveOptions, OptionSpec>>} */
	const specs = {};
	/** @param {ReadonlyArray<string>} values @param {string} fallback @returns {OptionSpec} */
	const one = (values, fallback) => ({ kind: 'one', values, default: fallback });
	const afterDelivery = !BEFORE_DELIVERY_ROLES.includes(from);
	if (WAITING_ROLES.includes(from) && ['open', 'packed', 'shipped'].includes(to))
		specs.paidOnConfirm = { kind: 'methods', default: [] };
	if (to === 'awaiting_payment') specs.window = one(['restart', 'none'], 'restart');
	if (to === 'packed') specs.video = one(['off', 'optional', 'required'], 'off');
	if (to === 'delivered') specs.paidOnDelivery = one(['yes', 'no'], 'yes');
	if (to === 'shipped') specs.tracking = one(['required', 'optional'], 'required');
	if (to === 'cancelled') {
		specs.refund = one(['auto', 'staff'], 'auto');
		if (who.includes('shopper'))
			specs.shopperPaid = one(['refuse', 'flag', 'refund'], WAITING_ROLES.includes(from) ? 'flag' : 'refuse');
	}
	if (to === 'refunded' && !afterDelivery) specs.unpaid = one(['cancel', 'refuse'], 'cancel');
	if (to === 'returned_to_origin' || to === 'returned') specs.restock = one(['yes', 'no', 'ask'], 'yes');
	if ((to === 'cancelled' || to === 'refunded') && afterDelivery) specs.restock = one(['no', 'yes', 'ask'], 'no');
	if (to === 'returned' || ((to === 'cancelled' || to === 'refunded') && afterDelivery))
		specs.points = one(['take_back', 'keep'], 'take_back');
	return /** @type {Record<keyof MoveOptions, OptionSpec>} */ (specs);
};

/** Every option a move may take (each takes those of its stage). */
const OPTION_NAMES = Object.freeze([
	'paidOnConfirm',
	'window',
	'video',
	'tracking',
	'refund',
	'shopperPaid',
	'unpaid',
	'restock',
	'points',
	'paidOnDelivery',
]);

/**
 * Who may make a move by default: staff, and the shopper too out of a waiting status into a canceled one.
 * @param {StatusRole} from @param {StatusRole} to
 * @returns {Mover[]}
 */
const defaultWho = (from, to) => (WAITING_ROLES.includes(from) && to === 'cancelled' ? ['staff', 'shopper'] : ['staff']);

/**
 * A move with every field: as given, else its defaults (a move of a flow built in code, or saved before phase 2).
 * @param {OrderFlow} flow @param {OrderMove} move
 * @returns {Required<OrderMove> & { options: Required<MoveOptions> }} unknown statuses give an empty set of options
 */
export const moveRules = (flow, move) => {
	const from = statusOf(flow, move.from)?.role;
	const to = statusOf(flow, move.to)?.role;
	/** @type {Mover[]} */
	const who = Array.isArray(move.who) && move.who.length > 0 ? move.who : from && to ? defaultWho(from, to) : ['staff'];
	const specs = from && to ? moveOptionSpecs(from, to, who) : /** @type {Record<keyof MoveOptions, OptionSpec>} */ ({});
	/** @type {Record<string, unknown>} */
	const options = {};
	for (const [name, spec] of Object.entries(specs)) {
		const given = /** @type {Record<string, unknown>} */ (move.options ?? {})[name];
		options[name] = given === undefined ? spec.default : given;
	}
	return {
		from: move.from,
		to: move.to,
		who,
		permission: move.permission ?? (to === 'refunded' ? 'orders.refund' : 'orders.manage'),
		needs: Array.isArray(move.needs) ? move.needs : [],
		options: /** @type {Required<MoveOptions>} */ (options),
	};
};

/** The default flow, as written (its options, triggers and starts are filled by {@link checkOrderFlow}). */
const DEFAULT_DEFINITION = {
	statuses: [
		{ key: 'pending_payment', label: 'Awaiting payment', role: /** @type {StatusRole} */ ('awaiting_payment') },
		{ key: 'awaiting_confirmation', label: 'Awaiting confirmation', role: /** @type {StatusRole} */ ('awaiting_confirmation') },
		{ key: 'confirmed', label: 'Confirmed', role: /** @type {StatusRole} */ ('open') },
		{ key: 'packed', label: 'Packed', role: /** @type {StatusRole} */ ('packed') },
		{ key: 'dispatched', label: 'Dispatched', role: /** @type {StatusRole} */ ('shipped') },
		{ key: 'delivered', label: 'Delivered', role: /** @type {StatusRole} */ ('delivered') },
		{ key: 'cancelled', label: 'Canceled', role: /** @type {StatusRole} */ ('cancelled') },
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

/**
 * Check a flow the merchant saves, and fill what it leaves out with the defaults: a status's shopper name ('' =
 * its name), shopper lines ('' each) and message (the statuses `confirmed`, `dispatched`, `delivered`, `cancelled` and
 * `refunded` send one); a move's `who`, permission, needs and options
 * ({@link moveRules}); the triggers (Payments' confirmation: the first open status listed from the awaiting-payment
 * status; an ended window: the first canceled status listed from it, else the first; refunds covering the payments:
 * none) and the starts (the awaiting-confirmation status, else the first open one).
 * @param {unknown} value
 * @returns {{ ok: true, value: Required<OrderFlow> } | { ok: false, errors: string[] }}
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
	/** @type {Required<OrderStatusDefinition>[]} */
	const cleanStatuses = [];
	for (const raw of statuses) {
		const status = objectOf(raw);
		const key = typeof status.key === 'string' ? status.key : '';
		const label = typeof status.label === 'string' ? status.label.trim() : '';
		const role = /** @type {StatusRole} */ (status.role);
		if (!KEY.test(key)) {
			errors.push(`Status key '${key}' must be 2–40 lowercase letters, digits, _ or - starting with a letter.`);
			continue;
		}
		if (roles.has(key)) errors.push(`Status '${key}' is listed twice.`);
		if (!label || label.length > MAX_LABEL) errors.push(`Status '${key}' needs a name of at most ${MAX_LABEL} characters.`);
		if (!STATUS_ROLES.includes(role)) errors.push(`Status '${key}' has an unknown role.`);
		const shopperLabel = status.shopperLabel === undefined || status.shopperLabel === null ? '' : status.shopperLabel;
		if (typeof shopperLabel !== 'string' || shopperLabel.trim().length > MAX_LABEL)
			errors.push(`The shopper's name of status '${key}' has at most ${MAX_LABEL} characters.`);
		const texts = objectOf(status.shopperText);
		/** @type {Record<string, string>} */
		const shopperText = {};
		// a line per payment method key of the website's list ('' lines are left out)
		if (Object.keys(texts).length > MAX_TEXT_METHODS)
			errors.push(`Status '${key}' has shopper lines for at most ${MAX_TEXT_METHODS} payment methods.`);
		for (const [method, given] of Object.entries(texts)) {
			if (!isMethodKey(method)) {
				errors.push(`Status '${key}' has a shopper line for '${method}', which is not a payment method key.`);
				continue;
			}
			const text = given === undefined || given === null ? '' : given;
			if (typeof text !== 'string' || text.trim().length > MAX_SHOPPER_TEXT)
				errors.push(`The shopper's line of status '${key}' for ${method} has at most ${MAX_SHOPPER_TEXT} characters.`);
			else if (text.trim() !== '') shopperText[method] = text.trim();
		}
		if (status.notify !== undefined && typeof status.notify !== 'boolean')
			errors.push(`Whether status '${key}' sends a message is true or false.`);
		if (status.staffAlert !== undefined && typeof status.staffAlert !== 'boolean')
			errors.push(`Whether status '${key}' alerts the staff is true or false.`);
		roles.set(key, role);
		cleanStatuses.push({
			key,
			label,
			role,
			shopperLabel: typeof shopperLabel === 'string' ? shopperLabel.trim() : '',
			shopperText: /** @type {ShopperTexts} */ (shopperText),
			notify: typeof status.notify === 'boolean' ? status.notify : NOTIFIED_KEYS.includes(key),
			staffAlert: status.staffAlert === true,
		});
	}
	const counted = (/** @type {StatusRole} */ role) => [...roles.values()].filter((r) => r === role).length;
	if (counted('awaiting_payment') !== 1) errors.push('Exactly one status has the role awaiting_payment.');
	if (counted('awaiting_confirmation') > 1) errors.push('At most one status has the role awaiting_confirmation.');
	for (const role of /** @type {StatusRole[]} */ (['open', 'delivered', 'cancelled']))
		if (counted(role) === 0) errors.push(`At least one status has the role ${role}.`);
	const draft = /** @type {OrderFlow} */ ({ statuses: cleanStatuses, moves: [] });
	/** @type {Array<Required<OrderMove>>} */
	const cleanMoves = [];
	const seen = new Set();
	for (const raw of moves) {
		const move = objectOf(raw);
		const from = typeof move.from === 'string' ? move.from : '';
		const to = typeof move.to === 'string' ? move.to : '';
		const fromRole = roles.get(from);
		const toRole = roles.get(to);
		if (!fromRole || !toRole) {
			errors.push(`The move ${from} → ${to} names an unknown status.`);
			continue;
		}
		const name = `The move ${from} → ${to}`;
		if (from === to || !(ALLOWED_FROM[toRole] ?? []).includes(fromRole))
			errors.push(`${name} is not allowed (${fromRole} cannot become ${toRole}).`);
		if (seen.has(`${from}|${to}`)) continue;
		seen.add(`${from}|${to}`);
		const problems = moveProblems(name, move, fromRole, toRole);
		errors.push(...problems);
		if (problems.length === 0)
			cleanMoves.push(
				/** @type {Required<OrderMove>} */ (
					moveRules(draft, {
						from,
						to,
						...(move.who === undefined ? {} : { who: sortedWho(/** @type {Mover[]} */ (move.who)) }),
						...(move.permission === undefined ? {} : { permission: /** @type {any} */ (move.permission) }),
						...(move.needs === undefined
							? {}
							: { needs: MOVE_NEEDS.filter((need) => /** @type {unknown[]} */ (move.needs).includes(need)) }),
						...(move.options === undefined ? {} : { options: /** @type {MoveOptions} */ (move.options) }),
					})
				),
			);
	}
	if (errors.length > 0) return { ok: false, errors };
	/** @type {OrderFlow} */
	const checked = { statuses: cleanStatuses, moves: cleanMoves };
	const triggers = triggersOf(checked, objectOf(input.triggers), errors);
	const starts = startsOf(checked, objectOf(input.starts), errors);
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { statuses: cleanStatuses, moves: cleanMoves, triggers, starts } };
};

/** @param {unknown} value @returns {Record<string, unknown>} */
const objectOf = (value) =>
	typeof value === 'object' && value !== null && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};

/** @param {Mover[]} who */
const sortedWho = (who) =>
	/** @type {Mover[]} */ (['staff', 'shopper', 'system'].filter((entry) => who.includes(/** @type {Mover} */ (entry))));

/**
 * What is wrong with a move's who, permission, needs and options (its statuses and their roles are known).
 * @param {string} name @param {Record<string, unknown>} move @param {StatusRole} from @param {StatusRole} to
 * @returns {string[]}
 */
const moveProblems = (name, move, from, to) => {
	/** @type {string[]} */
	const problems = [];
	/** @type {Mover[]} */
	let who = defaultWho(from, to);
	if (move.who !== undefined) {
		const given = Array.isArray(move.who) ? move.who : [];
		const set = WHO_SETS.find(
			(entry) =>
				entry.length === new Set(given).size &&
				entry.every((mover) => given.includes(mover)) &&
				given.every((g) => entry.includes(g)),
		);
		if (!set) problems.push(`${name}: who is staff, shopper (with staff or alone) or system.`);
		else who = /** @type {Mover[]} */ (set);
	}
	if (who.includes('shopper') && (to !== 'cancelled' || !BEFORE_DISPATCH_ROLES.includes(from)))
		problems.push(`${name}: shoppers may only cancel, and only before dispatch.`);
	if (move.permission !== undefined) {
		if (!MOVE_PERMISSIONS.includes(/** @type {any} */ (move.permission)))
			problems.push(`${name}: the permission is ${MOVE_PERMISSIONS.join(' or ')}.`);
		else if (to === 'refunded' && move.permission !== 'orders.refund')
			problems.push(`${name}: a move into a refunded status needs orders.refund.`);
	}
	if (move.needs !== undefined) {
		const needs = Array.isArray(move.needs) ? move.needs : null;
		if (!needs || needs.some((need) => !MOVE_NEEDS.includes(need)) || new Set(needs).size !== needs.length)
			problems.push(`${name}: needs lists note or reason, each once.`);
	}
	if (move.options !== undefined) {
		const options = objectOf(move.options);
		if (move.options !== null && typeof move.options !== 'object') problems.push(`${name}: options is an object.`);
		const specs = moveOptionSpecs(from, to, who);
		for (const [option, given] of Object.entries(options)) {
			const spec = /** @type {Record<string, OptionSpec>} */ (specs)[option];
			// an option of another kind of move is left out (a status given another kind of step keeps its moves); an
			// unknown one is refused
			if (!spec) {
				if (!OPTION_NAMES.includes(option)) problems.push(`${name}: there is no option ${option}.`);
				continue;
			}
			if (spec.kind === 'methods') {
				if (!Array.isArray(given) || given.some((method) => !isMethodKey(method)) || new Set(given).size !== given.length)
					problems.push(`${name}: ${option} lists payment method keys, each once.`);
			} else if (!spec.values.includes(/** @type {string} */ (given)))
				problems.push(`${name}: ${option} is ${spec.values.join(', ')}.`);
		}
	}
	return problems;
};

/**
 * The flow's triggers, checked: `paid` an open status listed from the awaiting-payment status ('' = Payments'
 * confirmation leaves the order where it is, paid), `windowEnd` a canceled status, `refundsCover` a refunded status or
 * ''. Missing ones are today's choices.
 * @param {OrderFlow} flow checked @param {Record<string, unknown>} input @param {string[]} errors
 * @returns {import('./model.js').FlowTriggers}
 */
const triggersOf = (flow, input, errors) => {
	const waiting = statusWithRole(flow, 'awaiting_payment');
	const fallback = defaultTriggers(flow);
	/** @param {'paid' | 'windowEnd' | 'refundsCover'} name @param {StatusRole} role @param {boolean} empty */
	const pick = (name, role, empty) => {
		const given = input[name];
		if (given === undefined || given === null) return fallback[name];
		if (typeof given !== 'string' || (given === '' && !empty) || (given !== '' && statusOf(flow, given)?.role !== role)) {
			errors.push(`The ${name} trigger names a status with the role ${role}${empty ? ', or none' : ''}.`);
			return '';
		}
		return given;
	};
	const paid = pick('paid', 'open', true);
	if (paid && !flow.moves.some((move) => move.from === waiting && move.to === paid))
		errors.push(`The paid trigger needs the move ${waiting} → ${paid} in the flow.`);
	return { paid, windowEnd: pick('windowEnd', 'cancelled', false), refundsCover: pick('refundsCover', 'refunded', true) };
};

/**
 * Where orders that need no payment first start, checked: those paid on delivery and at pickup in the
 * awaiting-confirmation status or an open one, free orders also in the awaiting-payment status (they wait there for
 * staff, with no time to pay).
 * @param {OrderFlow} flow checked @param {Record<string, unknown>} input @param {string[]} errors
 * @returns {import('./model.js').FlowStarts}
 */
const startsOf = (flow, input, errors) => {
	const fallback = defaultStarts(flow);
	/** @param {keyof import('./model.js').FlowStarts} name @param {StatusRole[]} roles */
	const pick = (name, roles) => {
		const given = input[name];
		if (given === undefined || given === null) return fallback[name];
		const role = typeof given === 'string' ? statusOf(flow, given)?.role : undefined;
		if (!role || !roles.includes(role)) {
			errors.push(`The ${name} start names a status with the role ${roles.join(' or ')}.`);
			return fallback[name];
		}
		return /** @type {string} */ (given);
	};
	return {
		on_delivery: pick('on_delivery', ['awaiting_confirmation', 'open']),
		at_pickup: pick('at_pickup', ['awaiting_confirmation', 'open']),
		free: pick('free', ['awaiting_confirmation', 'open', 'awaiting_payment']),
	};
};

/**
 * Today's triggers of a flow (see {@link checkOrderFlow}).
 * @param {OrderFlow} flow
 * @returns {import('./model.js').FlowTriggers}
 */
const defaultTriggers = (flow) => {
	const waiting = statusWithRole(flow, 'awaiting_payment');
	return {
		paid: confirmedStatus(flow, waiting, 'system') ?? '',
		windowEnd: cancelledStatus(flow, waiting),
		refundsCover: '',
	};
};

/**
 * Today's starts of a flow: the awaiting-confirmation status, else the first open one.
 * @param {OrderFlow} flow
 * @returns {import('./model.js').FlowStarts}
 */
const defaultStarts = (flow) => {
	const start = statusWithRole(flow, 'awaiting_confirmation') || statusWithRole(flow, 'open');
	return { on_delivery: start, at_pickup: start, free: start };
};

/**
 * A flow with every field filled (see {@link checkOrderFlow}): a saved flow as it reads, or one built in code. A flow
 * that does not pass the check (never saved so) is returned as it is, with its triggers and starts filled.
 * @param {unknown} value
 * @returns {Required<OrderFlow>}
 */
export const readOrderFlow = (value) => {
	const checked = checkOrderFlow(value);
	if (checked.ok) return checked.value;
	const flow = /** @type {OrderFlow} */ (value);
	return {
		statuses: flow.statuses,
		moves: flow.moves,
		triggers: flow.triggers ?? defaultTriggers(flow),
		starts: flow.starts ?? defaultStarts(flow),
	};
};

/**
 * The triggers of a flow (filled when missing).
 * @param {OrderFlow} flow
 */
export const triggersOfFlow = (flow) => flow.triggers ?? defaultTriggers(flow);

/**
 * The starts of a flow (filled when missing).
 * @param {OrderFlow} flow
 */
export const startsOfFlow = (flow) => flow.starts ?? defaultStarts(flow);

/**
 * What saving a flow would do to orders already in a status (the flow-save guard, PLAN 0.8.10 dynamic model §3.3): a
 * status of the saved flow that has orders keeps its key and its kind of step (role) — removing or re-keying it, or
 * changing its role, is refused (its orders' facts follow their role); names and moves may change. The kind of step
 * its orders are in is always accepted: a status that comes back (orders left from before), or one whose role was
 * changed before this guard existed, takes its orders' role, which puts it right.
 * @param {OrderFlow} saved the flow saved now
 * @param {OrderFlow} next the flow to save (checked)
 * @param {ReadonlyArray<{ status: string, role: string, count: number }>} counts orders per status and role
 * @returns {Array<{ path: string, message: string, code: 'status_in_use' }>}
 */
export const flowChangeProblems = (saved, next, counts) => {
	/** @type {Map<string, Array<{ role: string, count: number }>>} */
	const byStatus = new Map();
	for (const { status, role, count } of counts)
		if (count > 0) byStatus.set(status, [...(byStatus.get(status) ?? []), { role, count }]);
	/** @type {Array<{ path: string, message: string, code: 'status_in_use' }>} */
	const problems = [];
	for (const [status, groups] of byStatus) {
		const count = groups.reduce((sum, group) => sum + group.count, 0);
		const orders = count === 1 ? '1 order' : `${count} orders`;
		const before = statusOf(saved, status);
		const index = next.statuses.findIndex((entry) => entry.key === status);
		const name = `${before?.label ?? status} (${status})`;
		const restatus = 'Move its orders to another status of the same kind first (POST /v1/orders/restatus).';
		if (index < 0) {
			if (before)
				problems.push({
					path: '/value/statuses',
					code: 'status_in_use',
					message: `The status ${name} has ${orders} in it, so it cannot be removed or get another key. ${restatus}`,
				});
			continue;
		}
		const role = /** @type {OrderFlow['statuses'][number]} */ (next.statuses[index]).role;
		// unchanged, or the kind of step all its orders are in
		if (role === before?.role || groups.every((group) => group.role === role)) continue;
		const kept = before?.role ?? /** @type {{ role: string }} */ (groups[0]).role;
		problems.push({
			path: `/value/statuses/${index}/role`,
			code: 'status_in_use',
			message: `The status ${name} has ${orders} in it, so its kind of step stays ${kept} (not ${role}). ${restatus}`,
		});
	}
	return problems;
};

/**
 * Check moving every order of one status to another of the same kind of step (`POST /v1/orders/restatus`): `to` a
 * status of the flow other than `from`, and `from` (when the flow still has it) of the same role.
 * @param {OrderFlow} flow @param {string} from @param {string} to
 * @returns {{ ok: true, role: StatusRole } | { ok: false, field: 'from' | 'to', message: string }}
 */
export const checkRestatus = (flow, from, to) => {
	if (!KEY.test(from)) return { ok: false, field: 'from', message: 'Name the status the orders are in.' };
	const target = statusOf(flow, to);
	if (!target) return { ok: false, field: 'to', message: 'Name a status of the order flow.' };
	if (to === from) return { ok: false, field: 'to', message: 'Name another status than from.' };
	const source = statusOf(flow, from);
	if (source && source.role !== target.role)
		return {
			ok: false,
			field: 'to',
			message: `${source.label} is a ${source.role} step and ${target.label} a ${target.role} step: orders move only between statuses of the same kind.`,
		};
	return { ok: true, role: target.role };
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
 * The listed move from one status to another that `who` may make (`system`, the shop itself: any listed move), with
 * every field ({@link moveRules}); null when the flow does not list it, `who` may not make it or the role rules refuse it
 * (checked again, so an order whose status was renamed or removed meanwhile cannot slip through).
 * @param {OrderFlow} flow @param {string} from @param {string} to @param {Mover} [who]
 */
export const moveOf = (flow, from, to, who = 'system') => {
	const fromRole = statusOf(flow, from)?.role;
	const toRole = statusOf(flow, to)?.role;
	if (!fromRole || !toRole || from === to || !rolesAllow(fromRole, toRole)) return null;
	const move = flow.moves.find((entry) => entry.from === from && entry.to === to);
	if (!move) return null;
	const rules = moveRules(flow, move);
	return who === 'system' || rules.who.includes(who) ? rules : null;
};

/**
 * Whether the flow allows moving an order from one status to another (`who` may make it; by default any listed move).
 * @param {OrderFlow} flow @param {string} from @param {string} to @param {Mover} [who]
 */
export const canMove = (flow, from, to, who = 'system') => moveOf(flow, from, to, who) !== null;

/**
 * Whether the role rules let an order of one role become another (whatever moves the flow lists): the outer net of
 * every transition, also of those that need no listed move (a window that ends).
 * @param {StatusRole} from @param {StatusRole} to
 */
export const rolesAllow = (from, to) => (ALLOWED_FROM[to] ?? []).includes(from);

/**
 * The statuses an order may move to next (by `who`; by default any listed move).
 * @param {OrderFlow} flow @param {string} from @param {Mover} [who]
 */
export const nextStatuses = (flow, from, who = 'system') =>
	flow.statuses.filter((status) => canMove(flow, from, status.key, who));

/**
 * Where a waiting order goes once it is paid or confirmed: the first allowed move into an `open` status.
 * @param {OrderFlow} flow @param {string} from @param {Mover} [who]
 * @returns {string | null}
 */
export const confirmedStatus = (flow, from, who = 'system') =>
	nextStatuses(flow, from, who).find((status) => status.role === 'open')?.key ?? null;

/**
 * The first canceled status listed from a status, else the first canceled status (an ended window's default).
 * @param {OrderFlow} flow @param {string} from
 * @returns {string}
 */
export const cancelledStatus = (flow, from) =>
	nextStatuses(flow, from).find((status) => status.role === 'cancelled')?.key ?? statusWithRole(flow, 'cancelled');

/**
 * The move a shopper cancels with from a status: the first listed move into a canceled status the shopper may make, or
 * null.
 * @param {OrderFlow} flow @param {string} from
 */
export const shopperCancelOf = (flow, from) => {
	for (const status of flow.statuses) {
		if (status.role !== 'cancelled') continue;
		const move = moveOf(flow, from, status.key, 'shopper');
		if (move) return move;
	}
	return null;
};

/**
 * The name a shopper reads for a status: its shopper name, else its name (an unknown status shows its key).
 * @param {OrderFlow} flow @param {string} key
 */
export const shopperLabelOf = (flow, key) => {
	const status = statusOf(flow, key);
	return status ? status.shopperLabel || status.label : key;
};

/**
 * The line a shopper reads under a status for a payment method ('' = none).
 * @param {OrderFlow} flow @param {string} key @param {string} method
 */
export const shopperTextOf = (flow, key, method) =>
	String(/** @type {Record<string, string> | undefined} */ (statusOf(flow, key)?.shopperText)?.[method] ?? '');

/**
 * Whether entering a status sends the shopper a message (today's default list when the flow does not say).
 * @param {OrderFlow} flow @param {string} key
 */
export const notifiesOf = (flow, key) => {
	const status = statusOf(flow, key);
	return status ? (status.notify ?? NOTIFIED_KEYS.includes(key)) : false;
};

/**
 * Whether entering a status alerts the staff (E36: the status's `staffAlert`, off unless the flow says so).
 * @param {OrderFlow} flow @param {string} key
 */
export const staffAlertOf = (flow, key) => statusOf(flow, key)?.staffAlert === true;

/** The default flow, every field filled. */
export const DEFAULT_FLOW = /** @type {Required<OrderFlow>} */ (
	/** @type {{ value: Required<OrderFlow> }} */ (checkOrderFlow(DEFAULT_DEFINITION)).value
);
