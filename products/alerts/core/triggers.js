/**
 * Triggers (pure): every source of change — `inventory.changed@1`, `price.changed@1`, `custom.*` events from the Event
 * Hub, `POST /v1/triggers` and CSV imports — is normalised into one `Change`, then folded into the product's last known
 * state of the target (`items`), which yields the before → after pair the type rules decide on (port of the
 * ibrahimMobiles before/after variant snapshot). Stock is tracked per location and summed over the tracked locations
 * (all when none are configured); a change older than the last one seen for that location is stale.
 * @module
 */
import { availableFrom, isId, isMoney } from './types.js';

/** Location key of changes that name none. */
export const ANY_LOCATION = '_';

/**
 * @typedef {object} Change
 * @property {'inventory' | 'price' | 'custom'} kind
 * @property {import('./types.js').Target} target
 * @property {string | null} [locationId]
 * @property {number} [quantity]
 * @property {number} [previousQuantity]
 * @property {import('./types.js').Money} [price]
 * @property {import('./types.js').Money} [previousPrice]
 * @property {string} [eventType] custom event type (`custom.<name>@<v>`)
 * @property {Record<string, unknown>} [data] custom event data
 * @property {{ name?: string, url?: string }} [item] display details of the target
 * @property {number} at occurred-at instant (ms)
 */

/**
 * @typedef {object} ItemState the product's view of a target (collection `items`)
 * @property {Record<string, { quantity: number, at: number }>} locations
 * @property {import('./types.js').Money | null} price
 * @property {number} priceAt
 */

/** @param {unknown} value */
const isInteger = (value) => Number.isSafeInteger(value);

/**
 * Target of an event / API payload (`itemId` required, `variantId` optional).
 * @param {Record<string, unknown>} data
 * @returns {import('./types.js').Target | null}
 */
export const targetOf = (data) => {
	if (!isId(data.itemId)) return null;
	if (data.variantId !== undefined && data.variantId !== null && !isId(data.variantId)) return null;
	return isId(data.variantId) ? { itemId: data.itemId, variantId: data.variantId } : { itemId: data.itemId };
};

/**
 * `inventory.changed@1` data → change.
 * @param {Record<string, any>} data
 * @param {number} at
 * @returns {Change | null}
 */
export const fromInventory = (data, at) => {
	const target = targetOf(data);
	if (!target || !isInteger(data.quantity)) return null;
	return {
		kind: 'inventory',
		target,
		locationId: isId(data.locationId) ? data.locationId : null,
		quantity: data.quantity,
		...(isInteger(data.previousQuantity) ? { previousQuantity: data.previousQuantity } : {}),
		at,
	};
};

/**
 * `price.changed@1` data → change (`priceListId` other than the tracked ones is ignored by the caller).
 * @param {Record<string, any>} data
 * @param {number} at
 * @returns {Change | null}
 */
export const fromPrice = (data, at) => {
	const target = targetOf(data);
	if (!target || !isMoney(data.price)) return null;
	return {
		kind: 'price',
		target,
		price: { amount: data.price.amount, currency: data.price.currency },
		...(isMoney(data.previousPrice)
			? { previousPrice: { amount: data.previousPrice.amount, currency: data.previousPrice.currency } }
			: {}),
		at,
	};
};

/**
 * Empty state of a target never seen before.
 * @returns {ItemState}
 */
export const emptyItem = () => ({ locations: {}, price: null, priceAt: 0 });

/**
 * Sum of the tracked locations (undefined when none is known).
 * @param {Record<string, { quantity: number }>} locations
 * @param {readonly string[]} tracked empty = every location
 * @returns {number | undefined}
 */
const totalOf = (locations, tracked) => {
	const keys = Object.keys(locations).filter((key) => tracked.length === 0 || tracked.includes(key) || key === ANY_LOCATION);
	return keys.length === 0 ? undefined : keys.reduce((sum, key) => sum + (locations[key]?.quantity ?? 0), 0);
};

/**
 * @param {ItemState} state
 * @param {{ threshold: number, locations: readonly string[] }} options
 * @returns {import('./types.js').TargetState}
 */
export const stateOf = (state, { threshold, locations }) => {
	const quantity = totalOf(state.locations, locations);
	return {
		...(quantity === undefined ? {} : { quantity, available: availableFrom(quantity, threshold) }),
		...(state.price ? { price: state.price } : {}),
	};
};

/**
 * Fold a change into the target's state.
 * @param {ItemState | null} stored
 * @param {Change} change
 * @param {{ threshold: number, locations: readonly string[], ignoreOutOfOrder: boolean }} options
 * @returns {{ ok: true, before: import('./types.js').TargetState, after: import('./types.js').TargetState, next: ItemState }
 *   | { ok: false, reason: 'stale' | 'untracked_location' }}
 */
export const applyChange = (stored, change, { threshold, locations, ignoreOutOfOrder }) => {
	const current = stored ?? emptyItem();
	if (change.kind === 'inventory') {
		const location = change.locationId ?? ANY_LOCATION;
		if (locations.length > 0 && location !== ANY_LOCATION && !locations.includes(location))
			return { ok: false, reason: 'untracked_location' };
		const known = current.locations[location];
		if (ignoreOutOfOrder && known && change.at < known.at) return { ok: false, reason: 'stale' };
		const previous = known
			? current.locations
			: change.previousQuantity === undefined
				? current.locations
				: { ...current.locations, [location]: { quantity: change.previousQuantity, at: change.at } };
		const next = {
			...current,
			locations: { ...current.locations, [location]: { quantity: /** @type {number} */ (change.quantity), at: change.at } },
		};
		const beforeState = { ...current, locations: previous };
		return {
			ok: true,
			before: stateOf(beforeState, { threshold, locations }),
			after: stateOf(next, { threshold, locations }),
			next,
		};
	}
	if (change.kind === 'price') {
		if (ignoreOutOfOrder && current.price && change.at < current.priceAt) return { ok: false, reason: 'stale' };
		const previousPrice = current.price ?? change.previousPrice ?? null;
		const next = { ...current, price: /** @type {import('./types.js').Money} */ (change.price), priceAt: change.at };
		return {
			ok: true,
			before: stateOf({ ...current, price: previousPrice }, { threshold, locations }),
			after: stateOf(next, { threshold, locations }),
			next,
		};
	}
	const state = stateOf(current, { threshold, locations });
	return { ok: true, before: state, after: state, next: current };
};

/**
 * Parse CSV text (RFC 4180: quoted fields, `""` escapes, CRLF or LF). The first row is the header.
 * @param {string} text
 * @param {{ maxRows: number }} limits
 * @returns {{ ok: true, header: string[], rows: string[][] } | { ok: false, code: 'csv_empty' | 'csv_too_many_rows' | 'csv_malformed' }}
 */
export const parseCsv = (text, { maxRows }) => {
	/** @type {string[][]} */
	const records = [];
	/** @type {string[]} */
	let record = [];
	let field = '';
	let quoted = false;
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (quoted) {
			if (char === '"' && text[index + 1] === '"') {
				field += '"';
				index += 2;
				continue;
			}
			if (char === '"') quoted = false;
			else field += char;
			index += 1;
			continue;
		}
		if (char === '"') {
			if (field.length > 0) return { ok: false, code: 'csv_malformed' };
			quoted = true;
		} else if (char === ',') {
			record.push(field);
			field = '';
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && text[index + 1] === '\n') index += 1;
			record.push(field);
			if (record.some((value) => value.length > 0)) records.push(record);
			record = [];
			field = '';
			if (records.length > maxRows + 1) return { ok: false, code: 'csv_too_many_rows' };
		} else field += char;
		index += 1;
	}
	if (quoted) return { ok: false, code: 'csv_malformed' };
	record.push(field);
	if (record.some((value) => value.length > 0)) records.push(record);
	const [header, ...rows] = records;
	if (!header || rows.length === 0) return { ok: false, code: 'csv_empty' };
	if (rows.length > maxRows) return { ok: false, code: 'csv_too_many_rows' };
	return { ok: true, header: header.map((name) => name.trim().toLowerCase()), rows };
};

/** CSV columns of a trigger import. */
export const CSV_COLUMNS = Object.freeze([
	'kind',
	'item_id',
	'variant_id',
	'location_id',
	'quantity',
	'previous_quantity',
	'price',
	'previous_price',
	'currency',
	'item_name',
	'item_url',
]);

/**
 * One CSV row → the `POST /v1/triggers` body it stands for.
 * @param {string[]} header
 * @param {string[]} row
 * @returns {Record<string, unknown>}
 */
export const csvRowToInput = (header, row) => {
	/** @type {Record<string, string>} */
	const cells = {};
	for (const [index, name] of header.entries()) if (CSV_COLUMNS.includes(name)) cells[name] = (row[index] ?? '').trim();
	const integer = (/** @type {string | undefined} */ value) => (value && /^-?\d+$/.test(value) ? Number(value) : undefined);
	const currency = (cells.currency ?? '').toUpperCase();
	const money = (/** @type {string | undefined} */ value) => {
		const amount = integer(value);
		return amount === undefined ? undefined : { amount, currency };
	};
	return Object.fromEntries(
		Object.entries({
			kind: cells.kind || (cells.price ? 'price' : 'inventory'),
			itemId: cells.item_id || undefined,
			variantId: cells.variant_id || undefined,
			locationId: cells.location_id || undefined,
			quantity: integer(cells.quantity),
			previousQuantity: integer(cells.previous_quantity),
			price: money(cells.price),
			previousPrice: money(cells.previous_price),
			item:
				cells.item_name || cells.item_url
					? { name: cells.item_name || undefined, url: cells.item_url || undefined }
					: undefined,
		}).filter(([, value]) => value !== undefined),
	);
};
