/**
 * Serial numbers (pure): the registry key of a serial under the merchant's format settings, and the serials an order
 * event carries. Serials arrive from the Orders product as events — any `orders.*@1` (or `order.*@1`) event whose data
 * has `orderId` and either `serials: [{ serial, itemId, variantId? }]` or `lines[].serials` (strings or objects).
 * @module
 */
import { isId, isObject } from './text.js';

/** Printable ASCII without spaces (after separators are removed). */
const PRINTABLE = /^[\x21-\x7e]+$/;

/**
 * @typedef {object} SerialFormat
 * @property {boolean} case_sensitive
 * @property {boolean} ignore_separators
 * @property {number} min_length
 * @property {number} max_length
 */

/**
 * The registry key of a serial, else null when it does not fit the format.
 * @param {unknown} raw
 * @param {SerialFormat} format
 * @returns {string | null}
 */
export const serialKey = (raw, format) => {
	if (typeof raw !== 'string' || raw.length > 256) return null;
	let key = raw.trim();
	if (format.ignore_separators) key = key.replace(/[\s-]+/g, '');
	if (!format.case_sensitive) key = key.toUpperCase();
	if (key.length < format.min_length || key.length > format.max_length || !PRINTABLE.test(key)) return null;
	return key;
};

/**
 * @typedef {{ serial: string, itemId: string, variantId: string | null }} EventSerial
 */

/**
 * @param {unknown} entry
 * @param {{ itemId?: unknown, variantId?: unknown }} [line]
 * @returns {EventSerial | null}
 */
const entryOf = (entry, line = {}) => {
	const value = isObject(entry) ? /** @type {Record<string, unknown>} */ (entry) : { serial: entry };
	const itemId = value.itemId ?? line.itemId;
	const variantId = value.variantId ?? line.variantId ?? null;
	if (typeof value.serial !== 'string' || !isId(itemId)) return null;
	return {
		serial: value.serial,
		itemId: /** @type {string} */ (itemId),
		variantId: isId(variantId) ? /** @type {string} */ (variantId) : null,
	};
};

/** Serials read from one event at most. */
const MAX_EVENT_SERIALS = 1000;

/**
 * Serials an order event carries (empty when none).
 * @param {unknown} data event data
 * @returns {EventSerial[]}
 */
export const serialsOfEvent = (data) => {
	if (!isObject(data)) return [];
	const record = /** @type {Record<string, unknown>} */ (data);
	/** @type {Array<EventSerial | null>} */
	const found = [];
	if (Array.isArray(record.serials)) for (const entry of record.serials) found.push(entryOf(entry));
	if (Array.isArray(record.lines))
		for (const line of record.lines)
			if (isObject(line) && Array.isArray(line.serials)) for (const entry of line.serials) found.push(entryOf(entry, line));
	return /** @type {EventSerial[]} */ (found.filter(Boolean)).slice(0, MAX_EVENT_SERIALS);
};
