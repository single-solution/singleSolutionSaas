/**
 * Purchases (pure): what a customer bought and may claim against, from the standard order events or the purchases API.
 * Lines are keyed so the same item and variant always map to one line (`lineId`), whether they came from
 * `order.placed@1`, `order.completed@1` or the API. Any returnable thing fits: goods, rentals, services and
 * subscriptions differ only by `itemType`, which window rules can read.
 * @module
 */
import { isId, isKey, isObject, normalEmail, normalPhone } from './text.js';

/** Lines kept per purchase. */
export const MAX_LINES = 500;

/**
 * @typedef {object} PurchaseLine
 * @property {string} lineId
 * @property {string} itemId
 * @property {string | null} variantId
 * @property {string | null} sku
 * @property {string | null} title
 * @property {number} quantity
 * @property {number | null} unitAmount minor units in the purchase currency
 * @property {string | null} itemType
 * @property {string | null} grade
 * @property {number | null} warrantyDays snapshot of the line's own cover
 * @property {number} refundedQuantity units refunded outside claims (order.refunded@1 from elsewhere)
 */

/**
 * @typedef {object} CustomerRef identity reference (never a profile)
 * @property {string | null} customerId
 * @property {string | null} subject
 * @property {string | null} email
 * @property {string | null} phone
 * @property {string | null} name
 */

/** @param {unknown} value @param {number} max */
const text = (value, max) => (typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : null);
/** @param {unknown} value */
const count = (value) => (Number.isInteger(value) && /** @type {number} */ (value) > 0 ? /** @type {number} */ (value) : 0);
/** @param {unknown} value */
const amount = (value) => (Number.isInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : null);

/**
 * The line key of an item and variant.
 * @param {string} itemId
 * @param {string | null} variantId
 */
export const lineKeyOf = (itemId, variantId) => (variantId ? `${itemId}:${variantId}` : itemId).slice(0, 64);

/**
 * Normalised purchase lines; the same item + variant is merged into one line (quantities add up).
 * @param {unknown} raw
 * @returns {PurchaseLine[]}
 */
export const linesOf = (raw) => {
	/** @type {Map<string, PurchaseLine>} */
	const lines = new Map();
	for (const entry of Array.isArray(raw) ? raw.slice(0, MAX_LINES) : []) {
		if (!isObject(entry) || !isId(entry.itemId)) continue;
		const quantity = count(entry.quantity);
		if (quantity === 0) continue;
		const variantId = isId(entry.variantId) ? entry.variantId : null;
		const lineId = isId(entry.lineId) ? String(entry.lineId).slice(0, 64) : lineKeyOf(entry.itemId, variantId);
		const existing = lines.get(lineId);
		if (existing) {
			lines.set(lineId, { ...existing, quantity: existing.quantity + quantity });
			continue;
		}
		lines.set(lineId, {
			lineId,
			itemId: entry.itemId,
			variantId,
			sku: text(entry.sku, 100),
			title: text(entry.title, 300),
			quantity,
			unitAmount: amount(entry.unitAmount),
			itemType: isKey(entry.itemType) ? entry.itemType : null,
			grade: text(entry.grade, 40),
			warrantyDays: Number.isInteger(entry.warrantyDays) && entry.warrantyDays >= 0 ? entry.warrantyDays : null,
			refundedQuantity: 0,
		});
	}
	return [...lines.values()];
};

/**
 * The customer reference of an order event or purchase input (`customer` object and/or `customerId`).
 * @param {Record<string, unknown>} data
 * @returns {CustomerRef}
 */
export const customerOf = (data) => {
	const customer = isObject(data.customer) ? /** @type {Record<string, unknown>} */ (data.customer) : {};
	const customerId = isId(customer.customerId) ? customer.customerId : isId(data.customerId) ? data.customerId : null;
	return {
		customerId: /** @type {string | null} */ (customerId),
		subject: text(customer.subject, 255),
		email: normalEmail(customer.email),
		phone: normalPhone(customer.phone),
		name: text(customer.name, 120),
	};
};

/**
 * Keys a signed-in customer (`SS-Identity` subject) is matched on: the Graph customer id and the identity subject.
 * @param {CustomerRef} customer
 * @returns {string[]}
 */
export const customerKeysOf = (customer) =>
	[...new Set([customer.customerId, customer.subject].filter((key) => typeof key === 'string' && key.length > 0))].map(String);

/**
 * @typedef {object} OrderFacts
 * @property {string} orderId
 * @property {string | null} number
 * @property {CustomerRef} customer
 * @property {string | null} currency
 * @property {PurchaseLine[]} lines
 * @property {number | null} total
 */

/**
 * Facts of an order lifecycle event (`order.placed@1`, `order.completed@1`, … with the optional order context).
 * @param {unknown} data
 * @returns {OrderFacts | null} null without an order id
 */
export const orderFacts = (data) => {
	if (!isObject(data)) return null;
	const record = /** @type {Record<string, unknown>} */ (data);
	if (!isId(record.orderId)) return null;
	const amounts = isObject(record.amounts) ? /** @type {Record<string, unknown>} */ (record.amounts) : {};
	return {
		orderId: /** @type {string} */ (record.orderId),
		number: text(record.number, 64),
		customer: customerOf(record),
		currency: typeof record.currency === 'string' && /^[A-Z]{3}$/.test(record.currency) ? record.currency : null,
		lines: linesOf(record.lines),
		total: amount(amounts.total),
	};
};

/**
 * True when a customer reference has any identifier.
 * @param {CustomerRef} customer
 */
export const hasCustomer = (customer) => Object.values(customer).some((value) => value !== null);

/**
 * Merge a newer customer reference into the stored one (known values are never erased).
 * @param {CustomerRef | null | undefined} stored
 * @param {CustomerRef} incoming
 * @returns {CustomerRef}
 */
export const mergeCustomer = (stored, incoming) => {
	const base = stored ?? { customerId: null, subject: null, email: null, phone: null, name: null };
	return /** @type {CustomerRef} */ (
		Object.fromEntries(
			Object.entries(base).map(([key, value]) => [key, incoming[/** @type {keyof CustomerRef} */ (key)] ?? value]),
		)
	);
};

/**
 * Lines refunded outside after-sales (`order.refunded@1` lines) added to the purchase lines' refunded quantities.
 * @param {PurchaseLine[]} lines
 * @param {unknown} refunded event lines
 * @returns {PurchaseLine[]}
 */
export const withRefunded = (lines, refunded) => {
	const back = linesOf(refunded);
	return lines.map((line) => {
		const match = back.find((entry) => entry.itemId === line.itemId && (entry.variantId ?? null) === line.variantId);
		return match ? { ...line, refundedQuantity: Math.min(line.quantity, line.refundedQuantity + match.quantity) } : line;
	});
};

/**
 * Total of a purchase: the order total when known, else the sum of the lines with unit amounts.
 * @param {{ total: number | null, lines: PurchaseLine[] }} purchase
 */
export const purchaseTotal = (purchase) =>
	purchase.total ??
	(purchase.lines.every((line) => line.unitAmount !== null)
		? purchase.lines.reduce((sum, line) => sum + /** @type {number} */ (line.unitAmount) * line.quantity, 0)
		: null);
