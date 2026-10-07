/**
 * Sellable items as Checkout knows them (pure). Checkout never trusts a price from a browser: every line is priced from
 * this item record, which comes from one of three sources —
 *
 * - the merchant's own server (`PUT /v1/items/:itemId` with an `sk_` key), so the Catalog product is not required;
 * - the Catalog product's standard events (`item.created|updated|deleted@1`, `price.changed@1`,
 *   `inventory.changed@1`), mirrored into the merchant's database;
 * - a live lookup in the Catalog product's public API (`GET /v1/items/:ref`) for an item not mirrored yet.
 *
 * `available` is the sellable stock of a variant: an integer (tracked, the placement transaction decrements it) or
 * `null` (not tracked here).
 * @module
 */
import { CURRENCY, cleanText, isAmount, isId, isObject, issue } from './text.js';

/**
 * @typedef {object} Variant
 * @property {string} variantId
 * @property {string | null} sku
 * @property {string | null} title
 * @property {Record<string, string>} attributes
 * @property {number} price integer minor units
 * @property {number | null} compareAtPrice
 * @property {number | null} available sellable stock; null = not tracked
 * @property {boolean} purchasable
 */
/**
 * @typedef {object} Item
 * @property {string} itemId
 * @property {string} title
 * @property {string | null} url
 * @property {string | null} image
 * @property {string} currency
 * @property {boolean} requiresShipping
 * @property {string[]} collections
 * @property {string | null} brand
 * @property {'active' | 'draft' | 'archived'} status
 * @property {'api' | 'catalog'} source
 * @property {Variant[]} variants
 */

export const ITEM_LIMITS = Object.freeze({ title: 300, sku: 100, url: 2048, attributes: 30, collections: 50, variants: 250 });
const STATUSES = new Set(['active', 'draft', 'archived']);

/** @param {unknown} value */
const httpsUrl = (value) => {
	const text = cleanText(value, ITEM_LIMITS.url);
	if (!text) return null;
	try {
		const url = new URL(text);
		return url.protocol === 'https:' ? url.href : null;
	} catch {
		return null;
	}
};

/**
 * Small string attribute map (`{ size: 'M' }`); arrays keep their first value, other types are dropped.
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
const attributesOf = (value) => {
	if (!isObject(value)) return {};
	/** @type {Record<string, string>} */
	const out = {};
	for (const [name, raw] of Object.entries(value).slice(0, ITEM_LIMITS.attributes)) {
		if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) continue;
		const first = Array.isArray(raw) ? raw[0] : raw;
		const text = typeof first === 'number' || typeof first === 'boolean' ? String(first) : cleanText(first, 200);
		if (text) out[name] = text;
	}
	return out;
};

/** @param {unknown} value @returns {string[]} */
const idsOf = (value) => (Array.isArray(value) ? [...new Set(value.filter(isId))].slice(0, ITEM_LIMITS.collections) : []);

/**
 * Validate an item posted by the merchant's server (`PUT /v1/items/:itemId`). Without `variants`, the item is one
 * variant whose id is the item id (`price`, `available` at the top level).
 * @param {string} itemId
 * @param {unknown} body
 * @returns {{ ok: true, item: Item } | { ok: false, problems: import('./text.js').FieldProblem[] }}
 */
export const validateItem = (itemId, body) => {
	/** @type {import('./text.js').FieldProblem[]} */
	const problems = [];
	if (!isId(itemId)) problems.push(issue('/itemId', 'id_invalid'));
	if (!isObject(body)) return { ok: false, problems: [...problems, issue('', 'body_invalid')] };
	const title = cleanText(body.title, ITEM_LIMITS.title);
	if (!title) problems.push(issue('/title', 'required'));
	if (typeof body.currency !== 'string' || !CURRENCY.test(body.currency)) problems.push(issue('/currency', 'currency_invalid'));
	if (body.status !== undefined && !STATUSES.has(body.status)) problems.push(issue('/status', 'status_invalid'));
	const rawVariants = Array.isArray(body.variants)
		? body.variants
		: [{ variantId: itemId, price: body.price, available: body.available, sku: body.sku }];
	if (rawVariants.length === 0 || rawVariants.length > ITEM_LIMITS.variants) problems.push(issue('/variants', 'variants_count'));
	/** @type {Variant[]} */
	const variants = [];
	const seen = new Set();
	rawVariants.slice(0, ITEM_LIMITS.variants).forEach((/** @type {any} */ raw, index) => {
		const at = Array.isArray(body.variants) ? `/variants/${index}` : '';
		if (!isObject(raw)) {
			problems.push(issue(at, 'variant_invalid'));
			return;
		}
		if (!isId(raw.variantId) || seen.has(raw.variantId)) problems.push(issue(`${at}/variantId`, 'id_invalid'));
		if (!isAmount(raw.price)) problems.push(issue(`${at}/price`, 'amount_invalid'));
		if (raw.compareAtPrice !== undefined && raw.compareAtPrice !== null && !isAmount(raw.compareAtPrice))
			problems.push(issue(`${at}/compareAtPrice`, 'amount_invalid'));
		if (raw.available !== undefined && raw.available !== null && !Number.isSafeInteger(raw.available))
			problems.push(issue(`${at}/available`, 'quantity_invalid'));
		seen.add(raw.variantId);
		variants.push({
			variantId: String(raw.variantId),
			sku: cleanText(raw.sku, ITEM_LIMITS.sku),
			title: cleanText(raw.title, ITEM_LIMITS.title),
			attributes: attributesOf(raw.attributes),
			price: Number(raw.price),
			compareAtPrice: isAmount(raw.compareAtPrice) ? raw.compareAtPrice : null,
			available: Number.isSafeInteger(raw.available) ? raw.available : null,
			purchasable: raw.purchasable !== false,
		});
	});
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		item: {
			itemId,
			title: /** @type {string} */ (title),
			url: httpsUrl(body.url),
			image: httpsUrl(body.image),
			currency: body.currency,
			requiresShipping: body.requiresShipping !== false,
			collections: idsOf(body.collections),
			brand: cleanText(body.brand, 200),
			status: STATUSES.has(body.status) ? body.status : 'active',
			source: 'api',
			variants,
		},
	};
};

/**
 * Item from a Catalog `item.created@1` / `item.updated@1` snapshot (`inventory` = sellable stock). Returns null when the
 * snapshot is not complete enough to sell from (no currency or variants).
 * @param {Record<string, any>} data
 * @param {Item | null} previous the mirrored item, for fields the event does not carry
 * @returns {Item | null}
 */
export const itemFromCatalogEvent = (data, previous) => {
	if (!isId(data.itemId)) return null;
	const currency = typeof data.currency === 'string' && CURRENCY.test(data.currency) ? data.currency : previous?.currency;
	const variants = Array.isArray(data.variants)
		? data.variants
				.filter((/** @type {any} */ v) => isObject(v) && isId(v.variantId) && isAmount(v.price))
				.slice(0, ITEM_LIMITS.variants)
				.map((/** @type {any} */ v) => ({
					variantId: v.variantId,
					sku: cleanText(v.sku, ITEM_LIMITS.sku),
					title: cleanText(v.title, ITEM_LIMITS.title),
					attributes: attributesOf(v.attributes),
					price: v.price,
					compareAtPrice: isAmount(v.compareAtPrice) ? v.compareAtPrice : null,
					available: Number.isSafeInteger(v.inventory) ? v.inventory : null,
					purchasable: true,
				}))
		: (previous?.variants ?? []);
	const title = cleanText(data.title, ITEM_LIMITS.title) ?? previous?.title;
	if (!currency || !title || variants.length === 0) return null;
	return {
		itemId: data.itemId,
		title,
		url: previous?.url ?? null,
		image: previous?.image ?? null,
		currency,
		requiresShipping: previous?.requiresShipping ?? true,
		collections: Array.isArray(data.collections) ? idsOf(data.collections) : (previous?.collections ?? []),
		brand: cleanText(data.brand, 200) ?? previous?.brand ?? null,
		status: STATUSES.has(data.status) ? data.status : (previous?.status ?? 'active'),
		source: 'catalog',
		variants,
	};
};

/**
 * Item from the Catalog public item view (`GET /v1/items/:ref`). Stock counts are not public there, so `available` is
 * null (untracked) and an `out_of_stock` / non-purchasable variant cannot be bought.
 * @param {unknown} view
 * @returns {Item | null}
 */
export const itemFromCatalogView = (view) => {
	if (!isObject(view) || !isId(view.id) || typeof view.currency !== 'string' || !CURRENCY.test(view.currency)) return null;
	const title = cleanText(view.title, ITEM_LIMITS.title);
	const variants = (Array.isArray(view.variants) ? view.variants : [])
		.filter((/** @type {any} */ v) => isObject(v) && isId(v.id) && isAmount(v.price))
		.slice(0, ITEM_LIMITS.variants)
		.map((/** @type {any} */ v) => ({
			variantId: v.id,
			sku: cleanText(v.sku, ITEM_LIMITS.sku),
			title: cleanText(v.title, ITEM_LIMITS.title),
			attributes: attributesOf(v.options),
			price: v.price,
			compareAtPrice: isAmount(v.compareAtPrice) ? v.compareAtPrice : null,
			available: null,
			purchasable: v.purchasable !== false && v.availability !== 'out_of_stock',
		}));
	if (!title || variants.length === 0) return null;
	return {
		itemId: view.id,
		title,
		url: httpsUrl(view.url),
		image: httpsUrl(view.image),
		currency: view.currency,
		requiresShipping: view.requiresShipping !== false,
		collections: idsOf(view.collectionIds),
		brand: isObject(view.brand) ? cleanText(view.brand.name, 200) : null,
		status: 'active',
		source: 'catalog',
		variants,
	};
};

/**
 * @typedef {object} PricedLine a cart line priced from the item record (never from the request)
 * @property {string} itemId
 * @property {string} variantId
 * @property {number} quantity
 * @property {string} title
 * @property {string | null} variantTitle
 * @property {string | null} sku
 * @property {string | null} image
 * @property {string | null} url
 * @property {number} unitAmount
 * @property {number | null} compareAtAmount
 * @property {number | null} available
 * @property {boolean} requiresShipping
 * @property {string[]} collections
 * @property {Record<string, string>} attributes
 */

/**
 * Price one line from its item (pure). The reason codes are stable problem codes.
 * @param {Item | null} item
 * @param {{ variantId?: string | null, quantity: number }} want
 * @param {{ currency: string | null, untracked?: 'allow' | 'refuse' }} rules
 * @returns {{ ok: true, line: PricedLine } | { ok: false, reason: 'item_unavailable' | 'variant_unavailable' | 'currency_mismatch' | 'out_of_stock' | 'untracked_stock' }}
 */
export const priceLine = (item, want, { currency, untracked = 'allow' }) => {
	if (!item || item.status !== 'active') return { ok: false, reason: 'item_unavailable' };
	const variant =
		want.variantId === undefined || want.variantId === null
			? item.variants.length === 1
				? item.variants[0]
				: undefined
			: item.variants.find((candidate) => candidate.variantId === want.variantId);
	if (!variant || !variant.purchasable) return { ok: false, reason: 'variant_unavailable' };
	if (currency && item.currency !== currency) return { ok: false, reason: 'currency_mismatch' };
	if (variant.available === null && untracked === 'refuse') return { ok: false, reason: 'untracked_stock' };
	if (variant.available !== null && variant.available <= 0) return { ok: false, reason: 'out_of_stock' };
	return {
		ok: true,
		line: {
			itemId: item.itemId,
			variantId: variant.variantId,
			quantity: want.quantity,
			title: item.title,
			variantTitle: variant.title,
			sku: variant.sku,
			image: item.image,
			url: item.url,
			unitAmount: variant.price,
			compareAtAmount: variant.compareAtPrice,
			available: variant.available,
			requiresShipping: item.requiresShipping,
			collections: item.collections,
			attributes: variant.attributes,
		},
	};
};

/**
 * Apply a `price.changed@1` to an item (one variant, or every variant when `variantId` is absent).
 * @param {Item} item
 * @param {Record<string, any>} data
 * @returns {Item | null} null when nothing applies
 */
export const applyPriceChange = (item, data) => {
	const amount = data.price?.amount;
	if (!isAmount(amount) || data.price?.currency !== item.currency) return null;
	const matches = (/** @type {Variant} */ v) => !isId(data.variantId) || v.variantId === data.variantId;
	if (!item.variants.some(matches)) return null;
	const compare = data.compareAtPrice?.amount;
	return {
		...item,
		variants: item.variants.map((v) =>
			matches(v) ? { ...v, price: amount, ...(isAmount(compare) ? { compareAtPrice: compare } : {}) } : v,
		),
	};
};

/**
 * Apply an `inventory.changed@1` (`available`, else `quantity`, is the new sellable stock).
 * @param {Item} item
 * @param {Record<string, any>} data
 * @returns {Item | null}
 */
export const applyInventoryChange = (item, data) => {
	const level = Number.isSafeInteger(data.available) ? data.available : data.quantity;
	if (!Number.isSafeInteger(level)) return null;
	const matches = (/** @type {Variant} */ v) =>
		isId(data.variantId) ? v.variantId === data.variantId : item.variants.length === 1;
	if (!item.variants.some(matches)) return null;
	return { ...item, variants: item.variants.map((v) => (matches(v) ? { ...v, available: level } : v)) };
};
