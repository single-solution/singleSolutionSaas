/**
 * Orders as review sources (pure): who bought what, from the standard order events (`@ss/contracts` v1). The customer
 * of an order is an identity reference — the website's own identity subject and/or the Graph customer id — and a review
 * is verified when the submitting customer matches either. Contact details are kept only to send review requests.
 * @module
 */
import { isObject } from './validate.js';

/**
 * @typedef {object} OrderLine
 * @property {string} itemId
 * @property {string | null} variantId
 * @property {string | null} title
 * @property {string | null} sku
 */

/**
 * @typedef {object} OrderFacts
 * @property {string} orderId
 * @property {string | null} number
 * @property {string | null} customerId primary customer key (identity subject, else Graph id)
 * @property {string[]} customerKeys every key the customer may present (subject, Graph id)
 * @property {{ name: string | null, email: string | null, phone: string | null }} contact
 * @property {OrderLine[]} lines unique items, first occurrence wins
 */

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Unique items of order lines (first occurrence wins), capped.
 * @param {unknown} lines
 * @param {number} [max]
 * @returns {OrderLine[]}
 */
export const uniqueLines = (lines, max = 100) => {
	/** @type {OrderLine[]} */
	const out = [];
	for (const line of Array.isArray(lines) ? lines : []) {
		if (!isObject(line) || typeof line.itemId !== 'string' || out.some((l) => l.itemId === line.itemId)) continue;
		out.push({ itemId: line.itemId, variantId: str(line.variantId), title: str(line.title), sku: str(line.sku) });
		if (out.length >= max) break;
	}
	return out;
};

/**
 * Facts of an order event's data (`order.placed@1` / `order.completed@1` / API request input), merged over a
 * previously stored snapshot (the newer event wins field by field; lines only when it carries them).
 * @param {Record<string, unknown>} data
 * @param {{ actorId?: string | null, previous?: OrderFacts | null }} [options] `actorId`: the envelope's customer actor
 * @returns {OrderFacts}
 */
export const orderFacts = (data, { actorId = null, previous = null } = {}) => {
	const customer = isObject(data.customer) ? data.customer : {};
	const contact = isObject(data.contact) ? data.contact : {};
	const subject = str(customer.subject);
	const graphId = str(customer.customerId) ?? str(data.customerId);
	const keys = [subject, graphId, actorId].filter((key) => key !== null);
	const customerKeys = [...new Set([...keys, ...(previous?.customerKeys ?? [])])];
	const lines = uniqueLines(data.lines ?? data.items);
	return {
		orderId: /** @type {string} */ (data.orderId),
		number: str(data.number) ?? previous?.number ?? null,
		customerId: keys[0] ?? previous?.customerId ?? null,
		customerKeys,
		contact: {
			name: str(contact.name) ?? previous?.contact.name ?? null,
			email: str(customer.email) ?? str(contact.email) ?? previous?.contact.email ?? null,
			phone: str(customer.phone) ?? str(contact.phone) ?? previous?.contact.phone ?? null,
		},
		lines: lines.length > 0 ? lines : (previous?.lines ?? []),
	};
};
