/**
 * List queries (pure): `filter[...]`, `sort` and keyset cursors for items. Filters map to indexed fields only (facet
 * tokens, denormalised price and stock rollups); nothing from the query string is passed through to the database.
 * @module
 */
import { OPTION_VALUE } from './attributes.js';
import { isId, isKey, isSlug, issue } from './text.js';

export const SORTS = Object.freeze(/** @type {const} */ (['newest', 'oldest', 'title', 'price_asc', 'price_desc', 'updated']));

/** @type {Readonly<Record<string, Array<[string, 1 | -1]>>>} */
const SPECS = Object.freeze({
	newest: [
		['createdAt', -1],
		['id', -1],
	],
	oldest: [
		['createdAt', 1],
		['id', 1],
	],
	title: [
		['titleSort', 1],
		['id', 1],
	],
	price_asc: [
		['sortPriceLow', 1],
		['id', 1],
	],
	price_desc: [
		['sortPriceHigh', -1],
		['id', -1],
	],
	updated: [
		['updatedAt', -1],
		['id', -1],
	],
});

const DATE_FIELDS = new Set(['createdAt', 'updatedAt']);
/** `filter[<name>]` names that are not facets (a bare `filter[<attribute key>]` is a facet, like `filter[attr.<key>]`). */
export const RESERVED_FILTERS = Object.freeze([
	'status',
	'type',
	'brandId',
	'brand',
	'collectionId',
	'tag',
	'slug',
	'sku',
	'externalId',
	'priceMin',
	'priceMax',
	'price_min',
	'price_max',
	'inStock',
	'deleted',
	'itemId',
	'parentId',
]);
const MAX_WORDS = 5;
const MAX_PAGE = 1000;

/**
 * Search words of a text: lowercase, accents folded, split on anything but letters and digits.
 * @param {string} text
 * @returns {string[]}
 */
export const wordsOf = (text) =>
	text
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
const MAX_FACET_KEYS = 10;
const MAX_FACET_VALUES = 20;

/**
 * @typedef {object} ItemFilter
 * @property {string[]} [statuses]
 * @property {string} [type]
 * @property {string} [brandId]
 * @property {string[]} [collectionIds] any of
 * @property {string} [tag]
 * @property {string[][]} [facets] AND of ORs of `key:value` tokens
 * @property {number} [priceMin]
 * @property {number} [priceMax]
 * @property {boolean} [inStock]
 * @property {string} [slug]
 * @property {string} [sku]
 * @property {string} [externalId]
 * @property {boolean} [deleted] owner only: list deleted items
 * @property {string} [collectionId] the requested collection (expanded to `collectionIds` by the caller)
 * @property {string[]} [brandSlugs] `filter[brand]` (resolved to brand ids by the caller)
 * @property {string[]} [words] `q`: every word must start a word of the item's title, SKUs or tags
 */

/**
 * @param {string} name
 * @param {unknown} value
 * @param {Array<{ path: string, code: string }>} problems
 */
const amount = (name, value, problems) => {
	if (value === undefined) return undefined;
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) {
		problems.push(issue(`/filter/${name}`, 'amount_invalid'));
		return undefined;
	}
	return number;
};

/**
 * Parse an item list query.
 * @param {Record<string, string | undefined>} query
 * @param {{ owner: boolean, sorts: readonly string[], defaultSort: string, statuses: readonly string[] }} context
 * @returns {{ problems: Array<{ path: string, code: string }>, filter: ItemFilter, sort: string, page: number | null }}
 */
export const parseItemQuery = (query, { owner, sorts, defaultSort, statuses }) => {
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	/** @type {ItemFilter} */
	const filter = {};
	const allowedSorts = owner ? SORTS : sorts;
	const sort = query.sort === undefined ? defaultSort : query.sort;
	if (!allowedSorts.includes(sort)) problems.push(issue('/sort', 'sort_invalid'));
	const status = query['filter[status]'];
	if (status !== undefined) {
		const list = status.split(',');
		if (!owner) problems.push(issue('/filter/status', 'not_allowed'));
		else if (!list.every((s) => statuses.includes(s))) problems.push(issue('/filter/status', 'status_invalid'));
		else filter.statuses = list;
	}
	/** @param {string} name @param {(value: string) => boolean} check @param {keyof ItemFilter} key */
	const single = (name, check, key) => {
		const value = query[`filter[${name}]`];
		if (value === undefined) return;
		if (!check(value)) problems.push(issue(`/filter/${name}`, 'value_invalid'));
		else /** @type {any} */ (filter)[key] = value;
	};
	single('type', isKey, 'type');
	single('brandId', isId, 'brandId');
	single('collectionId', isId, 'collectionId');
	single('tag', (v) => v.length > 0 && v.length <= 50, 'tag');
	single('slug', isSlug, 'slug');
	single('sku', (v) => v.length > 0 && v.length <= 100, 'sku');
	single('externalId', isId, 'externalId');
	const priceMin = amount('priceMin', query['filter[priceMin]'] ?? query['filter[price_min]'], problems);
	const priceMax = amount('priceMax', query['filter[priceMax]'] ?? query['filter[price_max]'], problems);
	const brand = query['filter[brand]'];
	if (brand !== undefined) {
		const slugs = brand.split(',');
		if (slugs.length > MAX_FACET_VALUES || !slugs.every(isSlug)) problems.push(issue('/filter/brand', 'value_invalid'));
		else filter.brandSlugs = slugs;
	}
	if (query.q !== undefined) {
		const words = wordsOf(query.q).slice(0, MAX_WORDS);
		if (query.q.length > 200 || words.some((w) => w.length > 40)) problems.push(issue('/q', 'value_invalid'));
		else if (words.length > 0) filter.words = words;
	}
	if (priceMin !== undefined) filter.priceMin = priceMin;
	if (priceMax !== undefined) filter.priceMax = priceMax;
	const inStock = query['filter[inStock]'];
	if (inStock !== undefined) {
		if (inStock !== 'true' && inStock !== 'false') problems.push(issue('/filter/inStock', 'boolean_invalid'));
		else filter.inStock = inStock === 'true';
	}
	const deleted = query['filter[deleted]'];
	if (deleted !== undefined) {
		if (!owner || (deleted !== 'true' && deleted !== 'false')) problems.push(issue('/filter/deleted', 'not_allowed'));
		else filter.deleted = deleted === 'true';
	}
	const facetKeys = Object.keys(query).filter(
		(name) =>
			/^filter\[attr\.[^\]]+\]$/.test(name) ||
			(/^filter\[[^\].]+\]$/.test(name) && !RESERVED_FILTERS.includes(name.slice(7, -1))),
	);
	if (facetKeys.length > MAX_FACET_KEYS) problems.push(issue('/filter', 'too_many_filters'));
	else if (facetKeys.length > 0) {
		filter.facets = [];
		for (const name of facetKeys) {
			const key = name.startsWith('filter[attr.') ? name.slice('filter[attr.'.length, -1) : name.slice('filter['.length, -1);
			const values = String(query[name]).split(',');
			if (
				!isKey(key) ||
				values.length > MAX_FACET_VALUES ||
				!values.every((v) => OPTION_VALUE.test(v) || /^-?\d+(?:\.\d+)?$|^true$|^false$/.test(v))
			)
				problems.push(issue(`/filter/attr.${key}`, 'value_invalid'));
			else filter.facets.push(values.map((value) => `${key}:${value}`));
		}
	}
	/** @type {number | null} */
	let page = null;
	if (query.page !== undefined) {
		page = /^\d{1,4}$/.test(query.page) ? Number(query.page) : 0;
		if (page < 1 || page > MAX_PAGE) problems.push(issue('/page', 'page_invalid'));
		if (query.cursor !== undefined) problems.push(issue('/page', 'page_or_cursor'));
	}
	return { problems, filter, sort, page };
};

/**
 * The index-backed sort of a sort name.
 * @param {string} sort
 * @returns {Array<[string, 1 | -1]>}
 */
export const sortSpec = (sort) => SPECS[sort] ?? /** @type {Array<[string, 1 | -1]>} */ (SPECS.newest);

/**
 * The cursor key of an item under a sort (dates become ISO strings in the cursor).
 * @param {Record<string, any>} item
 * @param {Array<[string, 1 | -1]>} spec
 * @returns {Array<string | number>}
 */
export const cursorKey = (item, spec) =>
	spec.map(([field]) => {
		const value = item[field];
		return value instanceof Date ? value.toISOString() : value;
	});

/**
 * Keyset condition for the page after `after` (the decoded cursor key), or null when the cursor does not fit.
 * @param {Array<[string, 1 | -1]>} spec
 * @param {unknown} after
 * @returns {Record<string, unknown> | null}
 */
export const afterFilter = (spec, after) => {
	if (!Array.isArray(after) || after.length !== spec.length) return null;
	const [[field, direction], [idField]] = /** @type {[[string, 1 | -1], [string, 1 | -1]]} */ (spec);
	const raw = after[0];
	const id = after[1];
	if (typeof id !== 'string') return null;
	let value = raw;
	if (DATE_FIELDS.has(field)) {
		if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) return null;
		value = new Date(raw);
	} else if (field === 'titleSort' ? typeof raw !== 'string' : typeof raw !== 'number') return null;
	const op = direction === 1 ? '$gt' : '$lt';
	return { $or: [{ [field]: { [op]: value } }, { [field]: value, [idField]: { [op]: id } }] };
};
