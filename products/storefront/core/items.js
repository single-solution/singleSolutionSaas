/**
 * Items from any source: a merchant's public JSON file, data embedded in the page, or the Catalog product's public
 * read API. A field map (`|`-separated alternative paths per field) turns any JSON shape into one item model, so
 * nothing about a store, a category or a language is assumed. Money stays integer minor units plus an ISO 4217 code.
 */
import { at, first, isObject, safeUrl, str, strings } from './util.js';

/**
 * @typedef {object} Item
 * @property {string} id
 * @property {string} title
 * @property {string | null} href
 * @property {string | null} image
 * @property {string} imageAlt
 * @property {number | null} price minor units
 * @property {number | null} compareAt minor units (shown struck through when above `price`)
 * @property {string | null} currency
 * @property {string} brand
 * @property {string[]} badges
 * @property {Record<string, string[]>} attrs
 * @property {Array<{ attrs: Record<string, string[]> }>} variants
 * @property {string[]} collections
 * @property {boolean | null} inStock
 * @property {number | null} rank higher = more trending
 * @property {string | null} createdAt
 * @property {number} order position in the source (stable "relevance" order)
 */

/** Default field map: the common names plus the `@ss/contracts` item snapshot (`itemId`, variants with `price`). */
export const DEFAULT_FIELDS = Object.freeze({
	id: 'id|itemId|sku|slug',
	title: 'title|name',
	href: 'url|href|link',
	image: 'image|imageUrl|images.0.url|images.0',
	image_alt: 'imageAlt|images.0.alt',
	price: 'price|variants.0.price',
	compare_at: 'compareAtPrice|compareAt|variants.0.compareAtPrice',
	currency: 'currency|price.currency',
	brand: 'brand.name|brand',
	badges: 'badges|tags',
	attributes: 'attributes',
	variants: 'variants',
	collections: 'collections|categories',
	in_stock: 'inStock|available',
	rank: 'rank|score|popularity',
	created_at: 'createdAt|publishedAt',
});

/** @typedef {Record<keyof typeof DEFAULT_FIELDS, string>} FieldMap */

/**
 * Field map from configuration over the defaults (only non-empty strings override).
 * @param {unknown} config
 * @returns {FieldMap}
 */
export const fieldMap = (config) => {
	const out = /** @type {FieldMap} */ ({ ...DEFAULT_FIELDS });
	if (!isObject(config)) return out;
	for (const key of /** @type {Array<keyof FieldMap>} */ (Object.keys(DEFAULT_FIELDS))) {
		const value = str(config[key], '', 200);
		if (value !== '') out[key] = value;
	}
	return out;
};

/**
 * Integer minor units from a number or a `{ amount }` money object.
 * @param {unknown} value
 * @returns {number | null}
 */
const minor = (value) => {
	const amount = isObject(value) ? value.amount : value;
	return Number.isSafeInteger(amount) && /** @type {number} */ (amount) >= 0 ? /** @type {number} */ (amount) : null;
};

/**
 * Attribute values as string lists (scalars and scalar arrays; at most 50 attributes × 50 values).
 * @param {unknown} value
 * @returns {Record<string, string[]>}
 */
export const attributesOf = (value) => {
	/** @type {Record<string, string[]>} */
	const out = {};
	if (!isObject(value)) return out;
	for (const [key, raw] of Object.entries(value).slice(0, 50)) {
		const list = (Array.isArray(raw) ? raw : [raw])
			.filter((entry) => ['string', 'number', 'boolean'].includes(typeof entry))
			.slice(0, 50)
			.map((entry) => String(entry).slice(0, 100));
		if (list.length > 0 && key.length <= 64) out[key] = list;
	}
	return out;
};

/**
 * Normalise one raw record; null when it has no id or title.
 * @param {unknown} raw
 * @param {FieldMap} map
 * @param {number} order
 * @returns {Item | null}
 */
export const toItem = (raw, map, order) => {
	if (!isObject(raw)) return null;
	const id = first(raw, map.id);
	const title = str(first(raw, map.title), '', 300);
	if ((typeof id !== 'string' && typeof id !== 'number') || title === '') return null;
	const variants = (Array.isArray(first(raw, map.variants)) ? /** @type {unknown[]} */ (first(raw, map.variants)) : [])
		.filter(isObject)
		.slice(0, 100);
	const prices = variants.map((variant) => minor(variant.price)).filter((price) => price !== null);
	const price = minor(first(raw, map.price)) ?? (prices.length > 0 ? Math.min(...prices) : null);
	const stock = first(raw, map.in_stock);
	const brand = first(raw, map.brand);
	const rank = first(raw, map.rank);
	const created = first(raw, map.created_at);
	const currency = first(raw, map.currency);
	return {
		id: String(id).slice(0, 128),
		title,
		href: safeUrl(first(raw, map.href)),
		image: safeUrl(first(raw, map.image), { src: true }),
		imageAlt: str(first(raw, map.image_alt), '', 300),
		price,
		compareAt: minor(first(raw, map.compare_at)),
		currency: typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : null,
		brand: typeof brand === 'string' ? brand.slice(0, 100) : '',
		badges: strings(first(raw, map.badges), 5, 40),
		attrs: attributesOf(first(raw, map.attributes)),
		variants: variants.map((variant) => ({ attrs: attributesOf(variant.attributes) })),
		collections: strings(first(raw, map.collections), 50, 100),
		inStock:
			typeof stock === 'boolean'
				? stock
				: variants.length > 0 && variants.some((v) => typeof v.inventory === 'number')
					? variants.some((v) => Number(v.inventory) > 0)
					: null,
		rank: typeof rank === 'number' && Number.isFinite(rank) ? rank : null,
		createdAt: typeof created === 'string' ? created.slice(0, 40) : null,
		order,
	};
};

/** Most items one source may hold (the JSON file or the page). */
export const MAX_ITEMS = 2000;

/**
 * The records of a JSON document: an array, or `{ items | data | results: [] }`.
 * @param {unknown} json
 * @returns {unknown[]}
 */
export const recordsOf = (json) => {
	if (Array.isArray(json)) return json;
	for (const key of ['items', 'data', 'results']) {
		const value = at(json, key);
		if (Array.isArray(value)) return value;
	}
	return [];
};

/**
 * All valid items of a JSON document (first `max` records, duplicates by id dropped).
 * @param {unknown} json
 * @param {FieldMap} map
 * @param {number} [max]
 * @returns {Item[]}
 */
export const toItems = (json, map, max = MAX_ITEMS) => {
	const seen = new Set();
	/** @type {Item[]} */
	const out = [];
	for (const [index, raw] of recordsOf(json).slice(0, max).entries()) {
		const item = toItem(raw, map, index);
		if (item && !seen.has(item.id)) {
			seen.add(item.id);
			out.push(item);
		}
	}
	return out;
};

/**
 * Minor-unit digits of a currency (2 for most, 0 or 3 for some), from `Intl`.
 * @param {string | null} currency
 */
export const digitsOf = (currency) => {
	try {
		return (
			new Intl.NumberFormat('en', { style: 'currency', currency: currency ?? '' }).resolvedOptions().maximumFractionDigits ?? 2
		);
	} catch {
		return 2;
	}
};

/**
 * Format integer minor units with `Intl` (the website's language and currency; the currency's own minor digits).
 * Without a known currency nothing is shown: guessing the minor digits would print a wrong price.
 * @param {number | null} amount
 * @param {string | null} currency
 * @param {string} [locale]
 * @returns {string}
 */
export const formatMoney = (amount, currency, locale) => {
	if (amount === null || !currency) return '';
	/** @param {string | undefined} tag */
	const format = (tag) => new Intl.NumberFormat(tag, { style: 'currency', currency }).format(amount / 10 ** digitsOf(currency));
	try {
		return format(locale || undefined);
	} catch {
		try {
			return format(undefined);
		} catch {
			return '';
		}
	}
};
