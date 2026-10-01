/**
 * The listing query (search, facets, price range, sort, page) and its URL form. Filters and the grid read and write
 * the same parameters, so a filtered page is a plain shareable, crawlable URL (`?brand=a,b&min=100&sort=price_asc&page=2`).
 * Parameter names can be prefixed (`param_prefix`) so two listings on one page do not collide. Local sources (a JSON
 * file or page data) are filtered, counted, sorted and paged here; the Catalog API does the same server-side.
 * Bad or unknown values are dropped silently: best effort, never an error.
 */
import { int, isObject, oneOf, str } from './util.js';

/** Sort orders a listing can offer. */
export const SORTS = Object.freeze(/** @type {const} */ (['relevance', 'newest', 'price_asc', 'price_desc', 'title_asc']));
/** @typedef {typeof SORTS[number]} Sort */
/** Parameter names facets may not use. */
export const RESERVED = Object.freeze(['q', 'sort', 'page', 'min', 'max']);
/** Facet keys: attribute keys, `brand`, `collection`, `price`, `in_stock`. */
export const FACET_KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_FACETS = 20;
const MAX_VALUES = 50;
const MAX_PAGE = 10_000;

/**
 * @typedef {object} Facet
 * @property {string} key
 * @property {string} label merchant label (empty: the UI uses the key)
 * @property {'values' | 'range' | 'toggle'} type
 * @property {boolean} multi
 */

/**
 * @typedef {object} Query
 * @property {string} q
 * @property {Sort} sort
 * @property {number} page 1-based
 * @property {Record<string, string[]>} filters selected facet values
 * @property {number | null} min price range, minor units
 * @property {number | null} max
 */

/**
 * Facet definitions from configuration.
 * @param {unknown} value
 * @returns {Facet[]}
 */
export const facetsOf = (value) =>
	(Array.isArray(value) ? value : [])
		.filter((f) => isObject(f) && FACET_KEY.test(f.key) && !RESERVED.includes(f.key))
		.slice(0, MAX_FACETS)
		.map((f) => ({
			key: f.key,
			label: str(f.label, '', 80),
			type: f.key === 'price' ? 'range' : oneOf(f.type, /** @type {const} */ (['values', 'range', 'toggle']), 'values'),
			multi: f.multi !== false,
		}));

/** @param {string} prefix */
const naming = (prefix) => (/** @type {string} */ name) => `${prefix}${name}`;

/**
 * Parse a query string.
 * @param {string} search `location.search` (with or without `?`)
 * @param {{ prefix?: string, facets?: readonly Facet[], sorts?: readonly Sort[], sort?: Sort }} [options]
 * @returns {Query}
 */
export const parseQuery = (search, { prefix = '', facets = [], sorts = SORTS, sort = 'relevance' } = {}) => {
	const params = new URLSearchParams(search);
	const name = naming(prefix);
	/** @param {string} key */
	const number = (key) => {
		const raw = params.get(name(key));
		return raw !== null && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
	};
	/** @type {Record<string, string[]>} */
	const filters = {};
	for (const facet of facets) {
		if (facet.type === 'range') continue;
		const values = params
			.getAll(name(facet.key))
			.flatMap((entry) => entry.split(','))
			.map((entry) => entry.trim().slice(0, 100))
			.filter((entry) => entry !== '')
			.slice(0, facet.multi ? MAX_VALUES : 1);
		if (values.length > 0) filters[facet.key] = [...new Set(values)];
	}
	return {
		q: (params.get(name('q')) ?? '').trim().slice(0, 100),
		sort: oneOf(params.get(name('sort')), sorts, sorts.includes(sort) ? sort : (sorts[0] ?? 'relevance')),
		page: int(number('page'), 1, 1, MAX_PAGE),
		filters,
		min: number('min'),
		max: number('max'),
	};
};

/**
 * Write a query into a query string, keeping every unrelated parameter of `base`. Defaults are omitted.
 * The listing's own parameters (reserved names and every facet key, prefixed) are rewritten; others are kept.
 * @param {Query} query
 * @param {{ prefix?: string, base?: string, sort?: Sort, facets?: readonly Facet[] }} [options]
 * @returns {string} `?…` or `''`
 */
export const toSearch = (query, { prefix = '', base = '', sort = 'relevance', facets = [] } = {}) => {
	const params = new URLSearchParams(base);
	const name = naming(prefix);
	for (const key of [...RESERVED, ...facets.map((facet) => facet.key), ...Object.keys(query.filters)]) params.delete(name(key));
	if (query.q) params.set(name('q'), query.q);
	for (const [key, values] of Object.entries(query.filters)) if (values.length > 0) params.set(name(key), values.join(','));
	if (query.min !== null) params.set(name('min'), String(query.min));
	if (query.max !== null) params.set(name('max'), String(query.max));
	if (query.sort !== sort) params.set(name('sort'), query.sort);
	if (query.page > 1) params.set(name('page'), String(query.page));
	const text = params.toString();
	return text === '' ? '' : `?${text}`;
};

/** True when any facet or price filter is set. @param {Query} query */
export const hasFilters = (query) =>
	Object.values(query.filters).some((values) => values.length > 0) || query.min !== null || query.max !== null;

/**
 * Values of a facet on one item.
 * @param {import('./items.js').Item} item
 * @param {string} key
 * @returns {string[]}
 */
export const valuesOf = (item, key) => {
	if (key === 'brand') return item.brand ? [item.brand] : [];
	if (key === 'collection') return item.collections;
	if (key === 'in_stock') return item.inStock ? ['1'] : [];
	return [...new Set([...(item.attrs[key] ?? []), ...item.variants.flatMap((variant) => variant.attrs[key] ?? [])])];
};

/**
 * @param {import('./items.js').Item} item
 * @param {Query} query
 * @param {string | null} skip facet to ignore (disjunctive counts)
 */
const matches = (item, query, skip) => {
	for (const [key, wanted] of Object.entries(query.filters)) {
		if (key === skip || wanted.length === 0) continue;
		const have = valuesOf(item, key).map((value) => value.toLowerCase());
		if (!wanted.some((value) => have.includes(value.toLowerCase()))) return false;
	}
	if (skip !== 'price') {
		if (query.min !== null && (item.price === null || item.price < query.min)) return false;
		if (query.max !== null && (item.price === null || item.price > query.max)) return false;
	}
	if (query.q) {
		const text = [item.title, item.brand, ...Object.values(item.attrs).flat()].join(' ').toLowerCase();
		if (
			!query.q
				.toLowerCase()
				.split(/\s+/)
				.every((word) => text.includes(word))
		)
			return false;
	}
	return true;
};

/**
 * @param {Sort} sort
 * @param {string} [locale]
 * @returns {(a: import('./items.js').Item, b: import('./items.js').Item) => number}
 */
export const comparator = (sort, locale) => {
	const byOrder = (/** @type {any} */ a, /** @type {any} */ b) => a.order - b.order;
	/** @param {number | null} value @param {number} missing */
	const price = (value, missing) => value ?? missing;
	switch (sort) {
		case 'newest':
			return (a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || byOrder(a, b);
		case 'price_asc':
			return (a, b) => price(a.price, Infinity) - price(b.price, Infinity) || byOrder(a, b);
		case 'price_desc':
			return (a, b) => price(b.price, -Infinity) - price(a.price, -Infinity) || byOrder(a, b);
		case 'title_asc':
			return (a, b) => a.title.localeCompare(b.title, locale || undefined) || byOrder(a, b);
		default:
			return byOrder;
	}
};

/**
 * @typedef {object} FacetCount
 * @property {string} key
 * @property {Array<{ value: string, count: number }>} values
 * @property {{ min: number, max: number } | null} range price bounds of the matching items
 */

/**
 * Filter, count, sort and page local items.
 * @param {readonly import('./items.js').Item[]} items
 * @param {Query} query
 * @param {{ size: number, facets?: readonly Facet[], locale?: string, maxValues?: number }} options
 * @returns {{ items: import('./items.js').Item[], total: number, pages: number, facets: FacetCount[] }}
 */
export const applyQuery = (items, query, { size, facets = [], locale, maxValues = MAX_VALUES }) => {
	const matching = items.filter((item) => matches(item, query, null)).sort(comparator(query.sort, locale));
	const pages = Math.max(1, Math.ceil(matching.length / size));
	const counts = facets.map((facet) => {
		const pool = items.filter((item) => matches(item, query, facet.key));
		if (facet.type === 'range') {
			const prices = pool.map((item) => item.price).filter((price) => price !== null);
			return {
				key: facet.key,
				values: [],
				range: prices.length > 0 ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
			};
		}
		/** @type {Map<string, number>} */
		const tally = new Map();
		for (const item of pool) for (const value of valuesOf(item, facet.key)) tally.set(value, (tally.get(value) ?? 0) + 1);
		return {
			key: facet.key,
			values: [...tally]
				.map(([value, count]) => ({ value, count }))
				.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, locale || undefined))
				.slice(0, maxValues),
			range: null,
		};
	});
	const start = (Math.min(query.page, pages) - 1) * size;
	return { items: matching.slice(start, start + size), total: matching.length, pages, facets: counts };
};

/**
 * Page links around the current page: first, last and a window of `span` either side (`null` = a gap).
 * @param {number} page
 * @param {number} pages
 * @param {number} [span]
 * @returns {Array<number | null>}
 */
export const pageWindow = (page, pages, span = 1) => {
	/** @type {Array<number | null>} */
	const out = [];
	for (let n = 1; n <= pages; n += 1) {
		if (n === 1 || n === pages || Math.abs(n - page) <= span) out.push(n);
		else if (out.at(-1) !== null) out.push(null);
	}
	return out;
};
