/**
 * The item model every PDP element reads: one normalised, bounded, frozen view of "the thing on this page", built from
 * untrusted input (the page's `data-ss-*` attributes, `<meta>` tags, an inline JSON blob, or the merchant's public JSON
 * source). Nothing here knows a store, a country, a currency or a product category: prices are decimal strings with
 * the currency code the page gives, availability and condition use the schema.org vocabulary.
 * @module
 */
import { int, isObject, pick, safeUrl, text } from './util.js';

/** Availability values (schema.org ItemAvailability, snake_case). */
export const AVAILABILITY = Object.freeze(
	/** @type {const} */ (['in_stock', 'out_of_stock', 'preorder', 'backorder', 'limited', 'discontinued']),
);

/** Item conditions (schema.org OfferItemCondition, lower case). */
export const CONDITIONS = Object.freeze(/** @type {const} */ (['new', 'used', 'refurbished', 'damaged']));

/** Fields of the item model, as named in page data and merchant JSON. */
export const ITEM_FIELDS = Object.freeze([
	'id',
	'title',
	'subtitle',
	'brand',
	'description',
	'url',
	'sku',
	'gtin',
	'mpn',
	'category',
	'condition',
	'availability',
	'stock',
	'price',
	'compareAtPrice',
	'currency',
	'images',
	'ratingValue',
	'ratingCount',
	'faq',
	'related',
	'attributes',
]);

export const LIMITS = Object.freeze({ images: 50, faq: 50, related: 48, attributes: 100 });

/**
 * @typedef {object} Image
 * @property {'image' | 'video'} type
 * @property {string} src
 * @property {string} alt merchant alt text ('' when none)
 * @property {number} width 0 when unknown
 * @property {number} height
 * @property {string} srcset
 * @property {string} zoom larger image for the zoom view ('' = src)
 * @property {string} poster video poster
 */
/** @typedef {{ question: string, answer: string }} FaqEntry */
/**
 * @typedef {object} RelatedItem
 * @property {string} id
 * @property {string} title
 * @property {string} url
 * @property {string} image
 * @property {string} price
 * @property {string} currency
 * @property {string} brand
 * @property {string} category
 */
/**
 * @typedef {object} Item
 * @property {string} id
 * @property {string} title
 * @property {string} subtitle
 * @property {string} brand
 * @property {string} description plain text, never HTML
 * @property {string} url
 * @property {string} sku
 * @property {string} gtin
 * @property {string} mpn
 * @property {string} category
 * @property {string} condition as given (mapped to the schema.org vocabulary by structured data)
 * @property {(typeof AVAILABILITY)[number] | ''} availability
 * @property {string} price decimal string ('' when unknown)
 * @property {string} compareAtPrice
 * @property {string} currency ISO 4217 code ('' when unknown)
 * @property {readonly Image[]} images
 * @property {number} ratingValue 0 when none
 * @property {number} ratingCount
 * @property {readonly FaqEntry[]} faq
 * @property {readonly RelatedItem[]} related
 * @property {ReadonlyArray<{ name: string, value: string }>} attributes
 */

/**
 * Price as a canonical decimal string: a non-negative number or a plain decimal (`1299`, `1299.5`, `0.99`) — no
 * thousands separators, because their meaning depends on the locale.
 * @param {unknown} value
 * @returns {string}
 */
export const parsePrice = (value) => {
	if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value < 1e12 ? String(value) : '';
	const raw = text(value, 32);
	return /^\d{1,12}(?:\.\d{1,4})?$/.test(raw) ? raw.replace(/^0+(?=\d)/, '') : '';
};

/**
 * @param {unknown} value
 * @returns {string}
 */
export const parseCurrency = (value) => {
	const code = text(value, 10).toUpperCase();
	return /^[A-Z]{3}$/.test(code) ? code : '';
};

/**
 * A vocabulary token: lower case letters only, without a schema.org prefix (`https://schema.org/InStock` → `instock`).
 * @param {unknown} value
 * @returns {string}
 */
export const vocabulary = (value) =>
	text(value, 100)
		.replace(/^https?:\/\/schema\.org\//i, '')
		.toLowerCase()
		.replace(/[^a-z]/g, '');

const AVAILABILITY_TOKENS = Object.freeze(
	/** @type {Record<string, (typeof AVAILABILITY)[number]>} */ ({
		instock: 'in_stock',
		onlineonly: 'in_stock',
		instoreonly: 'in_stock',
		outofstock: 'out_of_stock',
		soldout: 'out_of_stock',
		preorder: 'preorder',
		presale: 'preorder',
		backorder: 'backorder',
		limited: 'limited',
		limitedavailability: 'limited',
		discontinued: 'discontinued',
	}),
);

/**
 * Availability from a schema.org value or token, else from a stock count (`> 0` → in stock).
 * @param {unknown} value
 * @param {unknown} [stock]
 * @returns {(typeof AVAILABILITY)[number] | ''}
 */
export const parseAvailability = (value, stock) => {
	const token = AVAILABILITY_TOKENS[vocabulary(value)];
	if (token) return token;
	const count = int(stock, 0, Number.MAX_SAFE_INTEGER, -1);
	return count < 0 ? '' : count > 0 ? 'in_stock' : 'out_of_stock';
};

/**
 * @param {unknown} value
 * @returns {Image | null}
 */
const toImage = (value) => {
	const entry = typeof value === 'string' ? { src: value } : value;
	if (!isObject(entry)) return null;
	const src = safeUrl(entry.src ?? entry.url);
	if (src === '') return null;
	return Object.freeze({
		type: entry.type === 'video' ? 'video' : 'image',
		src,
		alt: text(entry.alt, 250),
		width: int(entry.width, 1, 20_000, 0),
		height: int(entry.height, 1, 20_000, 0),
		srcset: text(entry.srcset, 2000).replace(/[<>"'`]/g, ''),
		zoom: safeUrl(entry.zoom ?? entry.large),
		poster: safeUrl(entry.poster),
	});
};

/**
 * @param {unknown} value
 * @returns {FaqEntry | null}
 */
const toFaq = (value) => {
	if (!isObject(value)) return null;
	const question = text(value.question ?? value.q, 300);
	const answer = text(value.answer ?? value.a, 3000);
	return question && answer ? Object.freeze({ question, answer }) : null;
};

/**
 * @param {unknown} value
 * @returns {RelatedItem | null}
 */
const toRelated = (value) => {
	if (!isObject(value)) return null;
	const title = text(value.title ?? value.name, 200);
	const url = safeUrl(value.url ?? value.href);
	if (!title || !url) return null;
	const image = Array.isArray(value.images) ? value.images[0] : value.image;
	return Object.freeze({
		id: text(value.id, 128),
		title,
		url,
		image: safeUrl(isObject(image) ? (image.src ?? image.url) : image),
		price: parsePrice(value.price),
		currency: parseCurrency(value.currency),
		brand: text(value.brand, 120),
		category: text(value.category, 120),
	});
};

/**
 * @param {unknown} value
 * @returns {Array<{ name: string, value: string }>}
 */
const toAttributes = (value) => {
	const entries = Array.isArray(value)
		? value.map((entry) => (isObject(entry) ? [entry.name, entry.value] : [null, null]))
		: isObject(value)
			? Object.entries(value)
			: [];
	return entries
		.map(([name, entry]) => ({ name: text(name, 80), value: text(entry, 300) }))
		.filter((entry) => entry.name !== '' && entry.value !== '')
		.slice(0, LIMITS.attributes)
		.map((entry) => Object.freeze(entry));
};

/**
 * Normalised, frozen item from raw page or JSON data (unknown fields ignored, every value bounded).
 * @param {unknown} raw
 * @returns {Item}
 */
export const normaliseItem = (raw) => {
	const value = isObject(raw) ? raw : {};
	/** @template T @param {unknown} list @param {(entry: unknown) => T | null} map @param {number} max */
	const listOf = (list, map, max) =>
		Object.freeze(
			(Array.isArray(list) ? list.slice(0, max * 2) : [])
				.map(map)
				.filter((entry) => entry !== null)
				.slice(0, max),
		);
	const brand = isObject(value.brand) ? value.brand.name : value.brand;
	const rating = int(value.ratingCount, 0, 1e9, 0);
	const ratingValue = Number(value.ratingValue);
	return Object.freeze({
		id: text(value.id, 128),
		title: text(value.title ?? value.name, 300),
		subtitle: text(value.subtitle, 300),
		brand: text(brand, 120),
		description: text(value.description, 5000),
		url: safeUrl(value.url),
		sku: text(value.sku, 100),
		gtin: /^\d{8,14}$/.test(text(value.gtin, 14)) ? text(value.gtin, 14) : '',
		mpn: text(value.mpn, 100),
		category: text(value.category, 200),
		condition: text(value.condition, 100),
		availability: parseAvailability(value.availability, value.stock),
		price: parsePrice(value.price),
		compareAtPrice: parsePrice(value.compareAtPrice),
		currency: parseCurrency(value.currency),
		images: listOf(value.images, toImage, LIMITS.images),
		ratingValue: rating > 0 && ratingValue >= 0 && ratingValue <= 5 ? Math.round(ratingValue * 100) / 100 : 0,
		ratingCount: rating,
		faq: listOf(value.faq, toFaq, LIMITS.faq),
		related: listOf(value.related, toRelated, LIMITS.related),
		attributes: Object.freeze(toAttributes(value.attributes)),
	});
};

/** @param {unknown} value */
const present = (value) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);

/**
 * Overlay raw data: every present field of `over` replaces the one of `base`.
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} over
 * @returns {Record<string, unknown>}
 */
export const mergeRaw = (base, over) => {
	/** @type {Record<string, unknown>} */
	const out = { ...base };
	for (const field of ITEM_FIELDS) if (Object.hasOwn(over, field) && present(over[field])) out[field] = over[field];
	return out;
};

/**
 * Raw item data from the merchant's JSON: `fields.root` selects the item object (dot path), every other field is read
 * from its mapped path, or from the same-named property when it has no mapping.
 * @param {unknown} json
 * @param {Readonly<Record<string, unknown>>} fields
 * @returns {Record<string, unknown>}
 */
export const mapFields = (json, fields) => {
	const root = typeof fields.root === 'string' && fields.root !== '' ? pick(json, fields.root) : json;
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const field of ITEM_FIELDS) {
		const path = fields[field];
		const value = typeof path === 'string' && path !== '' ? pick(root, path) : isObject(root) ? root[field] : undefined;
		if (value !== undefined) out[field] = value;
	}
	return out;
};

/**
 * Field problems of raw item data (an item needs a title; a price needs its currency).
 * @param {unknown} raw
 * @returns {Array<{ path: string, code: string }>}
 */
export const validateItem = (raw) => {
	if (!isObject(raw)) return [{ path: '', code: 'item_invalid' }];
	const item = normaliseItem(raw);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	if (item.title === '') problems.push({ path: '/title', code: 'title_required' });
	if (present(raw.price) && item.price === '') problems.push({ path: '/price', code: 'price_invalid' });
	if (item.price !== '' && item.currency === '') problems.push({ path: '/currency', code: 'currency_required' });
	return problems;
};
