/**
 * Orders for the merchant (PLAN 0.8.8), the pure part: the staff order list's filters, what staff send to move,
 * refund and edit an order (checked), serial numbers captured when packing, how much of a refund goes back through
 * Payments, and the order views staff see. Records are `core/model.js` shapes; times become ISO-8601 UTC on the wire;
 * amounts stay minor units, with a text (`totalText` …) made by the website's Format (PLAN 0.8.10 K7). No I/O.
 * @module
 */
import { nextStatuses, statusOf } from './flow.js';
import { STATUS_ROLES } from './model.js';
import { isAmount } from './money.js';
import { MAX_TRACKING, cleanTracking, hasControl } from './couriers.js';

/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {import('./model.js').OrderFlow} OrderFlow */
/** @typedef {import('./model.js').StatusRole} StatusRole */
/** @typedef {import('./model.js').CustomerRecord} CustomerRecord */
/** An amount as text, by the website's Format (`product.format(websiteId).money`). @typedef {(amount: number, currency: string) => string} Money */

/** Payment methods. */
export const PAYMENT_METHODS = Object.freeze(/** @type {const} */ (['cod', 'online', 'bank_transfer', 'pickup']));
/** Payment states. */
export const PAYMENT_STATES = Object.freeze(
	/** @type {const} */ (['unpaid', 'pending', 'paid', 'partially_refunded', 'refunded']),
);
/** Methods whose money is cash taken at the door or the counter. */
export const CASH_METHODS = Object.freeze(/** @type {ReadonlyArray<string>} */ (['cod', 'pickup']));
/** Roles in which an order's address may still change (before shipping). */
export const EDITABLE_ROLES = Object.freeze(
	/** @type {ReadonlyArray<StatusRole>} */ (['awaiting_payment', 'awaiting_confirmation', 'open', 'packed']),
);
/** Bulk moves take at most this many orders. */
const MAX_BULK = 200;
/** Longest note, staff note, search text and serial number. */
const MAX_NOTE = 1000;
const MAX_STAFF_NOTE = 5000;
export const MAX_SEARCH = 120;
const MAX_SERIAL = 80;
/** A booked shipment's status is asked again at most this often (on read). */
export const TRACK_EVERY_MS = 30 * 60_000;

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
 * The part of what was paid that went through Payments (online, bank transfer, a COD advance).
 * @param {OrderRecord} order
 */
const paidThroughPayments = (order) => {
	if (!order.payment.paymentId) return 0;
	return CASH_METHODS.includes(order.payment.method) ? Math.min(order.payment.advance, order.payment.paid) : order.payment.paid;
};

/**
 * What can still be refunded.
 * @param {OrderRecord} order
 */
export const refundable = (order) => Math.max(0, order.payment.paid - order.payment.refunded);

/**
 * How a refund is split: through Payments first (as long as Payments' share is not refunded yet), the rest recorded
 * as cash given back by hand.
 * @param {OrderRecord} order
 * @param {number} amount
 * @returns {{ online: number, manual: number }}
 */
export const refundSplit = (order, amount) => {
	const online = Math.min(amount, Math.max(0, paidThroughPayments(order) - order.payment.refunded));
	return { online, manual: amount - online };
};

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
 * @property {string} [status]
 * @property {StatusRole} [role]
 * @property {import('./model.js').PaymentState} [paymentState]
 * @property {import('./model.js').PaymentMethod} [paymentMethod]
 * @property {Date} [from] placed at or after
 * @property {Date} [to] placed before
 * @property {string} [q] number, name, phone, e-mail or city
 */

/** @param {unknown} value */
const dateOf = (value) => {
	if (typeof value !== 'string' || value === '' || value.length > 40) return null;
	const time = Date.parse(value);
	return Number.isNaN(time) ? null : new Date(time);
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
		typeof query[name] === 'string' && query[name] !== '' ? String(query[name]) : null;
	const status = text('status');
	if (status !== null) {
		if (!/^[a-z][a-z0-9_]{1,39}$/.test(status)) return refuse('status', 'Unknown status.');
		value.status = status;
	}
	const role = text('role');
	if (role !== null) {
		if (!(/** @type {readonly string[]} */ (STATUS_ROLES).includes(role))) return refuse('role', 'Unknown role.');
		value.role = /** @type {StatusRole} */ (role);
	}
	const paymentState = text('paymentState');
	if (paymentState !== null) {
		if (!(/** @type {readonly string[]} */ (PAYMENT_STATES).includes(paymentState)))
			return refuse('paymentState', 'Unknown payment state.');
		value.paymentState = /** @type {import('./model.js').PaymentState} */ (paymentState);
	}
	const paymentMethod = text('paymentMethod');
	if (paymentMethod !== null) {
		if (!(/** @type {readonly string[]} */ (PAYMENT_METHODS).includes(paymentMethod)))
			return refuse('paymentMethod', 'Unknown payment method.');
		value.paymentMethod = /** @type {import('./model.js').PaymentMethod} */ (paymentMethod);
	}
	for (const name of /** @type {const} */ (['from', 'to'])) {
		const raw = text(name);
		if (raw === null) continue;
		const date = dateOf(raw);
		if (!date) return refuse(name, 'Use an ISO-8601 date.');
		value[name] = date;
	}
	const q = text('q')?.trim() ?? '';
	if (q.length > MAX_SEARCH) return refuse('q', `Search for at most ${MAX_SEARCH} characters.`);
	if (q) value.q = q;
	return { ok: true, value };
};

/**
 * The database filter of the order list (without `websiteId` and the page).
 * @param {OrderFilters} filters
 * @returns {Record<string, unknown>}
 */
export const orderQuery = (filters) => {
	/** @type {Record<string, unknown>} */
	const query = {};
	if (filters.status) query.status = filters.status;
	if (filters.role) query.role = filters.role;
	if (filters.paymentState) query['payment.state'] = filters.paymentState;
	if (filters.paymentMethod) query['payment.method'] = filters.paymentMethod;
	if (filters.from || filters.to)
		query.placedAt = { ...(filters.from ? { $gte: filters.from } : {}), ...(filters.to ? { $lt: filters.to } : {}) };
	if (filters.q) {
		const term = escapeRegex(filters.q);
		const digits = filters.q.replace(/\D/g, '');
		query.$or = [
			{ number: { $regex: `^${term}`, $options: 'i' } },
			{ 'customer.name': { $regex: term, $options: 'i' } },
			{ 'customer.email': { $regex: `^${term}`, $options: 'i' } },
			{ 'address.name': { $regex: term, $options: 'i' } },
			{ 'address.city': { $regex: `^${term}`, $options: 'i' } },
			...(digits.length >= 4
				? [{ 'customer.phone': { $regex: escapeRegex(digits) } }, { 'address.phone': { $regex: escapeRegex(digits) } }]
				: []),
		];
	}
	return query;
};

/**
 * @typedef {{ courier: string, trackingNumber: string } | { book: true, courier?: string }} ShipmentInput
 * @typedef {{ to: string, note: string, serials: Record<string, string[]>, shipment: ShipmentInput | null,
 *   updatedAt: string | null }} MoveInput
 */

/**
 * Check a move.
 * @param {unknown} body
 * @returns {{ ok: true, value: MoveInput } | Refusal}
 */
export const checkMove = (body) => {
	const input = objectOf(body);
	const to = typeof input.to === 'string' ? input.to : '';
	if (!/^[a-z][a-z0-9_]{1,39}$/.test(to)) return refuse('to', 'Name the status to move to.');
	const note = input.note === undefined || input.note === null ? '' : input.note;
	if (typeof note !== 'string' || note.length > MAX_NOTE) return refuse('note', `A note has at most ${MAX_NOTE} characters.`);
	/** @type {Record<string, string[]>} */
	const serials = {};
	if (input.serials !== undefined && input.serials !== null) {
		const raw = input.serials;
		if (typeof raw !== 'object' || Array.isArray(raw)) return refuse('serials', 'Serials are listed per order line.');
		for (const [lineId, list] of Object.entries(objectOf(raw))) {
			if (!Array.isArray(list) || list.length > 1000)
				return refuse(`serials/${lineId}`, 'A list of serial numbers is expected.');
			const clean = list.map((serial) => (typeof serial === 'string' ? serial.trim() : ''));
			if (clean.some((serial) => serial === '' || serial.length > MAX_SERIAL || hasControl(serial)))
				return refuse(`serials/${lineId}`, `Serial numbers have 1–${MAX_SERIAL} characters.`);
			if (new Set(clean).size !== clean.length) return refuse(`serials/${lineId}`, 'A serial number is listed twice.');
			serials[lineId] = clean;
		}
		const all = Object.values(serials).flat();
		if (new Set(all).size !== all.length) return refuse('serials', 'A serial number is listed on two lines.');
	}
	/** @type {ShipmentInput | null} */
	let shipment = null;
	if (input.shipment !== undefined && input.shipment !== null) {
		const raw = objectOf(input.shipment);
		const courier = typeof raw.courier === 'string' ? raw.courier.trim() : '';
		if (raw.book === true) shipment = courier ? { book: true, courier } : { book: true };
		else {
			const trackingNumber = cleanTracking(raw.trackingNumber);
			if (!courier) return refuse('shipment/courier', 'Pick a courier.');
			if (!trackingNumber) return refuse('shipment/trackingNumber', `A tracking number has 1–${MAX_TRACKING} characters.`);
			shipment = { courier, trackingNumber };
		}
	}
	const updatedAt = typeof input.updatedAt === 'string' && input.updatedAt !== '' ? input.updatedAt : null;
	return { ok: true, value: { to, note: note.trim(), serials, shipment, updatedAt } };
};

/**
 * Check a refund without a status change.
 * @param {unknown} body
 * @param {OrderRecord} order
 * @returns {{ ok: true, value: { amount: number, reason: string } } | Refusal}
 */
export const checkRefund = (body, order) => {
	const input = objectOf(body);
	const left = refundable(order);
	if (left <= 0) return refuse('amount', 'Nothing paid is left to refund.');
	if (!isAmount(input.amount) || /** @type {number} */ (input.amount) > left)
		return refuse('amount', `Refund a whole amount in minor units from 1 to ${left}.`);
	const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
	if (!reason || reason.length > 500) return refuse('reason', 'Give a reason of at most 500 characters.');
	return { ok: true, value: { amount: /** @type {number} */ (input.amount), reason } };
};

/** Address fields and their longest length. */
const ADDRESS_FIELDS = Object.freeze({
	name: 120,
	phone: 40,
	line1: 200,
	line2: 200,
	city: 100,
	area: 100,
	postalCode: 20,
	country: 60,
	notes: 500,
});

/**
 * Check an edit staff make to an order: the staff note, and the delivery address before shipping.
 * @param {unknown} body
 * @param {OrderRecord} order
 * @returns {{ ok: true, value: { staffNote?: string, address?: NonNullable<OrderRecord['address']> } } | Refusal}
 */
export const checkEdit = (body, order) => {
	const input = objectOf(body);
	/** @type {{ staffNote?: string, address?: NonNullable<OrderRecord['address']> }} */
	const value = {};
	if (input.staffNote !== undefined) {
		if (typeof input.staffNote !== 'string' || input.staffNote.length > MAX_STAFF_NOTE)
			return refuse('staffNote', `The staff note has at most ${MAX_STAFF_NOTE} characters.`);
		value.staffNote = input.staffNote.trim();
	}
	if (input.address !== undefined) {
		if (!order.address) return refuse('address', 'This order has no delivery address.');
		if (!EDITABLE_ROLES.includes(order.role)) return refuse('address', 'The address cannot change once the order is shipped.');
		const raw = objectOf(input.address);
		/** @type {Record<string, string>} */
		const address = { ...order.address };
		for (const [field, max] of Object.entries(ADDRESS_FIELDS)) {
			if (raw[field] === undefined) continue;
			if (typeof raw[field] !== 'string' || String(raw[field]).length > max)
				return refuse(`address/${field}`, `At most ${max} characters.`);
			address[field] = String(raw[field]).trim();
		}
		for (const field of ['name', 'phone', 'line1', 'city'])
			if (!address[field]) return refuse(`address/${field}`, 'This field is required.');
		value.address = /** @type {NonNullable<OrderRecord['address']>} */ (/** @type {unknown} */ (address));
	}
	if (value.staffNote === undefined && value.address === undefined)
		return refuse('staffNote', 'Send a staff note or an address.');
	return { ok: true, value };
};

/**
 * Check a change to a customer record.
 * @param {unknown} body
 * @returns {{ ok: true, value: { blocked?: boolean, blockedReason?: string, note?: string, resetRto?: boolean } } | Refusal}
 */
export const checkCustomerEdit = (body) => {
	const input = objectOf(body);
	/** @type {{ blocked?: boolean, blockedReason?: string, note?: string, resetRto?: boolean }} */
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
	if (Object.keys(value).length === 0) return refuse('blocked', 'Nothing to change.');
	return { ok: true, value };
};

/**
 * Check a bulk move.
 * @param {unknown} body
 * @returns {{ ok: true, value: { ids: string[], to: string, note: string } } | Refusal}
 */
export const checkBulkMove = (body) => {
	const input = objectOf(body);
	const ids = Array.isArray(input.ids) ? input.ids : null;
	if (!ids || ids.length === 0 || ids.length > MAX_BULK) return refuse('ids', `List 1–${MAX_BULK} order ids.`);
	if (!ids.every((id) => typeof id === 'string' && /^ord_[A-Za-z0-9_-]{1,64}$/.test(id)))
		return refuse('ids', 'Unknown order id.');
	const move = checkMove({ to: input.to, note: input.note });
	if (!move.ok) return move;
	return { ok: true, value: { ids: [.../** @type {Set<string>} */ (new Set(ids))], to: move.value.to, note: move.value.note } };
};

// ------------------------------------------------------------------------------------------------------- serials

/**
 * The serial numbers each serialized line gets when its order is packed: the ones sent, else the ones it already has;
 * one per unit.
 * @param {OrderRecord} order
 * @param {Set<string>} serializedProducts ids of the order's products that are serialized
 * @param {Record<string, string[]>} sent
 * @returns {{ ok: true, value: Array<{ lineId: string, productId: string, variantId: string, serials: string[], before: string[] }> } | Refusal}
 */
export const serialPlan = (order, serializedProducts, sent) => {
	const lines = new Map(order.lines.map((line) => [line.id, line]));
	for (const lineId of Object.keys(sent)) {
		const line = lines.get(lineId);
		if (!line || line.kind !== 'physical' || !serializedProducts.has(line.productId))
			return refuse(`serials/${lineId}`, 'This line takes no serial numbers.');
	}
	/** @type {Array<{ lineId: string, productId: string, variantId: string, serials: string[], before: string[] }>} */
	const plan = [];
	for (const line of order.lines) {
		if (line.kind !== 'physical' || !serializedProducts.has(line.productId)) continue;
		const serials = sent[line.id] ?? line.serials;
		if (serials.length !== line.quantity)
			return refuse(`serials/${line.id}`, `${line.name}: give ${line.quantity} serial number(s), one per unit.`);
		plan.push({ lineId: line.id, productId: line.productId, variantId: line.variantId, serials, before: line.serials });
	}
	return { ok: true, value: plan };
};

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
	itemCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
	total: order.totals.total,
	totalText: money(order.totals.total, order.totals.currency),
	currency: order.totals.currency,
	payment: { method: order.payment.method, state: order.payment.state },
	shipment: order.shipment ? { courier: order.shipment.courier, trackingNumber: order.shipment.trackingNumber } : null,
	placedAt: wire(order.placedAt),
	createdAt: wire(order.createdAt),
	updatedAt: wire(order.updatedAt),
});

/**
 * Shop flags of the order's customer.
 * @typedef {{ blocked: boolean, blockedReason: string, rtoCount: number, orderCount: number, note: string }} CustomerFlags
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
});

/**
 * An order as staff see it: everything, with status names, the statuses it may move to next and the customer's flags.
 * @param {OrderRecord} order
 * @param {OrderFlow} flow
 * @param {{ customer: Partial<CustomerRecord> | null, images: Map<string, string | null>, money: Money }} extras
 *   `images`: line id → address
 */
export const orderDetail = (order, flow, { customer, images, money }) => {
	const plain = wire(order);
	return {
		...plain,
		statusLabel: statusLabel(flow, order.status),
		totalText: money(order.totals.total, order.totals.currency),
		lines: plain.lines.map((/** @type {any} */ line) => ({ ...line, imageUrl: images.get(line.id) ?? null })),
		payment: { ...plain.payment, refundable: refundable(order) },
		history: plain.history.map((/** @type {any} */ entry) => ({
			...entry,
			fromLabel: entry.from ? statusLabel(flow, entry.from) : '',
			toLabel: statusLabel(flow, entry.to),
		})),
		customerFlags: customerFlags(customer),
		nextStatuses: nextStatuses(flow, order.status).map(({ key, label, role }) => ({ key, label, role })),
	};
};

/**
 * A customer as staff see it.
 * @param {Partial<CustomerRecord> & { createdAt?: Date, updatedAt?: Date }} customer
 * @param {{ total: number, count: number }} spent orders that were not cancelled
 * @param {string} currency
 * @param {Money} money
 */
export const customerView = (customer, spent, currency, money) => ({
	userId: customer.userId ?? '',
	name: customer.name ?? '',
	email: customer.email ?? '',
	phone: customer.phone ?? '',
	...customerFlags(customer),
	totalSpent: spent.total,
	totalSpentText: money(spent.total, currency),
	ordersPlaced: spent.count,
	createdAt: customer.createdAt ? wire(customer.createdAt) : null,
	updatedAt: customer.updatedAt ? wire(customer.updatedAt) : null,
});
