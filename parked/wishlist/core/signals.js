/**
 * Price-drop and back-in-stock decisions (pure). A change (`price.changed@1` / `inventory.changed@1`, already parsed)
 * is matched against the entries of lists whose owner opted in, and grouped into one signal per customer. Wishlist
 * only decides and publishes; who is told, how and when is the business of Alerts or the merchant's messaging.
 * @module
 */
import { isObject, isRef, moneyOf } from './item.js';

/**
 * @typedef {import('./lists.js').Entry} Entry
 * @typedef {import('./item.js').Money} Money
 * @typedef {{ kind: 'price', itemId: string, variantId: string | null, price: Money, previousPrice: Money | null }} PriceChange
 * @typedef {{ kind: 'stock', itemId: string, variantId: string | null, locationId: string | null, available: number,
 *   previous: number | null }} StockChange
 * @typedef {{ id: string, ownerId: string, notify: boolean, items: Entry[] }} SignalList
 * @typedef {object} SignalSettings
 * @property {boolean} priceDrops
 * @property {boolean} backInStock
 * @property {number} minDropPercent
 * @property {number} minDropAmount
 * @property {number} cooldownHours
 * @property {number} inStockThreshold
 * @property {string[]} locations
 */

const HOUR_MS = 3_600_000;
const QUANTITY = 1_000_000_000;

/** @param {unknown} value */
const quantityOf = (value) => (Number.isSafeInteger(value) && Math.abs(/** @type {number} */ (value)) <= QUANTITY ? value : null);

/**
 * `price.changed@1` data → change (null when unusable).
 * @param {unknown} data
 * @returns {PriceChange | null}
 */
export const priceChangeOf = (data) => {
	if (!isObject(data) || !isRef(data.itemId)) return null;
	const price = moneyOf(data.price);
	if (!price) return null;
	const previous = moneyOf(data.previousPrice);
	return {
		kind: 'price',
		itemId: data.itemId,
		variantId: isRef(data.variantId) ? data.variantId : null,
		price,
		previousPrice: previous ?? null,
	};
};

/**
 * `inventory.changed@1` data → change: `available` wins over `quantity` (sellable vs on hand).
 * @param {unknown} data
 * @returns {StockChange | null}
 */
export const stockChangeOf = (data) => {
	if (!isObject(data) || !isRef(data.itemId)) return null;
	const available = /** @type {number | null} */ (quantityOf(data.available) ?? quantityOf(data.quantity));
	if (available === null) return null;
	const previous = /** @type {number | null} */ (quantityOf(data.previousAvailable) ?? quantityOf(data.previousQuantity));
	return {
		kind: 'stock',
		itemId: data.itemId,
		variantId: isRef(data.variantId) ? data.variantId : null,
		locationId: isRef(data.locationId) ? data.locationId : null,
		available,
		previous,
	};
};

/**
 * Whether an entry is about the changed item: a change of one variant touches that variant's entries and the item's
 * variant-less entries; a variant-less change touches every entry of the item.
 * @param {Entry} entry
 * @param {{ itemId: string, variantId: string | null }} change
 */
export const touches = (entry, { itemId, variantId }) =>
	entry.itemId === itemId && (variantId === null || entry.variantId === null || entry.variantId === variantId);

/**
 * The drop of a price against a reference, when it is big enough.
 * @param {{ reference: Money | null, price: Money, minPercent: number, minAmount: number }} input
 * @returns {{ dropped: boolean, percent: number }}
 */
export const dropOf = ({ reference, price, minPercent, minAmount }) => {
	if (!reference || reference.currency !== price.currency || reference.amount <= 0 || price.amount >= reference.amount)
		return { dropped: false, percent: 0 };
	const diff = reference.amount - price.amount;
	const percent = Math.floor((diff * 100) / reference.amount);
	return { dropped: diff >= Math.max(1, minAmount) && diff * 100 >= minPercent * reference.amount, percent };
};

/**
 * Whether the last signal of an entry is recent enough to stay quiet.
 * @param {Entry} entry
 * @param {number} now
 * @param {number} cooldownHours
 */
export const coolingDown = (entry, now, cooldownHours) =>
	typeof entry.signaledAt === 'string' && now - Date.parse(entry.signaledAt) < cooldownHours * HOUR_MS;

/**
 * Whether a stock change makes an item available again: below the threshold before (as reported, else as last known),
 * at or above it now.
 * @param {StockChange} change
 * @param {number | null} lastKnown last stored availability of the item, null when unknown
 * @param {number} threshold
 */
export const isRestock = (change, lastKnown, threshold) => {
	const before = change.previous ?? lastKnown;
	return before !== null && before < threshold && change.available >= threshold;
};

/**
 * @typedef {object} Signal one customer's signal for one change
 * @property {string} ownerId the customer subject
 * @property {string[]} listIds
 * @property {string[]} entryIds every touched entry (marked as signaled)
 * @property {Entry} entry the first touched entry (snapshot for the event)
 * @property {Money | null} reference the price the drop is measured against
 * @property {number} percent
 */

/**
 * Group the opted-in entries a change touches into one signal per customer; `decide` accepts an entry (with its
 * reference price and drop) or skips it.
 * @param {{ lists: readonly SignalList[], change: { itemId: string, variantId: string | null }, now: number,
 *   cooldownHours: number, decide: (entry: Entry) => { reference: Money | null, percent: number } | null }} input
 * @returns {Signal[]}
 */
const collect = ({ lists, change, now, cooldownHours, decide }) => {
	/** @type {Map<string, Signal>} */
	const byOwner = new Map();
	for (const list of lists) {
		if (!list.notify) continue;
		for (const entry of list.items) {
			if (!touches(entry, change) || coolingDown(entry, now, cooldownHours)) continue;
			const decision = decide(entry);
			if (!decision) continue;
			const signal = byOwner.get(list.ownerId);
			if (!signal)
				byOwner.set(list.ownerId, { ownerId: list.ownerId, listIds: [list.id], entryIds: [entry.id], entry, ...decision });
			else {
				if (!signal.listIds.includes(list.id)) signal.listIds.push(list.id);
				signal.entryIds.push(entry.id);
			}
		}
	}
	return [...byOwner.values()];
};

/**
 * Signals of a price change: one per customer, for opted-in lists whose entries dropped enough against the price the
 * customer saved (or was last told) and are not cooling down.
 * @param {{ lists: readonly SignalList[], change: PriceChange, settings: SignalSettings, now: number }} input
 * @returns {Signal[]}
 */
export const priceSignals = ({ lists, change, settings, now }) =>
	settings.priceDrops
		? collect({
				lists,
				change,
				now,
				cooldownHours: settings.cooldownHours,
				decide: (entry) => {
					const reference = entry.signalPrice ?? entry.savedPrice;
					const { dropped, percent } = dropOf({
						reference,
						price: change.price,
						minPercent: settings.minDropPercent,
						minAmount: settings.minDropAmount,
					});
					return dropped ? { reference, percent } : null;
				},
			})
		: [];

/**
 * Signals of a restock: one per customer, for opted-in lists with entries of the item that are not cooling down.
 * @param {{ lists: readonly SignalList[], change: StockChange, settings: SignalSettings, now: number }} input
 * @returns {Signal[]}
 */
export const stockSignals = ({ lists, change, settings, now }) =>
	settings.backInStock
		? collect({ lists, change, now, cooldownHours: settings.cooldownHours, decide: () => ({ reference: null, percent: 0 }) })
		: [];
