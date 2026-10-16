/**
 * Orders for the merchant (PLAN 0.8.8), the pure part: the staff order list's filters, what staff send to move,
 * refund and edit an order (checked), serial numbers captured when packing, how much of a refund goes back through
 * Payments, and the order views staff see. Records are `core/model.js` shapes; times become ISO-8601 UTC on the wire;
 * amounts stay minor units, with a text (`totalText` …) made by the website's Format (PLAN 0.8.10 K7). No I/O.
 * @module
 */
import { ADDRESS_LIMITS } from './address.js';
import { factsOf } from './facts.js';
import { phoneSearchOf } from './guests.js';
import { CLOSED_ROLES, moveOf, nextStatuses, statusOf } from './flow.js';
import { ID_PREFIX, STATUS_ROLES } from './model.js';
import { MAX_MEASURED, piecesOf } from './measure.js';
import { checkAttachmentInputs } from './attachments.js';
import { isPositiveAmount } from '@ss/contracts/format';
import { LIST_KEY } from './named-lists.js';
import { MAX_TRACKING, cleanTracking, hasControl } from './couriers.js';
import { OTHER_WAY, VIA_PAYMENTS, isMethodKey } from './payment-methods.js';
import { TAG_LIMITS, checkTags } from './customer-segments.js';

/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {import('./model.js').OrderFlow} OrderFlow */
/** @typedef {import('./model.js').StatusRole} StatusRole */
/** @typedef {import('./model.js').CustomerRecord} CustomerRecord */
/** An amount as text, by the website's Format (`product.format(websiteId).money`). @typedef {(amount: number, currency: string) => string} Money */

/** Payment states. */
export const PAYMENT_STATES = Object.freeze(
	/** @type {const} */ (['unpaid', 'pending', 'paid', 'partially_refunded', 'refunded']),
);
/** Roles in which an order's address may still change (before shipping). */
export const EDITABLE_ROLES = Object.freeze(
	/** @type {ReadonlyArray<StatusRole>} */ (['awaiting_payment', 'awaiting_confirmation', 'open', 'packed']),
);
/** Bulk moves take at most this many orders. */
const MAX_BULK = 200;
/** Longest note, staff note, search text and unit number as typed. */
export const MAX_NOTE = 1000;
export const MAX_STAFF_NOTE = 5000;
export const MAX_SEARCH = 120;
const MAX_UNIT_TEXT = 200;
/** A booked shipment's status is asked again at most this often (on read). */
export const TRACK_EVERY_MS = 30 * 60_000;

/**
 * History entries the server writes itself (PLAN 0.4.10: every word a widget shows is a text the merchant can edit):
 * each keeps its English `note` and gets its `code` (the widgets' words, `ordersAdmin.historyNote.<code>`) with its
 * `values`. `shopper`: the shopper canceled; `not_paid_in_time` and `not_confirmed_in_time`: a waiting order ended;
 * `payment_confirmed`: Payments confirmed the payment (a move); `payments_took` and `paid_after_cancel` (`amount`):
 * Payments took money outside that, after the cancel for the second; `proof_sent`: the shopper sent a transfer proof;
 * `edited`; `serials_typed`; `refunded` and `refunded_recorded` (`amount`, `reason`), `claim_refunded` and
 * `claim_refunded_recorded` (`amount`, the claim's `reference`; a claim refunded without a note): a refund, partly
 * recorded for the `_recorded` ones; `refunds_cover_payments`: the move to the refunded status that follows;
 * `payment_recorded` (`amount`) and `payment_recorded_reference` (`amount`, `reference`): staff recorded a payment;
 * `confirmed_on_payment`: the move to the confirmed status that follows; `restatus`: staff moved every order of a
 * status to another status of the same kind (`POST /v1/orders/restatus`); `attachment_added` and
 * `attachment_removed`: staff added or removed attachments on the order (E20).
 */
export const HISTORY_NOTES = Object.freeze(
	/** @type {const} */ ([
		'shopper',
		'not_paid_in_time',
		'not_confirmed_in_time',
		'payment_confirmed',
		'payments_took',
		'paid_after_cancel',
		'proof_sent',
		'edited',
		'serials_typed',
		'refunded',
		'refunded_recorded',
		'claim_refunded',
		'claim_refunded_recorded',
		'refunds_cover_payments',
		'payment_recorded',
		'payment_recorded_reference',
		'confirmed_on_payment',
		'restatus',
		'attachment_added',
		'attachment_removed',
	]),
);
/** @typedef {typeof HISTORY_NOTES[number]} HistoryNote */

/**
 * What staff are warned of after a move, a refund or a recorded payment (the widgets' words `ordersAdmin.warning.<code>`):
 * `refund_by_hand` (`amount`): Payments only recorded a refund, so the shop gives the money back by hand (OR-8);
 * `cancel_refund_failed` (`amount`): the order was canceled but its refund through Payments failed; `refund_failed`
 * (`amount`): the order moved to a refunded status but refunding through Payments failed (tried again while Payments
 * cannot be reached); `refund_pending` (`amount`): a staff refund Payments did not answer is kept on the order and sent
 * again when the order is next used (the refund lock: never twice, always recorded); `refund_skipped` (`amount`): a
 * refund through Payments was not sent because the order was refunded meanwhile.
 */
export const MOVE_WARNINGS = Object.freeze(
	/** @type {const} */ (['refund_by_hand', 'cancel_refund_failed', 'refund_failed', 'refund_pending', 'refund_skipped']),
);

/**
 * The values of a code the server writes: `amount` in minor units of the order's currency, the text of a `reason` and a
 * `reference`.
 * @typedef {{ amount?: number, reason?: string, reference?: string }} NoteValues
 */
/**
 * A warning for staff: its English `text`, and its `code` and `values` for the widgets' words.
 * @typedef {{ code: typeof MOVE_WARNINGS[number], values: NoteValues, text: string }} Warning
 */

/**
 * The note of a history entry the server writes itself: its English words, its code and its values.
 * @param {HistoryNote} code @param {string} note @param {NoteValues} [values]
 */
export const serverNote = (code, note, values) => ({ note, code, ...(values ? { values } : {}) });

/**
 * Who made a history entry, as the entry keeps it: the actor's name and kind (`staff`: a ticket's user; `user`: the
 * member of the staff a server call names in its `SS-Actor-*` headers; `server`: the server token, named `Server`), so
 * the widgets tell the server from a member of the staff of the same name.
 * @param {{ kind: string, name?: string }} actor
 */
export const byActor = (actor) => ({ by: actor.name ?? '', byKind: actor.kind });

/**
 * The warnings of an answer: their English texts (`warnings`) and, in the same order, their codes and values
 * (`warningCodes`).
 * @param {Warning[]} list
 */
export const warningsOf = (list) => ({
	warnings: list.map((warning) => warning.text),
	warningCodes: list.map(({ code, values }) => ({ code, values })),
});

/**
 * A problem found in what staff sent: the field (JSON pointer without the leading slash) and a message.
 * @typedef {{ ok: false, field: string, message: string }} Refusal
 */

/** @param {string} field @param {string} message @returns {Refusal} */
const refuse = (field, message) => ({ ok: false, field, message });

/** @param {unknown} value @returns {Record<string, unknown>} */
const objectOf = (value) =>
	typeof value === 'object' && value !== null && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};

/** @param {string} text */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A record as it goes on the wire: dates as ISO strings, without the database fields.
 * @param {unknown} value
 * @returns {any}
 */
export const wire = (value) => {
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(wire);
	if (typeof value !== 'object' || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== '_id' && key !== 'websiteId' && key !== 'merchantId')
			.map(([key, v]) => [key, wire(v)]),
	);
};

// --------------------------------------------------------------------------------------------------------- money

/**
 * What Payments took for an order and has not refunded yet (paid online or first, an advance): the `payments` entries
 * of its payments log for its Payments payment, less the refunds made through Payments (`payments`, or with a Payments
 * refund id when Payments only recorded them, OR-8) (PM-2). Money staff recorded (a transfer, cash, another way) is never
 * Payments' to refund, even on an order that has a Payments payment.
 * @param {OrderRecord} order
 */
const leftAtPayments = (order) => {
	const { paymentId } = order.payment;
	if (!paymentId) return 0;
	const took = order.payments
		.filter((entry) => entry.method === VIA_PAYMENTS && entry.reference === paymentId)
		.reduce((sum, entry) => sum + entry.amount, 0);
	const gave = order.refunds
		.filter((entry) => entry.method === VIA_PAYMENTS || Boolean(entry.refundId))
		.reduce((sum, entry) => sum + entry.amount, 0);
	return Math.max(0, took - gave);
};

/**
 * An order's money, the one way every view, invoice, message, lookup and check counts it (CK-5, K-23): `paid` and
 * `refunded` as its payments and refunds logs add up (E26); `net` what the shop holds of it; `due` what is still to pay,
 * the total less what was paid (a refund never makes a debt), and nothing once the order is closed (`CLOSED_ROLES`);
 * `refundable` what can still be given back; `refundDue` the shopper's money a canceled order still holds, to be
 * refunded (a payment that came after the cancel, or money recorded by staff, K-13).
 * @param {Pick<OrderRecord, 'role' | 'totals' | 'payment'>} order
 */
export const orderMoney = (order) => {
	const { paid, refunded } = order.payment;
	const net = Math.max(0, paid - refunded);
	return {
		paid,
		refunded,
		net,
		due: CLOSED_ROLES.includes(order.role) ? 0 : Math.max(0, order.totals.total - paid),
		refundable: net,
		refundDue: order.role === 'cancelled' ? net : 0,
	};
};

/**
 * What can still be refunded ({@link orderMoney}).
 * @param {OrderRecord} order
 */
export const refundable = (order) => orderMoney(order).refundable;

/**
 * How a refund is split: through Payments first (as long as Payments' share is not refunded yet), the rest recorded
 * as given back by hand.
 * @param {OrderRecord} order
 * @param {number} amount
 * @returns {{ online: number, manual: number }}
 */
export const refundSplit = (order, amount) => {
	const online = Math.min(amount, leftAtPayments(order));
	return { online, manual: amount - online };
};

/**
 * The points an order earned that were not taken back yet (`pointsReversed`: by a claim's refund or a move, OR-10), so
 * no reversal ever takes more than the order earned.
 * @param {Pick<OrderRecord, 'promotions'>} order
 */
export const earnedLeft = (order) => Math.max(0, order.promotions.pointsEarned - (order.promotions.pointsReversed ?? 0));

/**
 * Whose loyalty points an order's are: the member's, or the guest's customer record (E20, K-6), else nobody.
 * @param {Pick<OrderRecord, 'customer'>} order
 * @returns {{ userId: string } | { customerId: string } | null}
 */
export const pointsOwner = (order) =>
	order.customer.userId
		? { userId: order.customer.userId }
		: order.customer.customerId
			? { customerId: order.customer.customerId }
			: null;

/**
 * The payment state after refunds.
 * @param {number} paid
 * @param {number} refunded
 * @returns {import('./model.js').PaymentState}
 */
export const stateAfterRefund = (paid, refunded) => (refunded >= paid ? 'refunded' : 'partially_refunded');

// --------------------------------------------------------------------------------------------------------- input

/**
 * @typedef {object} OrderFilters
 * @property {string[]} [statuses] status keys (`status`, one or several, E31)
 * @property {StatusRole} [role]
 * @property {import('./model.js').PaymentState} [paymentState]
 * @property {import('./model.js').PaymentMethod[]} [paymentMethods] (`paymentMethod`, one or several, E31)
 * @property {Array<'delivery' | 'pickup' | 'none'>} [deliveryMethods] (`deliveryMethod`, E31)
 * @property {string[]} [reasons] (`reason`): why orders were canceled or came back (E19)
 * @property {string} [city] the delivery city (E31)
 * @property {string} [customer] a customer's user id or customer id (E31)
 * @property {string[]} [tags] orders with any of these tags (`tag`, E11)
 * @property {Date} [from] placed at or after
 * @property {Date} [to] placed before
 * @property {Date} [createdAfter] created after (E31)
 * @property {boolean} [refundDue] only canceled orders that still hold the shopper's money (`refundDue=1`: paid before
 *   or after the cancel, not all refunded)
 * @property {boolean} [unseen] not yet opened by the acting staff member (E31; the server adds who)
 * @property {string} [q] number, name, phone (its digits anywhere), email or city
 * @property {string[]} [phoneDigits] the digit runs of `q` to find in phones, read by the website's phone rules (the
 *   server adds them, `core/guests.js` `phoneSearchOf`; without them, the digits typed without leading zeros)
 */

/** @param {unknown} value */
const dateOf = (value) => {
	if (typeof value !== 'string' || value === '' || value.length > 40) return null;
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : new Date(time);
};

/** A status key (letters, digits, _ and -, E27). */
const STATUS_KEY = /^[a-z][a-z0-9_-]{1,39}$/;

/**
 * Several values given comma-separated (or repeated), each one checked.
 * @param {unknown} raw
 * @param {(value: string) => boolean} valid
 * @returns {string[] | null} null when one is not valid
 */
const several = (raw, valid) => {
	const values = (Array.isArray(raw) ? raw : [raw])
		.flatMap((value) => String(value).split(','))
		.map((value) => value.trim())
		.filter(Boolean);
	if (values.length > 30 || !values.every(valid)) return null;
	return [...new Set(values)];
};

/**
 * The order list's filters from the query.
 * @param {Record<string, unknown>} query
 * @returns {{ ok: true, value: OrderFilters } | Refusal}
 */
export const orderFilters = (query) => {
	/** @type {OrderFilters} */
	const value = {};
	const text = (/** @type {string} */ name) =>
		(typeof query[name] === 'string' || Array.isArray(query[name])) && query[name] !== '' ? query[name] : null;
	const status = text('status');
	if (status !== null) {
		const statuses = several(status, (key) => STATUS_KEY.test(key));
		if (!statuses) return refuse('status', 'Unknown status.');
		value.statuses = statuses;
	}
	const role = text('role');
	if (role !== null) {
		if (!(/** @type {readonly string[]} */ (STATUS_ROLES).includes(String(role)))) return refuse('role', 'Unknown role.');
		value.role = /** @type {StatusRole} */ (role);
	}
	const paymentState = text('paymentState');
	if (paymentState !== null) {
		if (!(/** @type {readonly string[]} */ (PAYMENT_STATES).includes(String(paymentState))))
			return refuse('paymentState', 'Unknown payment state.');
		value.paymentState = /** @type {import('./model.js').PaymentState} */ (paymentState);
	}
	const paymentMethod = text('paymentMethod');
	if (paymentMethod !== null) {
		const methods = several(paymentMethod, isMethodKey);
		if (!methods) return refuse('paymentMethod', 'Unknown payment method.');
		value.paymentMethods = /** @type {import('./model.js').PaymentMethod[]} */ (methods);
	}
	const deliveryMethod = text('deliveryMethod');
	if (deliveryMethod !== null) {
		const methods = several(deliveryMethod, (method) => ['delivery', 'pickup', 'none'].includes(method));
		if (!methods) return refuse('deliveryMethod', 'deliveryMethod is delivery, pickup or none.');
		value.deliveryMethods = /** @type {Array<'delivery' | 'pickup' | 'none'>} */ (methods);
	}
	const reason = text('reason');
	if (reason !== null) {
		const reasons = several(reason, (key) => LIST_KEY.test(key));
		if (!reasons) return refuse('reason', 'reason is a key of the cancel or failed-delivery reasons.');
		value.reasons = reasons;
	}
	const city = text('city');
	if (city !== null) {
		if (String(city).length > 100) return refuse('city', 'At most 100 characters.');
		value.city = String(city).trim();
	}
	const customer = text('customer');
	if (customer !== null) {
		if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(customer))) return refuse('customer', 'Unknown customer.');
		value.customer = String(customer);
	}
	const tag = text('tag');
	if (tag !== null) {
		const tags = several(tag, (one) => one.length <= TAG_LIMITS.tag);
		if (!tags) return refuse('tag', `Name at most 30 tags of up to ${TAG_LIMITS.tag} characters.`);
		value.tags = tags;
	}
	for (const name of /** @type {const} */ (['from', 'to', 'createdAfter'])) {
		const raw = text(name);
		if (raw === null) continue;
		const date = dateOf(raw);
		if (!date) return refuse(name, 'Use an ISO-8601 date.');
		value[name] = date;
	}
	if (query.unseen === '1' || query.unseen === 'true') value.unseen = true;
	if (query.refundDue === '1' || query.refundDue === 'true') value.refundDue = true;
	const q = typeof query.q === 'string' ? query.q.trim() : '';
	if (q.length > MAX_SEARCH) return refuse('q', `Search for at most ${MAX_SEARCH} characters.`);
	if (q) value.q = q;
	return { ok: true, value };
};

/**
 * The database filter of the order list (without `websiteId` and the page).
 * @param {OrderFilters} filters
 * @param {{ seenBy?: string }} [options] the acting staff member, for `unseen`
 * @returns {Record<string, unknown>}
 */
export const orderQuery = (filters, { seenBy = '' } = {}) => {
	/** @type {Record<string, unknown>} */
	const query = {};
	if (filters.statuses) query.status = filters.statuses.length === 1 ? filters.statuses[0] : { $in: filters.statuses };
	if (filters.role) query.role = filters.role;
	if (filters.paymentState) query['payment.state'] = filters.paymentState;
	if (filters.paymentMethods) query['payment.method'] = { $in: filters.paymentMethods };
	if (filters.deliveryMethods) query['delivery.method'] = { $in: filters.deliveryMethods };
	if (filters.reasons) query.closeReason = { $in: filters.reasons };
	if (filters.city) query['address.city'] = { $regex: `^${escapeRegex(filters.city)}$`, $options: 'i' };
	// a customer id (`cus_…`, guests too) or an Accounts user id
	if (filters.customer)
		query[filters.customer.startsWith('cus_') ? 'customer.customerId' : 'customer.userId'] = filters.customer;
	if (filters.from || filters.to)
		query.placedAt = { ...(filters.from ? { $gte: filters.from } : {}), ...(filters.to ? { $lt: filters.to } : {}) };
	if (filters.createdAfter) query.createdAt = { $gt: filters.createdAfter };
	if (filters.tags) query.tags = { $in: filters.tags };
	if (filters.unseen && seenBy) query.seenBy = { $ne: seenBy };
	// a canceled order whose money is not all given back (orderMoney's refundDue)
	if (filters.refundDue) Object.assign(query, { role: 'cancelled', $expr: { $gt: ['$payment.paid', '$payment.refunded'] } });
	if (filters.q) {
		const term = escapeRegex(filters.q);
		const digits = filters.q.replace(/\D/g, '');
		const phones = filters.phoneDigits ?? phoneSearchOf(filters.q, null);
		query.$or = [
			// the number: what was typed anywhere in it, and its digits anywhere (3 or more: "1042" finds SO-2026-001042)
			{ number: { $regex: term, $options: 'i' } },
			...(digits.length >= 3 && digits !== filters.q ? [{ number: { $regex: escapeRegex(digits) } }] : []),
			{ 'customer.name': { $regex: term, $options: 'i' } },
			{ 'customer.email': { $regex: `^${term}`, $options: 'i' } },
			{ 'address.name': { $regex: term, $options: 'i' } },
			{ 'address.city': { $regex: `^${term}`, $options: 'i' } },
			// the phone's digits anywhere in its whole number, whatever its format (E31)
			...phones.flatMap((run) => [
				{ phoneDigits: { $regex: escapeRegex(run) } },
				{ 'customer.phone': { $regex: escapeRegex(run) } },
				{ 'address.phone': { $regex: escapeRegex(run) } },
			]),
		];
	}
	return query;
};

/**
 * @typedef {{ courier: string, trackingNumber: string, trackingNote?: string, estimatedDeliveryAt?: Date | null } |
 *   { book: true, courier?: string }} ShipmentInput `trackingNumber` may be '' when the website does not require it (E28)
 * @typedef {{ to: string, note: string, serials: Record<string, UnitInput[]>, shipment: ShipmentInput | null,
 *   updatedAt: string | null, reason?: string, attachments?: import('./attachments.js').AttachmentInput[], code?: HistoryNote,
 *   shopperNote?: string, restock?: boolean }} MoveInput
 *   `reason`: why staff cancel or a package came back, a key of the merchant's reason list (E19); `attachments`: attachments added with the move (E20); `code`: the code of a
 *   note the server writes itself (a move that follows a refund or a recorded payment; never from what staff send);
 *   `shopperNote`: a note the shopper reads in the order's timeline and message (the staff note stays internal);
 *   `restock`: whether the items go back in stock, for a move that asks (`restock: ask`)
 */

/**
 * Check a move.
 * @param {unknown} body
 * @returns {{ ok: true, value: MoveInput } | Refusal}
 */
export const checkMove = (body) => {
	const input = objectOf(body);
	const to = typeof input.to === 'string' ? input.to : '';
	if (!/^[a-z][a-z0-9_-]{1,39}$/.test(to)) return refuse('to', 'Name the status to move to.');
	const note = input.note === undefined || input.note === null ? '' : input.note;
	if (typeof note !== 'string' || note.length > MAX_NOTE) return refuse('note', `A note has at most ${MAX_NOTE} characters.`);
	const shopperNote = input.shopperNote === undefined || input.shopperNote === null ? '' : input.shopperNote;
	if (typeof shopperNote !== 'string' || shopperNote.length > MAX_NOTE)
		return refuse('shopperNote', `A note for the shopper has at most ${MAX_NOTE} characters.`);
	if (input.restock !== undefined && input.restock !== null && typeof input.restock !== 'boolean')
		return refuse('restock', 'restock is true or false.');
	const parsed = serialsOf(input.serials);
	if (!parsed.ok) return parsed;
	const serials = parsed.value;
	/** @type {ShipmentInput | null} */
	let shipment = null;
	if (input.shipment !== undefined && input.shipment !== null) {
		const raw = objectOf(input.shipment);
		const courier = typeof raw.courier === 'string' ? raw.courier.trim() : '';
		if (raw.book === true) shipment = courier ? { book: true, courier } : { book: true };
		else {
			const checked = shipmentFields(raw);
			if (!checked.ok) return checked;
			shipment = checked.value;
		}
	}
	/** @type {import('./attachments.js').AttachmentInput[]} */
	let attachments = [];
	if (input.attachments !== undefined && input.attachments !== null) {
		const checked = checkAttachmentInputs(input.attachments);
		if (!checked.ok) return checked;
		attachments = checked.value;
	}
	const updatedAt = typeof input.updatedAt === 'string' && input.updatedAt !== '' ? input.updatedAt : null;
	if (input.reason !== undefined && input.reason !== null && (typeof input.reason !== 'string' || !LIST_KEY.test(input.reason)))
		return refuse('reason', 'reason is a key of the cancel_reasons or delivery_failure_reasons list.');
	const reason = typeof input.reason === 'string' ? input.reason : undefined;
	return {
		ok: true,
		value: {
			to,
			note: note.trim(),
			serials,
			shipment,
			updatedAt,
			...(reason ? { reason } : {}),
			...(attachments.length > 0 ? { attachments } : {}),
			...(shopperNote.trim() ? { shopperNote: shopperNote.trim() } : {}),
			...(typeof input.restock === 'boolean' ? { restock: input.restock } : {}),
		},
	};
};

/** Longest tracking note. */
const MAX_TRACKING_NOTE = 500;

/**
 * A shipment's fields as staff send them (E28): the courier (by key or name), the tracking number ('' allowed here:
 * the server knows whether the website requires one), a free-text tracking note and an expected delivery date.
 * @param {Record<string, unknown>} raw
 * @returns {{ ok: true, value: { courier: string, trackingNumber: string, trackingNote: string, estimatedDeliveryAt: Date | null } } | Refusal}
 */
export const shipmentFields = (raw) => {
	const courier = typeof raw.courier === 'string' ? raw.courier.trim() : '';
	if (courier.length > 80) return refuse('shipment/courier', 'Pick a courier.');
	const given = raw.trackingNumber === undefined || raw.trackingNumber === null ? '' : raw.trackingNumber;
	const trackingNumber = given === '' ? '' : cleanTracking(given);
	if (trackingNumber === null || (given !== '' && !trackingNumber))
		return refuse('shipment/trackingNumber', `A tracking number has 1–${MAX_TRACKING} characters.`);
	const note = raw.trackingNote === undefined || raw.trackingNote === null ? '' : raw.trackingNote;
	if (typeof note !== 'string' || note.length > MAX_TRACKING_NOTE || hasControl(note.replace(/\n/g, ' ')))
		return refuse('shipment/trackingNote', `A tracking note has at most ${MAX_TRACKING_NOTE} characters.`);
	let estimatedDeliveryAt = null;
	if (raw.estimatedDeliveryAt !== undefined && raw.estimatedDeliveryAt !== null && raw.estimatedDeliveryAt !== '') {
		estimatedDeliveryAt = dateOf(raw.estimatedDeliveryAt);
		if (!estimatedDeliveryAt) return refuse('shipment/estimatedDeliveryAt', 'Give the expected delivery date (ISO 8601).');
	}
	if (!courier && trackingNumber) return refuse('shipment/courier', 'Pick a courier.');
	return {
		ok: true,
		value: { courier, trackingNumber: trackingNumber ?? '', trackingNote: note.trim(), estimatedDeliveryAt },
	};
};

/**
 * True for a way staff may record money in or out by (E26, E16): a method of the website's list, or `other` (with a
 * reference); `payments` is Payments' own.
 * @param {unknown} way @param {ReadonlyArray<string>} keys the `payment_methods` list's keys
 */
const isRecordedWay = (way, keys) => way === OTHER_WAY || (isMethodKey(way) && keys.includes(way));
/** Longest payment or refund reference. */
export const MAX_REFERENCE = 120;

/**
 * @typedef {{ amount: number, reason: string, method: string | null,
 *   reference: string, claimId: string | null, claimReference?: string,
 *   claim?: import('./transitions.js').ClaimRefundUndo }} RefundInput `method` null: through Payments first, the rest
 *   recorded as `other`; `payments`: only through Payments; else the way staff gave it back (a method key or `other`); `claimReference`: a claim's refund without a note (its reason is then `Claim <reference>`); `claim`: what
 *   the claim gets back when its refund through Payments does not happen
 */

/** @param {unknown} value @returns {{ ok: true, value: string } | Refusal} */
const referenceOf = (value) => {
	const reference = value === undefined || value === null ? '' : value;
	if (typeof reference !== 'string' || reference.trim().length > MAX_REFERENCE)
		return refuse('reference', `A reference has at most ${MAX_REFERENCE} characters.`);
	return { ok: true, value: reference.trim() };
};

/**
 * Check a refund without a status change (E26: with how it was given back, a reference and the claim it is for).
 * @param {unknown} body
 * @param {OrderRecord} order
 * @param {ReadonlyArray<string>} keys the `payment_methods` list's keys
 * @returns {{ ok: true, value: RefundInput } | Refusal}
 */
export const checkRefund = (body, order, keys) => {
	const input = objectOf(body);
	const left = refundable(order);
	if (left <= 0) return refuse('amount', 'Nothing paid is left to refund.');
	if (!isPositiveAmount(input.amount) || /** @type {number} */ (input.amount) > left)
		return refuse('amount', `Refund a whole amount in minor units from 1 to ${left}.`);
	const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
	if (!reason || reason.length > 500) return refuse('reason', 'Give a reason of at most 500 characters.');
	const method = input.method === undefined || input.method === null ? null : input.method;
	if (method !== null && method !== VIA_PAYMENTS && !isRecordedWay(method, keys))
		return refuse('method', 'method is payments, one of the payment methods, or other.');
	if (method === VIA_PAYMENTS && refundSplit(order, 1).online === 0)
		return refuse('method', 'Nothing paid through Payments is left to refund on this order.');
	const reference = referenceOf(input.reference);
	if (!reference.ok) return reference;
	const claimId = input.claimId === undefined || input.claimId === null ? null : input.claimId;
	if (claimId !== null && (typeof claimId !== 'string' || !/^ret_[A-Za-z0-9_-]{1,64}$/.test(claimId)))
		return refuse('claimId', 'claimId names a return claim.');
	return {
		ok: true,
		value: {
			amount: /** @type {number} */ (input.amount),
			reason,
			method: /** @type {RefundInput['method']} */ (method),
			reference: reference.value,
			claimId: /** @type {string | null} */ (claimId),
		},
	};
};

/**
 * @typedef {{ method: string, amount: number, reference: string, note: string, confirm: boolean }} PaymentInput
 *   `method`: a payment method key of the list, or `other`
 */

/**
 * Check a payment staff record (E26): at most the balance due, never on a closed order (canceled, returned or
 * refunded: money for it is refunded, not taken, K-13).
 * @param {unknown} body
 * @param {OrderRecord} order
 * @param {ReadonlyArray<string>} keys the `payment_methods` list's keys
 * @returns {{ ok: true, value: PaymentInput } | Refusal}
 */
export const checkPayment = (body, order, keys) => {
	const input = objectOf(body);
	if (!isRecordedWay(input.method, keys)) return refuse('method', 'method is one of the payment methods, or other.');
	if (CLOSED_ROLES.includes(order.role)) return refuse('amount', 'This order is closed: no payment can be recorded on it.');
	const { due } = orderMoney(order);
	if (due <= 0) return refuse('amount', 'Nothing is left to pay on this order.');
	if (!isPositiveAmount(input.amount) || /** @type {number} */ (input.amount) > due)
		return refuse('amount', `Record a whole amount in minor units from 1 to ${due}.`);
	const reference = referenceOf(input.reference);
	if (!reference.ok) return reference;
	const note = input.note === undefined || input.note === null ? '' : input.note;
	if (typeof note !== 'string' || note.length > MAX_NOTE) return refuse('note', `A note has at most ${MAX_NOTE} characters.`);
	if (input.confirm !== undefined && typeof input.confirm !== 'boolean') return refuse('confirm', 'confirm is true or false.');
	return {
		ok: true,
		value: {
			method: /** @type {string} */ (input.method),
			amount: /** @type {number} */ (input.amount),
			reference: reference.value,
			note: note.trim(),
			confirm: input.confirm === true,
		},
	};
};

/**
 * The payment state from what was paid and refunded (E26): refunds first, then paid in full, part paid (`unpaid`: the
 * rest is due), else as it was (waiting for Payments, or nothing yet).
 * @param {{ total: number, paid: number, refunded: number, state: import('./model.js').PaymentState }} money
 * @returns {import('./model.js').PaymentState}
 */
export const paymentStateOf = ({ total, paid, refunded, state }) => {
	if (refunded > 0) return stateAfterRefund(paid, refunded);
	if (paid >= total && total > 0) return 'paid';
	if (paid > 0) return 'unpaid';
	return state;
};

/**
 * A unit staff give for an order line: its serial number (registered units are picked by it), or, typed with unit
 * fields, its values by unit field (`core/fields.js` `checkUnit` checks them against the line's product).
 * @typedef {string | { values: Record<string, unknown> }} UnitInput
 */

/**
 * The units sent per order line (moves and edits): per line a list of serial numbers (trimmed, inner spaces kept) or
 * `{ values }` objects; what each unit must be is checked against its product's unit fields.
 * @param {unknown} raw
 * @returns {{ ok: true, value: Record<string, UnitInput[]> } | Refusal}
 */
export const serialsOf = (raw) => {
	/** @type {Record<string, UnitInput[]>} */
	const serials = {};
	if (raw === undefined || raw === null) return { ok: true, value: serials };
	if (typeof raw !== 'object' || Array.isArray(raw)) return refuse('serials', 'Serials are listed per order line.');
	for (const [lineId, list] of Object.entries(objectOf(raw))) {
		if (!Array.isArray(list) || list.length > 1000) return refuse(`serials/${lineId}`, 'A list of units is expected.');
		/** @type {UnitInput[]} */
		const units = [];
		for (const entry of list) {
			if (typeof entry === 'string' && entry.trim() && entry.length <= MAX_UNIT_TEXT) units.push(entry.trim());
			else if (
				objectOf(entry).values !== undefined &&
				typeof objectOf(entry).values === 'object' &&
				objectOf(entry).values !== null
			)
				units.push({ values: objectOf(objectOf(entry).values) });
			else return refuse(`serials/${lineId}`, 'A unit is its serial number, or { values } by unit field.');
		}
		serials[lineId] = units;
	}
	return { ok: true, value: serials };
};

/**
 * Check an edit staff make to an order: the staff note, the delivery address before shipping, the shipment's details
 * (E28) and serial numbers.
 * @param {unknown} body
 * @param {OrderRecord} order
 * @returns {{ ok: true, value: OrderEdit } | Refusal}
 */
export const checkEdit = (body, order) => {
	const input = objectOf(body);
	/** @type {OrderEdit} */
	const value = {};
	if (input.serials !== undefined) {
		const serials = serialsOf(input.serials);
		if (!serials.ok) return serials;
		value.serials = serials.value;
	}
	const waiting = waitingEditOf(input);
	if (!waiting.ok) return waiting;
	if (waiting.value) value.waiting = waiting.value;
	if (input.shipment !== undefined && input.shipment !== null) {
		const checked = shipmentFields(objectOf(input.shipment));
		if (!checked.ok) return checked;
		value.shipment = checked.value;
	}
	if (input.staffNote !== undefined) {
		if (typeof input.staffNote !== 'string' || input.staffNote.length > MAX_STAFF_NOTE)
			return refuse('staffNote', `The staff note has at most ${MAX_STAFF_NOTE} characters.`);
		value.staffNote = input.staffNote.trim();
	}
	if (input.fields !== undefined) {
		if (typeof input.fields !== 'object' || input.fields === null || Array.isArray(input.fields))
			return refuse('fields', 'Give the field values by field id.');
		value.fields = objectOf(input.fields);
	}
	// the order's tags (E11), all of them
	if (input.tags !== undefined) {
		const tags = checkTags(input.tags);
		if (!tags.ok) return refuse('tags', tags.message);
		value.tags = tags.value;
	}
	if (input.address !== undefined) {
		if (!order.address && !value.waiting) return refuse('address', 'This order has no delivery address.');
		if (!EDITABLE_ROLES.includes(order.role)) return refuse('address', 'The address cannot change once the order is shipped.');
		const raw = objectOf(input.address);
		/** @type {Record<string, string>} */
		const address = { ...(order.address ?? {}) };
		for (const [field, max] of Object.entries(ADDRESS_LIMITS)) {
			if (raw[field] === undefined) continue;
			if (typeof raw[field] !== 'string' || String(raw[field]).length > max)
				return refuse(`address/${field}`, `At most ${max} characters.`);
			address[field] = String(raw[field]).trim();
		}
		// the fields the website requires are checked by the server as checkout checks them (`checkAddress`)
		value.address = /** @type {NonNullable<OrderRecord['address']>} */ (/** @type {unknown} */ (address));
	}
	// attachments added or removed at any time (E20)
	if (input.attachments !== undefined && input.attachments !== null) {
		const checked = checkAttachmentInputs(input.attachments);
		if (!checked.ok) return checked;
		if (checked.value.length > 0) value.attachments = checked.value;
	}
	if (input.removeAttachments !== undefined && input.removeAttachments !== null) {
		const ids = input.removeAttachments;
		if (
			!Array.isArray(ids) ||
			ids.length > 30 ||
			!ids.every((id) => typeof id === 'string' && (order.attachments ?? []).some((held) => held.id === id))
		)
			return refuse('removeAttachments', "removeAttachments lists ids of the order's attachments.");
		if (ids.length > 0) value.removeAttachments = [...new Set(/** @type {string[]} */ (ids))];
	}
	if (Object.keys(value).length === 0)
		return refuse('staffNote', 'Send a staff note, tags, an address, a shipment, serial numbers or attachments.');
	return { ok: true, value };
};

/**
 * What staff change on an order (`PATCH /v1/orders/:id`): the staff note, the address, the shipment's details at any
 * time (E28), serial numbers and attachments (E20).
 * @typedef {{ staffNote?: string, tags?: string[], address?: NonNullable<OrderRecord['address']>,
 *   serials?: Record<string, UnitInput[]>,
 *   shipment?: { courier: string, trackingNumber: string, trackingNote: string, estimatedDeliveryAt: Date | null },
 *   waiting?: WaitingEdit, attachments?: import('./attachments.js').AttachmentInput[], removeAttachments?: string[],
 *   fields?: Record<string, unknown> }} OrderEdit `waiting`: lines, payment and delivery changed while the order waits
 *   (E29); `attachments`: attachments added (their kinds checked by the caller), `removeAttachments` the ids of those
 *   removed; `fields`: order field values by field id (null clears one), checked against the fields by the caller
 */

/**
 * What staff change on an order that still waits (E29).
 * @typedef {{ lines?: Array<{ variantId: string, quantity: number, unitPrice?: number }>,
 *   paymentMethod?: import('./model.js').PaymentMethod,
 *   delivery?: import('./checkout.js').DeliveryInput,
 *   address?: NonNullable<OrderRecord['address']> }} WaitingEdit
 */

/** An edited order has at most this many lines (the checkout's own limits apply too: 99 pieces of one item, a measured
 * item's steps and limits, `core/checkout.js` `resolveLines`). */
const MAX_EDIT_LINES = 50;

/**
 * Check the lines, payment method and delivery staff send for a waiting order (E29).
 * @param {Record<string, unknown>} input
 * @returns {{ ok: true, value: WaitingEdit | null } | Refusal}
 */
const waitingEditOf = (input) => {
	/** @type {WaitingEdit} */
	const value = {};
	if (input.lines !== undefined) {
		if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_EDIT_LINES)
			return refuse('lines', `List 1–${MAX_EDIT_LINES} lines.`);
		/** @type {NonNullable<WaitingEdit['lines']>} */
		const lines = [];
		for (const [index, raw] of input.lines.entries()) {
			const line = objectOf(raw);
			const variantId = typeof line.variantId === 'string' ? line.variantId : '';
			if (!/^[A-Za-z0-9_-]{1,80}$/.test(variantId)) return refuse(`lines/${index}/variantId`, 'Name the item’s variant.');
			if (lines.some((other) => other.variantId === variantId))
				return refuse(`lines/${index}/variantId`, 'An item is listed twice.');
			const quantity = line.quantity;
			if (!Number.isSafeInteger(quantity) || Number(quantity) < 1 || Number(quantity) > MAX_MEASURED)
				return refuse(
					`lines/${index}/quantity`,
					'A quantity is a whole number from 1: pieces, or thousandths of the unit of a measured item.',
				);
			if (
				line.unitPrice !== undefined &&
				line.unitPrice !== null &&
				!(line.unitPrice === 0 || isPositiveAmount(line.unitPrice))
			)
				return refuse(`lines/${index}/unitPrice`, 'A unit price is a whole amount in minor units.');
			lines.push({
				variantId,
				quantity: Number(quantity),
				...(line.unitPrice === undefined || line.unitPrice === null ? {} : { unitPrice: Number(line.unitPrice) }),
			});
		}
		value.lines = lines;
	}
	if (input.paymentMethod !== undefined) {
		if (!isMethodKey(input.paymentMethod)) return refuse('paymentMethod', 'paymentMethod is a payment method key.');
		value.paymentMethod = /** @type {import('./model.js').PaymentMethod} */ (input.paymentMethod);
	}
	if (input.delivery !== undefined) {
		const raw = objectOf(input.delivery);
		const method = raw.method === 'delivery' || raw.method === 'pickup' ? raw.method : null;
		/** @param {'city' | 'area' | 'region' | 'postalCode' | 'country'} field */
		const text = (field) => (typeof raw[field] === 'string' ? String(raw[field]).trim().slice(0, ADDRESS_LIMITS[field]) : '');
		value.delivery = {
			method,
			// the zone's rate staff pick (E5; null = the first of the method)
			rate: typeof raw.rate === 'string' && /^[a-z][a-z0-9_]{1,39}$/.test(raw.rate) ? raw.rate : null,
			city: text('city'),
			area: text('area'),
			region: text('region'),
			postalCode: text('postalCode'),
			country: text('country'),
			locationId: typeof raw.locationId === 'string' && raw.locationId ? raw.locationId.slice(0, 64) : null,
		};
	}
	return { ok: true, value: Object.keys(value).length > 0 ? value : null };
};

/**
 * Check a change to a customer record: the block and its reason, the staff note, resetting returned packages,
 * customer field values (checked against the fields by the caller), the loyalty member flag (E47) and the tags (E11).
 * @param {unknown} body
 * @returns {{ ok: true, value: { blocked?: boolean, blockedReason?: string, note?: string, resetRto?: boolean,
 *   fields?: Record<string, unknown>, loyaltyMember?: boolean, tags?: string[] } } | Refusal}
 */
export const checkCustomerEdit = (body) => {
	const input = objectOf(body);
	/** @type {{ blocked?: boolean, blockedReason?: string, note?: string, resetRto?: boolean, fields?: Record<string, unknown>, loyaltyMember?: boolean, tags?: string[] }} */
	const value = {};
	if (input.blocked !== undefined) {
		if (typeof input.blocked !== 'boolean') return refuse('blocked', 'true or false.');
		value.blocked = input.blocked;
		const reason = typeof input.blockedReason === 'string' ? input.blockedReason.trim() : '';
		if (reason.length > 500) return refuse('blockedReason', 'At most 500 characters.');
		if (input.blocked && !reason) return refuse('blockedReason', 'Give the reason for blocking.');
		value.blockedReason = input.blocked ? reason : '';
	}
	if (input.note !== undefined) {
		if (typeof input.note !== 'string' || input.note.length > MAX_STAFF_NOTE)
			return refuse('note', `At most ${MAX_STAFF_NOTE} characters.`);
		value.note = input.note.trim();
	}
	if (input.resetRto !== undefined) {
		if (input.resetRto !== true) return refuse('resetRto', 'Send true to reset the count.');
		value.resetRto = true;
	}
	// the customer's tags (E11), all of them
	if (input.tags !== undefined) {
		const tags = checkTags(input.tags);
		if (!tags.ok) return refuse('tags', tags.message);
		value.tags = tags.value;
	}
	// the loyalty member flag (E47)
	if (input.loyaltyMember !== undefined) {
		if (typeof input.loyaltyMember !== 'boolean') return refuse('loyaltyMember', 'true or false.');
		value.loyaltyMember = input.loyaltyMember;
	}
	// customer field values (null clears one), checked against the fields by the caller
	if (input.fields !== undefined) {
		if (typeof input.fields !== 'object' || input.fields === null || Array.isArray(input.fields))
			return refuse('fields', 'Give the field values by field id.');
		value.fields = objectOf(input.fields);
	}
	if (Object.keys(value).length === 0) return refuse('blocked', 'Nothing to change.');
	return { ok: true, value };
};

/**
 * One order of a bulk move with what it takes (E28): its shipment, serial numbers and attachments (E20).
 * @typedef {{ id: string, shipment: ShipmentInput | null, serials: Record<string, UnitInput[]>,
 *   attachments?: import('./attachments.js').AttachmentInput[] }} BulkItem
 */

/**
 * Check a bulk move: `ids`, or `items` with each order's shipment, serial numbers and attachments.
 * @param {unknown} body
 * @returns {{ ok: true, value: { ids: string[], to: string, note: string, items: Map<string, BulkItem>,
 *   shopperNote?: string, restock?: boolean } } | Refusal}
 */
export const checkBulkMove = (body) => {
	const input = objectOf(body);
	const rawItems = Array.isArray(input.items) ? input.items : null;
	const ids = rawItems ? rawItems.map((item) => objectOf(item).id) : Array.isArray(input.ids) ? input.ids : null;
	const field = rawItems ? 'items' : 'ids';
	if (!ids || ids.length === 0 || ids.length > MAX_BULK) return refuse(field, `List 1–${MAX_BULK} order ids.`);
	if (!ids.every((id) => typeof id === 'string' && /^ord_[A-Za-z0-9_-]{1,64}$/.test(id)))
		return refuse(field, 'Unknown order id.');
	const move = checkMove({ to: input.to, note: input.note, shopperNote: input.shopperNote, restock: input.restock });
	if (!move.ok) return move;
	/** @type {Map<string, BulkItem>} */
	const items = new Map();
	for (const [index, raw] of (rawItems ?? []).entries()) {
		const item = objectOf(raw);
		const checked = checkMove({
			to: input.to,
			shipment: item.shipment,
			serials: item.serials,
			attachments: item.attachments,
		});
		if (!checked.ok) return refuse(`items/${index}/${checked.field}`, checked.message);
		const id = /** @type {string} */ (item.id);
		items.set(id, {
			id,
			shipment: checked.value.shipment,
			serials: checked.value.serials,
			...(checked.value.attachments ? { attachments: checked.value.attachments } : {}),
		});
	}
	return {
		ok: true,
		value: {
			ids: [.../** @type {Set<string>} */ (new Set(ids))],
			to: move.value.to,
			note: move.value.note,
			items,
			...(move.value.shopperNote ? { shopperNote: move.value.shopperNote } : {}),
			...(move.value.restock === undefined ? {} : { restock: move.value.restock }),
		},
	};
};

// ------------------------------------------------------------------------------------------------------- serials

/** The stages units may be needed by, in the order an order reaches them. @type {Readonly<Record<string, number>>} */
const UNIT_STAGE_RANK = Object.freeze({ packed: 1, shipped: 2, delivered: 3 });

/**
 * How a line's units are numbered, by product: when they get their numbers and the stage they are needed before
 * (`core/item-types.js`, the `units` element of the product's item type).
 * @typedef {ReadonlyMap<string, Pick<import('./item-types.js').UnitRules, 'capture' | 'requiredBefore'>>} LineUnitRules
 */

/**
 * The units of a line a move into `stage` needs: every one, when its item type needs them by then.
 * @param {Pick<import('./item-types.js').UnitRules, 'requiredBefore'>} rules @param {string} stage
 */
const neededBy = (rules, stage) =>
	rules.requiredBefore !== null && (UNIT_STAGE_RANK[rules.requiredBefore] ?? Infinity) <= (UNIT_STAGE_RANK[stage] ?? 0);

/**
 * The serial numbers each line whose item type numbers its units gets with a move into `stage` (packed, shipped or
 * delivered) or typed later: the ones sent, else the ones it already has; one per unit. Units picked from stock are
 * needed when the order is packed; typed ones (`capture: 'packing'`) may be typed at packing or later, so a line not
 * needed by `stage` may still have none (a list sent for a line still holds one per unit). `only` limits the plan to the
 * lines sent.
 * @param {OrderRecord} order
 * @param {LineUnitRules} rules the order's products whose units are numbered
 * @param {Record<string, string[]>} sent
 * @param {{ stage: string, only?: boolean }} options
 * @returns {{ ok: true, value: Array<{ lineId: string, productId: string, variantId: string, serials: string[], before: string[], capture: import('./item-types.js').UnitCapture }> } | Refusal}
 */
export const serialPlan = (order, rules, sent, { stage, only = false }) => {
	const lines = new Map(order.lines.map((line) => [line.id, line]));
	for (const lineId of Object.keys(sent)) {
		const line = lines.get(lineId);
		if (!line || line.kind !== 'physical' || !rules.has(line.productId))
			return refuse(`serials/${lineId}`, 'This line takes no serial numbers.');
	}
	/** @type {Array<{ lineId: string, productId: string, variantId: string, serials: string[], before: string[], capture: import('./item-types.js').UnitCapture }>} */
	const plan = [];
	for (const line of order.lines) {
		const units = line.kind === 'physical' ? rules.get(line.productId) : undefined;
		if (!units) continue;
		if (only && sent[line.id] === undefined) continue;
		const serials = sent[line.id] ?? line.serials;
		const later = serials.length === 0 && !neededBy(units, stage);
		if (serials.length !== line.quantity && !later)
			return refuse(`serials/${line.id}`, `${line.name}: give ${line.quantity} serial number(s), one per unit.`);
		plan.push({
			lineId: line.id,
			productId: line.productId,
			variantId: line.variantId,
			serials,
			before: line.serials,
			capture: units.capture,
		});
	}
	return { ok: true, value: plan };
};

/**
 * The lines of an order still missing serial numbers a move into `stage` needs (their item type needs them by then).
 * @param {OrderRecord} order
 * @param {LineUnitRules} rules
 * @param {string} stage
 */
export const missingSerials = (order, rules, stage) =>
	order.lines.filter((line) => {
		const units = line.kind === 'physical' ? rules.get(line.productId) : undefined;
		return units !== undefined && neededBy(units, stage) && line.serials.length !== line.quantity;
	});

// --------------------------------------------------------------------------------------------------------- views

/**
 * The name of a status (an unknown status shows its key).
 * @param {OrderFlow} flow
 * @param {string} key
 */
export const statusLabel = (flow, key) => statusOf(flow, key)?.label ?? key;

/**
 * An order in the staff list.
 * @param {OrderRecord} order
 * @param {OrderFlow} flow
 * @param {Money} money
 */
export const orderSummary = (order, flow, money) => ({
	id: order.id,
	number: order.number,
	status: order.status,
	statusLabel: statusLabel(flow, order.status),
	role: order.role,
	customer: { ...order.customer },
	city: order.address?.city ?? '',
	itemCount: order.lines.reduce((sum, line) => sum + piecesOf(line), 0),
	total: order.totals.total,
	totalText: money(order.totals.total, order.totals.currency),
	currency: order.totals.currency,
	payment: { method: order.payment.method, state: order.payment.state },
	shipment: order.shipment ? { courier: order.shipment.courier, trackingNumber: order.shipment.trackingNumber } : null,
	tags: order.tags ?? [],
	placedAt: wire(order.placedAt),
	createdAt: wire(order.createdAt),
	updatedAt: wire(order.updatedAt),
});

/**
 * Shop flags of the order's customer.
 * @typedef {{ blocked: boolean, blockedReason: string, rtoCount: number, orderCount: number, note: string,
 *   loyaltyMember: boolean }} CustomerFlags
 */

/**
 * @param {Partial<CustomerRecord> | null} customer
 * @returns {CustomerFlags}
 */
const customerFlags = (customer) => ({
	blocked: customer?.blocked === true,
	blockedReason: customer?.blockedReason ?? '',
	rtoCount: customer?.rtoCount ?? 0,
	orderCount: customer?.orderCount ?? 0,
	note: customer?.note ?? '',
	loyaltyMember: customer?.loyaltyMember === true,
});

/**
 * Members of an order record the staff view leaves out: what only the shopper's browser may know (the guest order's key
 * hash, the checkout's Idempotency-Key) and the search's own copy of the phone's digits.
 */
const LEFT_OUT = Object.freeze(['accessKeyHash', 'idempotencyKey', 'phoneDigits']);

/**
 * An order as staff see it: everything but the guest order's key hash and the checkout's Idempotency-Key (secrets of
 * the shopper's browser) and the search's phone digits, with status names, the statuses it may move to next and the
 * customer's flags.
 * @param {OrderRecord} order
 * @param {OrderFlow} flow
 * @param {{ customer: Partial<CustomerRecord> | null, images: Map<string, string | null>, money: Money,
 *   units?: { rules: ReadonlyMap<string, import('./item-types.js').UnitRules>,
 *   values: ReadonlyMap<string, Record<string, string[]>> }, orderFields?: ReadonlyArray<import('./model.js').AttributeRecord>,
 *   reasons?: { cancel: ReadonlyArray<import('./order-reasons.js').OrderReason>,
 *   failure: ReadonlyArray<import('./order-reasons.js').OrderReason> },
 *   attachmentKinds?: ReadonlyArray<import('./attachments.js').AttachmentKind> }} extras
 *   `images`: line id → address; `units`: how the units of the order's products are numbered (their item types), and
 *   the values of the order's units by serial; `orderFields`: the shop's order fields; `reasons`: the cancel and
 *   failed-delivery reasons (E19); `attachmentKinds`: the attachment kinds (E20)
 */
export const orderDetail = (
	order,
	flow,
	{ customer, images, money, units, orderFields = [], reasons = { cancel: [], failure: [] }, attachmentKinds = [] },
) => {
	const plain = Object.fromEntries(Object.entries(wire(order)).filter(([key]) => !LEFT_OUT.includes(key)));
	// what is due, can be refunded and must be refunded, counted the one way
	const sums = orderMoney(order);
	return {
		...plain,
		// what it holds or gave back (written by its transitions, else derived from its flags) and the refunds through
		// Payments a transition asked for
		facts: factsOf(order),
		effects: plain.effects ?? [],
		tags: order.tags ?? [],
		// its order field values by field id (staff see every one), and the fields staff fill (dynamic model §2)
		fields: order.fields ?? {},
		orderFields: orderFields
			.filter((field) => field.active || order.fields?.[field.id] !== undefined)
			.map((field) => fieldDefinition(field)),
		statusLabel: statusLabel(flow, order.status),
		// why it was canceled or came back, by the merchant's name (E19)
		closeReason: order.closeReason ?? null,
		// the kinds staff may add (E20)
		attachmentKinds: attachmentKinds.map((kind) => ({ key: kind.key, label: kind.label, type: kind.type })),
		// the attachments with their kind's name (E20)
		attachments: (order.attachments ?? []).map((attachment) => ({
			...attachment,
			at: new Date(attachment.at).toISOString(),
			label: attachmentKinds.find((kind) => kind.key === attachment.kind)?.label ?? attachment.kind,
		})),
		closeReasonLabel: order.closeReason
			? ([...reasons.cancel, ...reasons.failure].find((reason) => reason.key === order.closeReason)?.label ??
				order.closeReason)
			: null,
		totalText: money(order.totals.total, order.totals.currency),
		lines: plain.lines.map((/** @type {any} */ line) => {
			// how the line's units are numbered (its item type, dynamic model §1): when, before which stage, the unit fields
			// their numbers take, and each unit's values (§2)
			const rules = line.kind === 'physical' ? units?.rules.get(line.productId) : undefined;
			return {
				...line,
				imageUrl: images.get(line.id) ?? null,
				...(rules
					? {
							unitCapture: rules.capture,
							unitsRequiredBefore: rules.requiredBefore,
							unitFields: rules.fields.map((field) => ({
								id: field.id,
								name: field.name,
								required: field.required,
								maxValues: field.maxValues,
								format: field.format,
							})),
							units: (line.serials ?? []).map((/** @type {string} */ serial) => ({
								serial,
								values: units?.values.get(serial) ?? {},
							})),
						}
					: {}),
			};
		}),
		payment: { ...plain.payment, refundable: sums.refundable, balanceDue: sums.due, refundDue: sums.refundDue },
		history: plain.history.map((/** @type {any} */ entry) => ({
			...entry,
			fromLabel: entry.from ? statusLabel(flow, entry.from) : '',
			toLabel: statusLabel(flow, entry.to),
		})),
		customerFlags: customerFlags(customer),
		// the statuses staff may move it to, with what each move needs and its options (the widgets ask for them)
		nextStatuses: nextStatuses(flow, order.status, 'staff').map(({ key, label, role }) => {
			const move = /** @type {NonNullable<ReturnType<typeof moveOf>>} */ (moveOf(flow, order.status, key, 'staff'));
			// a cancel or a package that came back offers the merchant's reasons (E19)
			const offered = role === 'cancelled' ? reasons.cancel : role === 'returned_to_origin' ? reasons.failure : null;
			return {
				key,
				label,
				role,
				permission: move.permission,
				needs: move.needs,
				options: move.options,
				...(offered ? { reasons: offered.map((reason) => ({ key: reason.key, label: reason.label })) } : {}),
				// the attachments the move needs (their kinds required at that status, E20)
				attachments: attachmentKinds
					.filter((kind) => kind.requiredAt === key)
					.map((kind) => ({ kind: kind.key, label: kind.label, type: kind.type })),
			};
		}),
	};
};

/**
 * A field as the staff widgets fill it: what its values take, whether it is required (an order field: when), and
 * whether shoppers see it.
 * @param {import('./model.js').AttributeRecord} field
 */
export const fieldDefinition = (field) => ({
	id: field.id,
	name: field.name,
	type: field.type,
	choices: field.choices,
	unit: field.unit,
	min: field.min,
	max: field.max,
	decimals: field.decimals,
	dates: field.dates,
	multiple: field.multiple,
	maxValues: field.maxValues,
	format: field.format,
	required: field.required,
	requiredAt: field.requiredAt,
	shopper: field.show.shopper,
	active: field.active,
});

/**
 * Whether a customer reference is a customer id (`cus_…`, members and guests alike; K-6) rather than an Accounts user id.
 * @param {string} ref
 */
export const isCustomerId = (ref) => ref.startsWith(`${ID_PREFIX.customer}_`);

/**
 * Whose orders, points and spend a customer record holds: a member's by Accounts user id, a guest's by customer id.
 * @param {Partial<CustomerRecord>} customer
 * @returns {{ userId: string } | { customerId: string }}
 */
export const customerOwner = (customer) =>
	customer.userId ? { userId: customer.userId } : { customerId: String(customer.id ?? '') };

/**
 * The key a customer's spend is grouped under (`u:<user id>` for a member, `c:<customer id>` for a guest).
 * @param {Partial<CustomerRecord>} customer
 */
export const spentKey = (customer) => (customer.userId ? `u:${customer.userId}` : `c:${customer.id ?? ''}`);

/**
 * A customer as staff see it: `id` is the customer id (`cus_…`) the staff routes take for members and guests alike
 * (K-6), `guest` whether they have no Accounts user, `guestKey` what a guest is known by (`p:<E.164>` or `e:<email>`;
 * '' for a member).
 * @param {Partial<CustomerRecord> & { createdAt?: Date, updatedAt?: Date }} customer
 * @param {{ total: number, count: number }} spent what they paid (paid − refunded) over all their orders, and how many
 * @param {string} currency
 * @param {Money} money
 */
export const customerView = (customer, spent, currency, money) => ({
	id: customer.id ?? '',
	userId: customer.userId ?? '',
	guest: !customer.userId,
	guestKey: customer.userId ? '' : (customer.guestKey ?? ''),
	name: customer.name ?? '',
	email: customer.email ?? '',
	phone: customer.phone ?? '',
	city: customer.city ?? '',
	...customerFlags(customer),
	tags: customer.tags ?? [],
	totalSpent: spent.total,
	totalSpentText: money(spent.total, currency),
	ordersPlaced: spent.count,
	createdAt: customer.createdAt ? wire(customer.createdAt) : null,
	updatedAt: customer.updatedAt ? wire(customer.updatedAt) : null,
});

/**
 * A customer record as the person it is about gets it (data rights, SE-1): who they are and how often they ordered,
 * never what staff keep about them (the block and its reason, returned packages, the staff note, who opened it).
 * @param {Partial<CustomerRecord> & { createdAt?: Date }} customer
 */
export const customerOwnView = (customer) => ({
	id: customer.id ?? '',
	userId: customer.userId ?? '',
	guest: !customer.userId,
	name: customer.name ?? '',
	email: customer.email ?? '',
	phone: customer.phone ?? '',
	city: customer.city ?? '',
	orderCount: customer.orderCount ?? 0,
	lastOrderAt: customer.lastOrderAt ? wire(customer.lastOrderAt) : null,
	createdAt: customer.createdAt ? wire(customer.createdAt) : null,
});
