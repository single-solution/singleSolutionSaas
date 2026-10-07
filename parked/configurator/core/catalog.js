/**
 * Optional catalog link (pure). A website that runs a catalog (ours or its own) publishes `item.created@1`,
 * `item.updated@1`, `item.deleted@1` and `inventory.changed@1`; the product keeps a snapshot per item in the merchant's
 * database and a catalog-linked configurator takes its options (the attribute pools of the variants), combinations,
 * prices and stock from it — the PDP variant matrix, generalised. Standalone configurators never need any of this.
 *
 * Out-of-order deliveries are harmless: a snapshot or stock figure older than the one stored is ignored.
 * @module
 */
import { LIMITS } from './limits.js';

/**
 * @typedef {object} CatalogVariant
 * @property {string} variantId
 * @property {string | null} sku
 * @property {string | null} title
 * @property {Record<string, unknown>} attributes
 * @property {number | null} price integer minor units in the item currency
 * @property {number | null} inventory from the snapshot (inventory.changed figures win)
 */
/** @typedef {{ key: string, location: string, quantity: number, at: string }} StockFigure key: variant id, `sku:<sku>` or `*` (the item); location `*` = none */
/**
 * @typedef {object} CatalogItem
 * @property {string} itemId
 * @property {string | null} title
 * @property {string | null} status draft | active | archived
 * @property {string | null} currency
 * @property {CatalogVariant[]} variants
 * @property {StockFigure[]} stock inventory.changed figures (a list, so ids never become database field names)
 * @property {string | null} snapshotAt occurredAt of the snapshot
 * @property {boolean} deleted
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value */
const intOrNull = (value) => (Number.isSafeInteger(value) ? /** @type {number} */ (value) : null);
/** @param {unknown} value */
const textOrNull = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
/** @param {string | null} a @param {string} b true when a is strictly after b */
const after = (a, b) => a !== null && Date.parse(a) > Date.parse(b);

/**
 * An empty item (stock may arrive before the item itself).
 * @param {string} itemId
 * @returns {CatalogItem}
 */
export const emptyItem = (itemId) => ({
	itemId,
	title: null,
	status: null,
	currency: null,
	variants: [],
	stock: [],
	snapshotAt: null,
	deleted: false,
});

/**
 * Apply `item.created@1` / `item.updated@1` data (fields present replace the stored ones; `variants` replaces the list).
 * @param {CatalogItem | null} previous
 * @param {Record<string, any>} data
 * @param {string} occurredAt ISO timestamp of the event
 * @returns {CatalogItem}
 */
export const applyItem = (previous, data, occurredAt) => {
	const base = previous ?? emptyItem(String(data.itemId));
	if (after(base.snapshotAt, occurredAt)) return base;
	const variants = Array.isArray(data.variants)
		? data.variants
				.filter((variant) => isObject(variant) && typeof variant.variantId === 'string')
				.slice(0, LIMITS.combinations)
				.map((variant) => ({
					variantId: variant.variantId,
					sku: textOrNull(variant.sku),
					title: textOrNull(variant.title),
					attributes: isObject(variant.attributes) ? { ...variant.attributes } : {},
					price: intOrNull(variant.price),
					inventory: intOrNull(variant.inventory),
				}))
		: base.variants;
	return {
		...base,
		title: textOrNull(data.title) ?? base.title,
		status: textOrNull(data.status) ?? base.status,
		currency: textOrNull(data.currency) ?? base.currency,
		variants,
		snapshotAt: occurredAt,
		deleted: false,
	};
};

/**
 * Apply `item.deleted@1`.
 * @param {CatalogItem | null} previous
 * @param {string} itemId
 * @param {string} occurredAt
 * @returns {CatalogItem}
 */
export const applyDeleted = (previous, itemId, occurredAt) => {
	const base = previous ?? emptyItem(itemId);
	if (after(base.snapshotAt, occurredAt)) return base;
	return { ...base, deleted: true, snapshotAt: occurredAt };
};

/**
 * The stock key of an inventory figure: the variant id, else the variant with that SKU, else `sku:<sku>`, else `*` (the
 * item as a whole).
 * @param {CatalogItem} item
 * @param {{ variantId?: unknown, sku?: unknown }} data
 */
const stockKey = (item, data) => {
	if (typeof data.variantId === 'string' && data.variantId) return data.variantId;
	if (typeof data.sku === 'string' && data.sku)
		return item.variants.find((v) => v.sku === data.sku)?.variantId ?? `sku:${data.sku}`;
	return '*';
};

/**
 * Apply `inventory.changed@1`: the sellable quantity (`available`, else `quantity`) of a variant at a location.
 * A figure without a location replaces the variant's per-location figures.
 * @param {CatalogItem | null} previous
 * @param {Record<string, any>} data
 * @param {string} occurredAt
 * @returns {CatalogItem}
 */
export const applyInventory = (previous, data, occurredAt) => {
	const base = previous ?? emptyItem(String(data.itemId));
	const quantity = intOrNull(data.available) ?? intOrNull(data.quantity);
	if (quantity === null) return base;
	const key = stockKey(base, data);
	const location = typeof data.locationId === 'string' && data.locationId ? data.locationId : '*';
	const existing = base.stock.find((figure) => figure.key === key && figure.location === location);
	if (existing && after(existing.at, occurredAt)) return base;
	const others = base.stock.filter(
		(figure) => figure.key !== key || (location === '*' ? false : figure.location !== location && figure.location !== '*'),
	);
	return { ...base, stock: [...others, { key, location, quantity, at: occurredAt }].slice(-LIMITS.combinations) };
};

/**
 * Effective stock of a variant: its inventory.changed figures (summed over locations), else the snapshot's inventory,
 * else the item-level figure, else null (not tracked).
 * @param {CatalogItem} item
 * @param {CatalogVariant} variant
 * @returns {number | null}
 */
export const variantStock = (item, variant) => {
	const sum = (/** @type {string} */ key) => {
		const figures = item.stock.filter((figure) => figure.key === key);
		return figures.length > 0 ? figures.reduce((total, figure) => total + figure.quantity, 0) : null;
	};
	return sum(variant.variantId) ?? (variant.sku ? sum(`sku:${variant.sku}`) : null) ?? variant.inventory ?? sum('*');
};

/**
 * Attribute values of a variant as option keys (strings; numbers and booleans as text).
 * @param {CatalogVariant} variant
 * @param {string} attribute
 * @returns {string[]}
 */
export const attributeValues = (variant, attribute) => {
	const raw = variant.attributes[attribute];
	const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
	return list
		.filter((value) => ['string', 'number', 'boolean'].includes(typeof value))
		.map((value) => String(value))
		.filter((value) => value.length > 0 && value.length <= LIMITS.optionKeyLength && value === value.trim());
};

/**
 * A catalog-linked schema made concrete from the item: single-choice groups with an `attribute` get their options from
 * the variants (declared options act as the pool — order, labels, swatches — and values outside it are not offered),
 * every variant becomes a combination with its SKU, price and stock, and the item currency is the fallback currency.
 * @param {import('./schema.js').Schema} schema
 * @param {CatalogItem | null} item
 * @returns {{ ok: true, schema: import('./schema.js').Schema } | { ok: false, code: 'catalog_item_unavailable' }}
 */
export const linkSchema = (schema, item) => {
	if (!item || item.deleted || item.status === 'archived') return { ok: false, code: 'catalog_item_unavailable' };
	const groups = schema.groups.map((group) => {
		if (group.type !== 'single' || !group.attribute) return group;
		/** @type {string[]} */
		const seen = [];
		for (const variant of item.variants)
			for (const value of attributeValues(variant, /** @type {string} */ (group.attribute)))
				if (!seen.includes(value)) seen.push(value);
		const options =
			group.options.length > 0
				? group.options.filter((option) => seen.includes(option.key))
				: seen.slice(0, LIMITS.options).map((key) => ({
						key,
						label: key,
						description: null,
						swatch: null,
						image: null,
						hidden: false,
						when: null,
						priceDelta: 0,
						stock: null,
						popularity: 0,
					}));
		const keys = new Set(options.map((option) => option.key));
		return {
			...group,
			options,
			required: group.required && options.length > 0,
			default: typeof group.default === 'string' && keys.has(group.default) ? group.default : null,
		};
	});
	const dims = groups.filter((group) => group.type === 'single' && group.attribute);
	/** @type {import('./schema.js').Combination[]} */
	const combinations = [];
	for (const variant of item.variants) {
		/** @type {Record<string, string | string[]>} */
		const options = {};
		let offered = true;
		for (const group of dims) {
			const values = attributeValues(variant, /** @type {string} */ (group.attribute));
			if (values.length === 0) continue;
			const allowed = values.filter((value) => group.options.some((option) => option.key === value));
			if (allowed.length === 0) offered = false;
			else options[group.key] = allowed.length === 1 ? /** @type {string} */ (allowed[0]) : allowed;
		}
		if (!offered || Object.keys(options).length === 0) continue;
		combinations.push({
			id: variant.variantId,
			sku: variant.sku,
			options,
			stock: variantStock(item, variant),
			price: variant.price,
			available: true,
		});
	}
	const currency = schema.pricing?.currency ?? item.currency;
	return {
		ok: true,
		schema: {
			...schema,
			groups,
			combinations,
			pricing: schema.pricing
				? { ...schema.pricing, currency }
				: combinations.some((combination) => combination.price !== null)
					? { base: null, currency, rules: [], rounding: null }
					: null,
		},
	};
};

/**
 * Compact view of a stored item (API / dashboard).
 * @param {CatalogItem} item
 */
export const itemView = (item) => ({
	itemId: item.itemId,
	title: item.title,
	status: item.status,
	currency: item.currency,
	deleted: item.deleted,
	snapshotAt: item.snapshotAt,
	variants: item.variants.map((variant) => ({
		variantId: variant.variantId,
		sku: variant.sku,
		title: variant.title,
		attributes: variant.attributes,
		price: variant.price,
		stock: variantStock(item, variant),
	})),
});
