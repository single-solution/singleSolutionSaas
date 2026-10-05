/**
 * Generic items and deal scopes (pure). The engine never knows what a merchant sells: a line is
 * `{ itemId, variantId?, quantity, unitAmount, attributes?, collections?, brand? }`, enriched from the merchant's synced
 * catalog (`ss_deals_items`) for whatever the cart did not send. A scope selects lines by any combination of
 *
 *   { items, variants, collections, brands, attributes: [{ name, values }], minUnitAmount, maxUnitAmount,
 *     exclude: { items, variants, collections, brands }, when }
 *
 * — AND across the dimensions given, OR within one (generalised from ibrahimMobiles `offerMatching.ts`, whose
 * categories/brands/grades/attributes become collections/brands/attributes). An empty scope is storewide.
 * @module
 */
import { conditionMatches } from './rules.js';

/**
 * @typedef {object} Line normalised cart line
 * @property {string} lineId
 * @property {string} itemId
 * @property {string | null} variantId
 * @property {number} quantity
 * @property {number} unitAmount
 * @property {Record<string, string[]>} attributes
 * @property {string[]} collections
 * @property {string | null} brand
 * @property {number | null} unitCost cost per unit when the catalog knows it (reporting)
 */
/**
 * @typedef {object} Scope
 * @property {string[]} [items]
 * @property {string[]} [variants]
 * @property {string[]} [collections]
 * @property {string[]} [brands]
 * @property {Array<{ name: string, values: string[] }>} [attributes]
 * @property {number} [minUnitAmount]
 * @property {number} [maxUnitAmount]
 * @property {{ items?: string[], variants?: string[], collections?: string[], brands?: string[] }} [exclude]
 * @property {string} [when] rules@1 over `item`, `cart`, `customer`
 */
/**
 * @typedef {object} CatalogItem synced item (`PUT /v1/items/{itemId}`, `item.*`, `price.changed@1`, `inventory.changed@1`)
 * @property {string} itemId
 * @property {string} [title]
 * @property {string | null} [brand]
 * @property {string[]} [collections]
 * @property {Record<string, string | string[]>} [attributes]
 * @property {number | null} [price]
 * @property {number | null} [cost]
 * @property {string | null} [currency]
 * @property {number | null} [stock]
 * @property {Array<{ variantId: string, title?: string, price?: number | null, cost?: number | null, stock?: number | null, attributes?: Record<string, string | string[]> }>} [variants]
 */

/** Scope dimensions that hold id lists. */
export const SCOPE_LISTS = Object.freeze(['items', 'variants', 'collections', 'brands']);

/**
 * Attribute map with array values (trimmed strings, empties dropped).
 * @param {unknown} raw
 * @returns {Record<string, string[]>}
 */
export const normaliseAttributes = (raw) => {
	/** @type {Record<string, string[]>} */
	const out = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
	for (const [name, value] of Object.entries(raw)) {
		const values = (Array.isArray(value) ? value : [value])
			.filter((v) => typeof v === 'string' || typeof v === 'number')
			.map((v) => String(v).trim())
			.filter((v) => v.length > 0);
		if (values.length > 0) out[name] = [...new Set(values)];
	}
	return out;
};

/**
 * @param {unknown} list
 * @returns {string[]}
 */
const strings = (list) => (Array.isArray(list) ? list.filter((v) => typeof v === 'string' && v.length > 0) : []);

/**
 * A catalog item's variant.
 * @param {CatalogItem | null | undefined} item
 * @param {string | null} variantId
 */
export const variantOf = (item, variantId) =>
	variantId && Array.isArray(item?.variants) ? (item.variants.find((v) => v.variantId === variantId) ?? null) : null;

/**
 * Catalog price of an item/variant (variant price wins), else null.
 * @param {CatalogItem | null | undefined} item
 * @param {string | null} variantId
 * @returns {number | null}
 */
export const catalogPrice = (item, variantId) => {
	const variant = variantOf(item, variantId);
	const price = variant?.price ?? item?.price;
	return Number.isSafeInteger(price) && /** @type {number} */ (price) >= 0 ? /** @type {number} */ (price) : null;
};

/**
 * Normalise a cart line; fields the cart did not send come from the synced catalog (variant attributes over item ones).
 * @param {{ lineId?: string, itemId: string, variantId?: string | null, quantity: number, unitAmount?: number,
 *   attributes?: Record<string, unknown>, collections?: string[], brand?: string | null }} raw
 * @param {number} index position in the cart (default line id)
 * @param {CatalogItem | null} [catalog]
 * @returns {Line}
 */
export const normaliseLine = (raw, index, catalog = null) => {
	const variantId = typeof raw.variantId === 'string' && raw.variantId ? raw.variantId : null;
	const variant = variantOf(catalog, variantId);
	const attributes =
		raw.attributes && typeof raw.attributes === 'object'
			? normaliseAttributes(raw.attributes)
			: { ...normaliseAttributes(catalog?.attributes), ...normaliseAttributes(variant?.attributes) };
	const cost = variant?.cost ?? catalog?.cost;
	return {
		lineId: typeof raw.lineId === 'string' && raw.lineId ? raw.lineId : String(index + 1),
		itemId: raw.itemId,
		variantId,
		quantity: raw.quantity,
		unitAmount: Number.isSafeInteger(raw.unitAmount)
			? /** @type {number} */ (raw.unitAmount)
			: (catalogPrice(catalog, variantId) ?? 0),
		attributes,
		collections: Array.isArray(raw.collections) ? strings(raw.collections) : strings(catalog?.collections),
		brand: typeof raw.brand === 'string' ? raw.brand : (catalog?.brand ?? null),
		unitCost: Number.isSafeInteger(cost) && /** @type {number} */ (cost) >= 0 ? /** @type {number} */ (cost) : null,
	};
};

/**
 * The rules@1 view of a line.
 * @param {Line} line
 */
export const itemContext = (line) => ({
	id: line.itemId,
	variantId: line.variantId,
	quantity: line.quantity,
	unitAmount: line.unitAmount,
	amount: line.unitAmount * line.quantity,
	brand: line.brand,
	collections: line.collections,
	attributes: line.attributes,
});

/**
 * True when a scope names nothing (storewide).
 * @param {Scope | null | undefined} scope
 */
export const isStorewide = (scope) =>
	!scope ||
	(SCOPE_LISTS.every((key) => strings(/** @type {any} */ (scope)[key]).length === 0) &&
		(scope.attributes ?? []).length === 0 &&
		scope.minUnitAmount === undefined &&
		scope.maxUnitAmount === undefined &&
		!(typeof scope.when === 'string' && scope.when.trim()));

/**
 * Does a line fall in a scope? `context` (cart, customer) and `options` are needed only for `when`.
 * @param {Line} line
 * @param {Scope | null | undefined} scope
 * @param {{ context?: Record<string, unknown>, now?: number, timeZone?: string }} [options]
 * @returns {boolean}
 */
export const lineInScope = (line, scope, { context = {}, now = 0, timeZone = 'UTC' } = {}) => {
	if (!scope) return true;
	const exclude = scope.exclude ?? {};
	if (strings(exclude.items).includes(line.itemId)) return false;
	if (line.variantId && strings(exclude.variants).includes(line.variantId)) return false;
	if (strings(exclude.collections).some((c) => line.collections.includes(c))) return false;
	if (line.brand && strings(exclude.brands).includes(line.brand)) return false;
	const items = strings(scope.items);
	const variants = strings(scope.variants);
	// items and variants are one "which products" dimension: either list may name the line
	if (
		(items.length > 0 || variants.length > 0) &&
		!items.includes(line.itemId) &&
		!(line.variantId && variants.includes(line.variantId))
	)
		return false;
	const collections = strings(scope.collections);
	if (collections.length > 0 && !collections.some((c) => line.collections.includes(c))) return false;
	const brands = strings(scope.brands);
	if (brands.length > 0 && !(line.brand && brands.includes(line.brand))) return false;
	for (const filter of scope.attributes ?? []) {
		const have = line.attributes[filter.name] ?? [];
		if (!filter.values.some((value) => have.includes(value))) return false;
	}
	if (Number.isSafeInteger(scope.minUnitAmount) && line.unitAmount < /** @type {number} */ (scope.minUnitAmount)) return false;
	if (Number.isSafeInteger(scope.maxUnitAmount) && line.unitAmount > /** @type {number} */ (scope.maxUnitAmount)) return false;
	if (typeof scope.when === 'string' && scope.when.trim())
		return conditionMatches(scope.when, { ...context, item: itemContext(line) }, { now, timeZone });
	return true;
};

/**
 * MongoDB filter (without `websiteId`, which the repository adds) selecting the catalog items of a scope — the deals
 * page lists them. Attribute names are validated keys (no `.`/`$`); `when` and amount bounds are applied after the
 * query because they need the evaluated line.
 * @param {Scope | null | undefined} scope
 * @returns {Record<string, unknown>}
 */
export const scopeCatalogFilter = (scope) => {
	/** @type {Array<Record<string, unknown>>} */
	const and = [];
	if (!scope) return {};
	const items = strings(scope.items);
	const variants = strings(scope.variants);
	if (items.length > 0 || variants.length > 0)
		and.push({
			$or: [
				...(items.length > 0 ? [{ itemId: { $in: items } }] : []),
				...(variants.length > 0 ? [{ 'variants.variantId': { $in: variants } }] : []),
			],
		});
	const collections = strings(scope.collections);
	if (collections.length > 0) and.push({ collections: { $in: collections } });
	const brands = strings(scope.brands);
	if (brands.length > 0) and.push({ brand: { $in: brands } });
	for (const filter of scope.attributes ?? [])
		and.push({
			$or: [
				{ [`attributes.${filter.name}`]: { $in: filter.values } },
				{ [`variants.attributes.${filter.name}`]: { $in: filter.values } },
			],
		});
	const exclude = scope.exclude ?? {};
	if (strings(exclude.items).length > 0) and.push({ itemId: { $nin: strings(exclude.items) } });
	if (strings(exclude.collections).length > 0) and.push({ collections: { $nin: strings(exclude.collections) } });
	if (strings(exclude.brands).length > 0) and.push({ brand: { $nin: strings(exclude.brands) } });
	return and.length === 0 ? {} : and.length === 1 ? /** @type {Record<string, unknown>} */ (and[0]) : { $and: and };
};
