/**
 * Search, listings and filters (PLAN 0.8.8 Catalog, the product grid): the shopper's query (words, category, brand,
 * price range, in stock, attribute values, grade, sort) as a database filter, the sort orders with their cursor keys
 * (every order ends with the product id, so pages never skip or repeat), and the facet counts of a listing. Search
 * matches every word anywhere in the name, summary, tags or SKUs, in any language. No I/O.
 * @module
 */
import { isObject } from './catalog.js';
import { MAX_AMOUNT } from './money.js';

/** @typedef {import('./model.js').AttributeRecord} AttributeRecord */
/** @typedef {import('./catalog.js').FieldError} FieldError */

/** The sort orders of a listing: the field and its direction (ties broken by id in the same direction). */
export const SORTS = Object.freeze({
	newest: { field: 'publishedAt', dir: -1 },
	price_asc: { field: 'price', dir: 1 },
	price_desc: { field: 'price', dir: -1 },
	top: { field: 'sold', dir: -1 },
	rating: { field: 'rating.average', dir: -1 },
	name: { field: 'name', dir: 1 },
});

/** @typedef {keyof typeof SORTS} SortKey */
/** @typedef {{ field: string, dir: 1 | -1 }} Sort */

/** Most words of a search, and their length. */
const MAX_WORDS = 8;
const MAX_WORD = 50;

/** @param {string} text */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Words of a search as a filter: every word must appear in the name, summary, a tag or a SKU (case-insensitive).
 * @param {string} q
 * @returns {Record<string, unknown> | null} null for an empty search
 */
export const searchFilter = (q) => {
	const words = q
		.normalize('NFC')
		.split(/\s+/)
		.map((word) => word.trim().slice(0, MAX_WORD))
		.filter(Boolean)
		.slice(0, MAX_WORDS);
	if (words.length === 0) return null;
	return {
		$and: words.map((word) => {
			const pattern = { $regex: escapeRegex(word), $options: 'i' };
			return { $or: [{ name: pattern }, { summary: pattern }, { tags: pattern }, { 'variants.sku': pattern }] };
		}),
	};
};

/** @param {unknown} value */
const amount = (value) =>
	typeof value === 'string' && /^\d{1,13}$/.test(value) && Number(value) <= MAX_AMOUNT ? Number(value) : null;

/**
 * A shopper's listing query.
 * @typedef {object} ShopQuery
 * @property {string} q
 * @property {string | null} category id or slug
 * @property {string | null} brand id or slug
 * @property {number | null} minPrice minor units
 * @property {number | null} maxPrice minor units
 * @property {boolean} inStock
 * @property {Array<{ id: string, values: string[] }>} attributes
 * @property {string | null} grade
 * @property {SortKey} sort
 */

/**
 * Read a listing query (`attr.<attributeId>=value[,value]` filters by attribute values).
 * @param {Record<string, string>} query first value of each parameter
 * @param {{ defaultSort?: SortKey }} [options]
 * @returns {{ ok: true, value: ShopQuery } | { ok: false, errors: FieldError[] }}
 */
export const readShopQuery = (query, { defaultSort = 'newest' } = {}) => {
	/** @type {FieldError[]} */
	const errors = [];
	const minPrice = query.minPrice ? amount(query.minPrice) : null;
	const maxPrice = query.maxPrice ? amount(query.maxPrice) : null;
	if (query.minPrice && minPrice === null) errors.push({ path: '/minPrice', message: 'Give a price in minor units.' });
	if (query.maxPrice && maxPrice === null) errors.push({ path: '/maxPrice', message: 'Give a price in minor units.' });
	const sort = query.sort || defaultSort;
	if (!Object.hasOwn(SORTS, sort)) errors.push({ path: '/sort', message: `Sort is one of ${Object.keys(SORTS).join(', ')}.` });
	/** @type {Array<{ id: string, values: string[] }>} */
	const attributes = [];
	for (const [name, value] of Object.entries(query)) {
		if (!name.startsWith('attr.')) continue;
		const values = value
			.split(',')
			.map((part) => part.trim())
			.filter(Boolean)
			.slice(0, 20);
		if (values.length > 0 && attributes.length < 20) attributes.push({ id: name.slice(5), values });
	}
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			q: (query.q ?? '').slice(0, 200),
			category: query.category || null,
			brand: query.brand || null,
			minPrice,
			maxPrice,
			inStock: query.inStock === 'true' || query.inStock === '1',
			attributes,
			grade: query.grade || null,
			sort: /** @type {SortKey} */ (sort),
		},
	};
};

/**
 * Attribute filter values as stored (numbers and booleans are kept as such); unknown attributes match nothing.
 * @param {AttributeRecord | undefined} attribute
 * @param {string[]} values
 * @returns {Array<string | number | boolean>}
 */
export const storedValues = (attribute, values) => {
	if (!attribute) return [];
	if (attribute.type === 'number') return values.map(Number).filter(Number.isFinite);
	if (attribute.type === 'boolean') return values.filter((v) => v === 'true' || v === 'false').map((v) => v === 'true');
	return values;
};

/**
 * The listing's filter (the caller adds `websiteId`).
 * @param {ShopQuery} query
 * @param {{ categoryIds: string[] | null, brandId: string | null, attributes: ReadonlyMap<string, AttributeRecord> }} resolved
 *   `categoryIds`: the category with its descendants (an unknown category is []); `brandId`: '' for an unknown brand
 * @returns {Record<string, unknown>}
 */
export const shopFilter = (query, resolved) => {
	/** @type {Record<string, unknown>[]} */
	const and = [{ status: 'active' }];
	const search = searchFilter(query.q);
	if (search) and.push(search);
	if (resolved.categoryIds) and.push({ categoryIds: { $in: resolved.categoryIds } });
	if (resolved.brandId !== null) and.push({ brandId: resolved.brandId });
	if (query.minPrice !== null) and.push({ price: { $gte: query.minPrice } });
	if (query.maxPrice !== null) and.push({ price: { $lte: query.maxPrice } });
	if (query.inStock) and.push({ inStock: true });
	for (const { id, values } of query.attributes)
		and.push({ [`specs.${id}`]: { $in: storedValues(resolved.attributes.get(id), values) } });
	if (query.grade) and.push({ variants: { $elemMatch: { active: true, grade: query.grade } } });
	return and.length === 1 ? /** @type {Record<string, unknown>} */ (and[0]) : { $and: and };
};

/**
 * @param {Sort} sort
 * @returns {Record<string, 1 | -1>}
 */
export const sortDocument = ({ field, dir }) => ({ [field]: dir, id: dir });

/**
 * A record's value at a dotted path.
 * @param {any} record
 * @param {string} field
 */
const valueAt = (record, field) => field.split('.').reduce((value, part) => (isObject(value) ? value[part] : undefined), record);

/**
 * The cursor key of a record in an order: `[value, id]` (dates as milliseconds).
 * @param {any} record
 * @param {Sort} sort
 * @returns {[string | number | boolean | null, string]}
 */
export const cursorKey = (record, { field }) => {
	const value = valueAt(record, field);
	return [value instanceof Date ? value.getTime() : (value ?? null), String(record.id)];
};

/**
 * The filter of the records after a cursor key, or null when the key does not fit the order.
 * @param {Sort} sort
 * @param {unknown} after
 * @param {{ dates?: string[] }} [options] fields stored as dates
 * @returns {Record<string, unknown> | null}
 */
export const afterFilter = ({ field, dir }, after, { dates = ['publishedAt', 'createdAt', 'updatedAt'] } = {}) => {
	if (!Array.isArray(after) || after.length !== 2 || typeof after[1] !== 'string') return null;
	const raw = after[0];
	if (dates.includes(field) && typeof raw !== 'number') return null;
	const value = dates.includes(field) ? new Date(/** @type {number} */ (raw)) : raw;
	const beyond = dir === 1 ? '$gt' : '$lt';
	return { $or: [{ [field]: { [beyond]: value } }, { [field]: value, id: { [beyond]: after[1] } }] };
};

/**
 * The facet counts of a listing, as one `$facet` stage (after the listing's `$match`).
 * @param {string[]} filterable ids of filterable attributes
 */
export const facetStage = (filterable) => ({
	$facet: {
		categories: [{ $unwind: '$categoryIds' }, { $group: { _id: '$categoryIds', count: { $sum: 1 } } }],
		brands: [{ $match: { brandId: { $type: 'string' } } }, { $group: { _id: '$brandId', count: { $sum: 1 } } }],
		price: [{ $group: { _id: null, min: { $min: '$price' }, max: { $max: '$price' } } }],
		attributes: [
			{ $project: { s: { $objectToArray: { $ifNull: ['$specs', {}] } } } },
			{ $unwind: '$s' },
			{ $match: { 's.k': { $in: filterable } } },
			{ $group: { _id: { k: '$s.k', v: '$s.v' }, count: { $sum: 1 } } },
		],
		grades: [
			{ $unwind: '$variants' },
			{ $match: { 'variants.active': true, 'variants.grade': { $type: 'string' } } },
			{ $group: { _id: { g: '$variants.grade', p: '$id' } } },
			{ $group: { _id: '$_id.g', count: { $sum: 1 } } },
		],
	},
});

/**
 * @typedef {object} Facets
 * @property {Array<{ id: string, slug: string, name: string, count: number }>} categories
 * @property {Array<{ id: string, slug: string, name: string, count: number }>} brands
 * @property {{ min: number, max: number } | null} price
 * @property {Array<{ id: string, name: string, unit: string, type: string, values: Array<{ value: string | number | boolean, count: number }> }>} attributes
 * @property {Array<{ key: string, label: string, count: number }>} grades
 */

/**
 * The facets for shoppers from the `$facet` answer: names added, unknown records dropped, values sorted.
 * @param {any} raw the single document the `$facet` stage answers
 * @param {{ categories: ReadonlyMap<string, { slug: string, name: string }>, brands: ReadonlyMap<string, { slug: string, name: string }>,
 *   attributes: ReadonlyMap<string, AttributeRecord>, grades: ReadonlyMap<string, { label: string }> }} names
 * @returns {Facets}
 */
export const facetsOf = (raw, names) => {
	/** @param {any[] | undefined} rows @param {ReadonlyMap<string, { slug: string, name: string }>} map */
	const named = (rows, map) =>
		(rows ?? [])
			.filter((row) => map.has(row._id))
			.map((row) => {
				const found = /** @type {{ slug: string, name: string }} */ (map.get(row._id));
				return { id: String(row._id), slug: found.slug, name: found.name, count: Number(row.count) };
			})
			.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	const price = raw?.price?.[0];
	/** @type {Map<string, Array<{ value: string | number | boolean, count: number }>>} */
	const values = new Map();
	for (const row of raw?.attributes ?? []) {
		if (!names.attributes.has(row._id.k)) continue;
		values.set(row._id.k, [...(values.get(row._id.k) ?? []), { value: row._id.v, count: Number(row.count) }]);
	}
	return {
		categories: named(raw?.categories, names.categories),
		brands: named(raw?.brands, names.brands),
		price: price && typeof price.min === 'number' ? { min: price.min, max: price.max } : null,
		attributes: [...values.entries()]
			.map(([id, list]) => ({ attribute: /** @type {AttributeRecord} */ (names.attributes.get(id)), list }))
			.sort((a, b) => a.attribute.sort - b.attribute.sort || a.attribute.name.localeCompare(b.attribute.name))
			.map(({ attribute, list }) => ({
				id: attribute.id,
				name: attribute.name,
				unit: attribute.unit,
				type: attribute.type,
				values: list.sort((a, b) =>
					typeof a.value === 'number' && typeof b.value === 'number'
						? a.value - b.value
						: String(a.value).localeCompare(String(b.value)),
				),
			})),
		// in the order of the grades list
		grades: [...names.grades.entries()].flatMap(([key, grade]) => {
			const row = (raw?.grades ?? []).find((/** @type {any} */ r) => r._id === key);
			return row ? [{ key, label: grade.label, count: Number(row.count) }] : [];
		}),
	};
};

/**
 * The staff's product list filter (the caller adds `websiteId`).
 * @param {Record<string, string>} query `q`, `status`, `kind`, `lowStock`
 * @param {{ categoryIds: string[] | null, brandId: string | null, lowStock: number }} resolved
 * @returns {Record<string, unknown>}
 */
export const staffFilter = (query, resolved) => {
	/** @type {Record<string, unknown>[]} */
	const and = [];
	const search = searchFilter(query.q ?? '');
	if (search) and.push(search);
	if (['draft', 'active', 'archived'].includes(query.status ?? '')) and.push({ status: query.status });
	if (['physical', 'digital', 'booking'].includes(query.kind ?? '')) and.push({ kind: query.kind });
	if (resolved.categoryIds) and.push({ categoryIds: { $in: resolved.categoryIds } });
	if (resolved.brandId !== null) and.push({ brandId: resolved.brandId });
	if (query.lowStock === 'true' || query.lowStock === '1')
		and.push({ trackStock: true, variants: { $elemMatch: { active: true, stock: { $lte: resolved.lowStock } } } });
	return and.length === 0 ? {} : { $and: and };
};
