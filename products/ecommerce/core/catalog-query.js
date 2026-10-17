/**
 * Search, listings and filters (PLAN 0.8.8 Catalog, the product grid): the shopper's query (words, category, brand,
 * price range, in stock, attribute values, grade, sort) as a database filter, the sort orders with their cursor keys
 * (every order ends with the product id, so pages never skip or repeat), and the facet counts of a listing. Search
 * matches every word anywhere in the name, summary, tags or SKUs, in any language, or with the `catalog` setting
 * `searchMatch` at `phrase` the whole phrase in the name or a SKU (SF-10). No I/O.
 * @module
 */
import { valueLabel } from './catalog.js';
import { TOP_FIELD } from './limits.js';
import { levelOf } from './measure.js';
import { MAX_PAGE_NUMBER, SORTS, STOCK_STATES } from './model.js';
import { MAX_AMOUNT } from '@ss/contracts/format';
import { isObject } from '@ss/contracts/util';
import { escapeRegex } from './search.js';

/** @typedef {import('./model.js').AttributeRecord} AttributeRecord */
/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {import('./catalog.js').FieldError} FieldError */

/** @typedef {keyof typeof SORTS} SortKey */

/**
 * A listing's sort by its key, `top` and `sold_asc` by the count of units sold (`TOP_FIELD`, parity P3-10).
 * @param {SortKey} key
 * @returns {Sort}
 */
export const sortOf = (key) => {
	const sort = /** @type {Sort} */ (SORTS[key]);
	return key === 'top' || key === 'sold_asc' ? { ...sort, field: TOP_FIELD } : sort;
};
/** @typedef {{ field: string, dir: 1 | -1, then?: ReadonlyArray<{ field: string, dir: 1 | -1 }> }} Sort */

/** Most values of one filter (brands, grades, attribute values). */
const MAX_VALUES = 20;

/** Most words of a search, and their length. */
const MAX_WORDS = 8;
const MAX_WORD = 50;

/**
 * Words of a search as a filter: every word must appear in the name, summary, a tag or a SKU; with `phrase`, the words
 * in their order, as one phrase, in the name or a SKU (SF-10). Case-insensitive.
 * @param {string} q
 * @param {'words' | 'phrase'} [match]
 * @returns {Record<string, unknown> | null} null for an empty search
 */
export const searchFilter = (q, match = 'words') => {
	const words = q
		.normalize('NFC')
		.split(/\s+/)
		.map((word) => word.trim().slice(0, MAX_WORD))
		.filter(Boolean)
		.slice(0, MAX_WORDS);
	if (words.length === 0) return null;
	if (match === 'phrase') {
		const pattern = { $regex: words.map(escapeRegex).join('\\s+'), $options: 'i' };
		return { $or: [{ name: pattern }, { 'variants.sku': pattern }] };
	}
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
 * A comma-separated list of values (trimmed, empty ones dropped, at most {@link MAX_VALUES}).
 * @param {string | undefined} value
 */
export const listOf = (value) =>
	(value ?? '')
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean)
		.slice(0, MAX_VALUES);

/**
 * A shopper's listing query.
 * @typedef {object} ShopQuery
 * @property {string} q
 * @property {string | null} category id or slug
 * @property {string[]} brands ids or slugs (any of them)
 * @property {number | null} minPrice minor units
 * @property {number | null} maxPrice minor units
 * @property {boolean} inStock
 * @property {Array<{ id: string, values: string[] }>} attributes by attribute id or slug (`attr.<slug>`); no values
 *   (never read from a URL): the products that carry the field, whatever the value (a glossary page's products)
 * @property {string[]} grades grade keys (any of them)
 * @property {SortKey} sort
 * @property {boolean} featured only featured products (E2)
 * @property {string | null} deal a deal's id or slug: only products it applies to (E8)
 * @property {number | null} page a page number (1–500) instead of the cursor (E8)
 * @property {boolean} count add the number of matching products (E8)
 */

/**
 * Read a listing query (`attr.<slug or id>=value[,value]` filters by attribute values; `brand` and `grade` take several
 * comma-separated values).
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
	/** @type {number | null} */
	let page = null;
	if (query.page !== undefined && query.page !== '') {
		page = /^\d{1,3}$/.test(query.page) ? Number(query.page) : 0;
		if (page < 1 || page > MAX_PAGE_NUMBER)
			errors.push({ path: '/page', message: `A page is a whole number from 1 to ${MAX_PAGE_NUMBER}.` });
	}
	/** @type {Array<{ id: string, values: string[] }>} */
	const attributes = [];
	for (const [name, value] of Object.entries(query)) {
		if (!name.startsWith('attr.')) continue;
		const values = listOf(value);
		if (values.length > 0 && attributes.length < MAX_VALUES) attributes.push({ id: name.slice(5), values });
	}
	if (errors.length > 0) return { ok: false, errors };
	/** @param {string | undefined} v */
	const flag = (v) => v === 'true' || v === '1';
	return {
		ok: true,
		value: {
			q: (query.q ?? '').slice(0, 200),
			category: query.category || null,
			brands: listOf(query.brand),
			minPrice,
			maxPrice,
			inStock: flag(query.inStock),
			attributes,
			grades: listOf(query.grade),
			sort: /** @type {SortKey} */ (sort),
			featured: flag(query.featured),
			deal: query.deal || null,
			page,
			count: flag(query.count),
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
	if (attribute.type === 'yes_no') return values.filter((v) => v === 'true' || v === 'false').map((v) => v === 'true');
	return values;
};

/**
 * What a listing's filter resolved from the query.
 * @typedef {object} Resolved
 * @property {string[] | null} categoryIds the category with its descendants (an unknown category is [])
 * @property {string[] | null} brandIds the brands asked for (unknown ones are dropped; [] matches nothing)
 * @property {ReadonlyMap<string, AttributeRecord>} attributes every attribute by id
 * @property {{ categoryIds: string[], brandIds: string[] }} [hidden] categories and brands whose products shoppers do
 *   not see (E1)
 * @property {string[]} [brandsOut] brands whose products this listing leaves out: hidden in its category or one above it
 *   (`hiddenIn`, parity P3-12)
 * @property {Record<string, unknown> | null} [deal] the products a deal applies to (E8)
 * @property {'words' | 'phrase'} [match] how the search's words match (the `catalog` setting `searchMatch`, SF-10)
 */

/** A field has a value (a yes/no field's false and a number's 0 count). */
const CARRIED = Object.freeze({ $exists: true, $nin: [null, ''] });

/** Most filters by a field on the product and on variants at once that are matched exactly (2^n branches). */
const MAX_MIXED = 3;

/**
 * The fields an `attr.<ref>` filter names (parity P3-6): by id, that field; by slug, every product or variant field
 * with that slug (E45 keeps one per category, and each product keeps values only for the fields that apply to it, so
 * a listing with or without a category matches each product by its own field). Only active fields shoppers filter by
 * (`show.filter`): any other names none, so the listing matches nothing and never tells a staff-only value.
 * @param {ReadonlyMap<string, AttributeRecord>} attributes
 * @param {string} ref
 * @returns {AttributeRecord[]}
 */
export const fieldsNamed = (attributes, ref) => {
	const found = attributes.get(ref);
	const named = found ? [found] : [...attributes.values()].filter((attribute) => attribute.slug === ref);
	return named.filter(
		(attribute) => (attribute.on === 'product' || attribute.on === 'variant') && attribute.active && attribute.show.filter,
	);
};

/**
 * The listing's filter (the caller adds `websiteId`). One active variant must match the price range, the variant
 * fields, the grade and stock together (E8); product fields are matched on the product. A filter by slug matches any
 * field with that slug: a product's own value, or one on the same variant as the other conditions.
 * @param {ShopQuery} query
 * @param {Resolved} resolved
 * @returns {Record<string, unknown>}
 */
export const shopFilter = (query, resolved) => {
	/** @type {Record<string, unknown>[]} */
	const and = [{ status: 'active' }];
	const search = searchFilter(query.q, resolved.match);
	if (search) and.push(search);
	and.push(...visibleFilter(resolved.hidden));
	if (resolved.categoryIds) and.push({ categoryIds: { $in: resolved.categoryIds } });
	if (resolved.brandsOut && resolved.brandsOut.length > 0) and.push({ brandId: { $nin: resolved.brandsOut } });
	if (resolved.brandIds) and.push({ brandId: { $in: resolved.brandIds } });
	if (query.featured) and.push({ featured: true });
	if (resolved.deal) and.push(resolved.deal);
	/** @type {Record<string, unknown>} */
	const variant = { active: true };
	if (query.minPrice !== null || query.maxPrice !== null)
		variant.price = {
			...(query.minPrice !== null ? { $gte: query.minPrice } : {}),
			...(query.maxPrice !== null ? { $lte: query.maxPrice } : {}),
		};
	if (query.grades.length > 0) variant.grade = { $in: query.grades };
	/** each filter's conditions on a variant, matched together @type {Record<string, unknown>[]} */
	const onVariant = [];
	/** filters by fields on the product and on variants @type {Array<{ product: Record<string, unknown>, variant: Record<string, unknown> }>} */
	const mixed = [];
	/** @param {Record<string, unknown>[]} any */
	const either = (any) => (any.length === 1 ? /** @type {Record<string, unknown>} */ (any[0]) : { $or: any });
	for (const { id, values } of query.attributes) {
		const fields = fieldsNamed(resolved.attributes, id);
		/** @param {'product' | 'variant'} on @param {string} prefix */
		const conditions = (on, prefix) =>
			fields
				.filter((field) => field.on === on)
				.map((field) => ({
					[`${prefix}.${field.id}`]: values.length === 0 ? CARRIED : { $in: storedValues(field, values) },
				}));
		const product = conditions('product', 'specs');
		const variants = conditions('variant', 'attributes');
		if (fields.length === 0) and.push({ id: { $in: [] } });
		else if (variants.length === 0) and.push(either(product));
		else if (product.length === 0) onVariant.push(either(variants));
		else if (mixed.length < MAX_MIXED) mixed.push({ product: either(product), variant: either(variants) });
		// past the exact ones: the product's own value, or any active variant's
		else and.push({ $or: [...product, { variants: { $elemMatch: { active: true, $or: variants } } }] });
	}
	/**
	 * Some active variant matches the price, grade, stock and these conditions together.
	 * @param {Record<string, unknown>[]} conditions
	 */
	const someVariant = (conditions) => {
		const match = { ...variant, ...(conditions.length > 0 ? { $and: conditions } : {}) };
		if (!query.inStock) return { variants: { $elemMatch: match } };
		const selling = { ...match, soldOut: { $ne: true } };
		return {
			$or: [
				{ trackStock: false, variants: { $elemMatch: selling } },
				{ variants: { $elemMatch: { ...selling, stock: { $gt: 0 } } } },
			],
		};
	};
	if (mixed.length > 0) {
		// each filter by a field on both: the product's own value, or the same variant as the rest (every choice)
		/** @type {Record<string, unknown>[]} */
		const branches = [];
		for (let chosen = 0; chosen < 2 ** mixed.length; chosen += 1) {
			const fromProduct = mixed.filter((_, index) => (chosen >> index) & 1);
			const fromVariant = mixed.filter((_, index) => !((chosen >> index) & 1));
			branches.push({
				$and: [
					...fromProduct.map((filter) => filter.product),
					someVariant([...onVariant, ...fromVariant.map((f) => f.variant)]),
				],
			});
		}
		and.push({ $or: branches });
	} else if (query.inStock || onVariant.length > 0 || Object.keys(variant).length > 1) and.push(someVariant(onVariant));
	return and.length === 1 ? /** @type {Record<string, unknown>} */ (and[0]) : { $and: and };
};

/**
 * The conditions that leave out products of hidden or coming-soon categories and hidden brands (E1).
 * @param {{ categoryIds: string[], brandIds: string[] } | undefined} hidden
 * @returns {Record<string, unknown>[]}
 */
const visibleFilter = (hidden) => [
	...(hidden && hidden.categoryIds.length > 0 ? [{ categoryIds: { $nin: hidden.categoryIds } }] : []),
	...(hidden && hidden.brandIds.length > 0 ? [{ brandId: { $nin: hidden.brandIds } }] : []),
];

/**
 * The field that names a slug on a listing (its facet's name, unit and labels): by id, that field; by slug, the one
 * defined for the nearest of the listing's categories (a category's definition applies to the categories below it),
 * then the one for every category, else the first (E45).
 * @param {ReadonlyMap<string, AttributeRecord>} attributes
 * @param {string} ref
 * @param {ReadonlyArray<string>} [lineage] a category and those above it, nearest first (`lineageOf`)
 */
export const attributeOf = (attributes, ref, lineage = []) => {
	const found = attributes.get(ref);
	if (found) return found;
	const named = [...attributes.values()].filter((attribute) => attribute.slug === ref);
	const nearest = lineage.map((id) => named.find((attribute) => attribute.categoryId === id)).find(Boolean);
	return nearest ?? named.find((attribute) => !attribute.categoryId) ?? named[0];
};

/**
 * The products an offer applies to, from its scope (empty lists = everything; else any of the lists).
 * @param {{ productIds: string[], categoryIds: string[], brandIds: string[] }} scope
 * @param {(id: string) => string[]} withDescendants a category with the categories below it
 * @returns {Record<string, unknown> | null} null for everything
 */
export const scopeFilter = (scope, withDescendants) => {
	/** @type {Record<string, unknown>[]} */
	const any = [];
	if (scope.productIds.length > 0) any.push({ id: { $in: scope.productIds } });
	if (scope.categoryIds.length > 0) any.push({ categoryIds: { $in: [...new Set(scope.categoryIds.flatMap(withDescendants))] } });
	if (scope.brandIds.length > 0) any.push({ brandId: { $in: scope.brandIds } });
	return any.length === 0 ? null : { $or: any };
};

/**
 * The sort fields of an order, the id last.
 * @param {Sort} sort
 */
const keysOf = ({ field, dir, then = [] }) => [{ field, dir }, ...then];

/**
 * @param {Sort} sort
 * @returns {Record<string, 1 | -1>}
 */
export const sortDocument = (sort) => {
	const keys = keysOf(sort);
	return { ...Object.fromEntries(keys.map((key) => [key.field, key.dir])), id: /** @type {1 | -1} */ (keys.at(-1)?.dir ?? 1) };
};

/**
 * A record's value at a dotted path.
 * @param {any} record
 * @param {string} field
 */
const valueAt = (record, field) => field.split('.').reduce((value, part) => (isObject(value) ? value[part] : undefined), record);

/**
 * The cursor key of a record in an order: the values of its fields, then the id (dates as milliseconds).
 * @param {any} record
 * @param {Sort} sort
 * @returns {Array<string | number | boolean | null>}
 */
export const cursorKey = (record, sort) => [
	...keysOf(sort).map(({ field }) => {
		const value = valueAt(record, field);
		return value instanceof Date ? value.getTime() : (value ?? null);
	}),
	String(record.id),
];

/**
 * The filter of the records after a cursor key, or null when the key does not fit the order.
 * @param {Sort} sort
 * @param {unknown} after
 * @param {{ dates?: string[] }} [options] fields stored as dates
 * @returns {Record<string, unknown> | null}
 */
export const afterFilter = (sort, after, { dates = ['publishedAt', 'createdAt', 'updatedAt'] } = {}) => {
	const keys = keysOf(sort);
	if (!Array.isArray(after) || after.length !== keys.length + 1 || typeof after.at(-1) !== 'string') return null;
	/** @type {unknown[]} */
	const values = [];
	for (const [index, { field }] of keys.entries()) {
		const raw = after[index];
		if (dates.includes(field) && typeof raw !== 'number') return null;
		values.push(dates.includes(field) ? new Date(/** @type {number} */ (raw)) : raw);
	}
	const all = [...keys, { field: 'id', dir: keys.at(-1)?.dir ?? 1 }];
	values.push(after.at(-1));
	return {
		$or: all.map(({ field, dir }, index) => ({
			...Object.fromEntries(all.slice(0, index).map((key, at) => [key.field, values[at]])),
			[field]: { [dir === 1 ? '$gt' : '$lt']: values[index] },
		})),
	};
};

/**
 * The facet counts of a listing, as one `$facet` stage (after the listing's `$match`). Field values are counted by
 * slug (parity P3-6: every field with one slug is one filter): the products that have a value, on the product or on an
 * active variant, each product once per value (several values each count).
 * @param {ReadonlyArray<Pick<AttributeRecord, 'id' | 'slug'>>} filterable the fields shoppers filter by
 */
export const facetStage = (filterable) => {
	const ids = filterable.map((field) => field.id);
	const slugOf = {
		$arrayElemAt: [{ $literal: filterable.map((field) => field.slug) }, { $indexOfArray: [{ $literal: ids }, '$f.k'] }],
	};
	return {
		$facet: {
			categories: [{ $unwind: '$categoryIds' }, { $group: { _id: '$categoryIds', count: { $sum: 1 } } }],
			brands: [{ $match: { brandId: { $type: 'string' } } }, { $group: { _id: '$brandId', count: { $sum: 1 } } }],
			price: [{ $group: { _id: null, min: { $min: '$price' }, max: { $max: '$priceMax' } } }],
			attributes: [
				{
					$project: {
						id: 1,
						f: {
							$concatArrays: [
								{ $objectToArray: { $ifNull: ['$specs', {}] } },
								{
									$reduce: {
										input: {
											$filter: { input: { $ifNull: ['$variants', []] }, cond: { $eq: ['$$this.active', true] } },
										},
										initialValue: [],
										in: { $concatArrays: ['$$value', { $objectToArray: { $ifNull: ['$$this.attributes', {}] } }] },
									},
								},
							],
						},
					},
				},
				{ $unwind: '$f' },
				{ $match: { 'f.k': { $in: ids } } },
				{ $unwind: '$f.v' },
				{ $group: { _id: { g: slugOf, s: { $toString: '$f.v' }, p: '$id' }, v: { $first: '$f.v' }, k: { $first: '$f.k' } } },
				{
					$group: {
						_id: { g: '$_id.g', s: '$_id.s' },
						v: { $first: '$v' },
						count: { $sum: 1 },
						ids: { $addToSet: '$k' },
					},
				},
			],
			grades: [
				{ $unwind: '$variants' },
				{ $match: { 'variants.active': true, 'variants.grade': { $type: 'string' } } },
				{ $group: { _id: { g: '$variants.grade', p: '$id' } } },
				{ $group: { _id: '$_id.g', count: { $sum: 1 } } },
			],
		},
	};
};

/**
 * @typedef {object} Facets
 * @property {Array<{ id: string, slug: string, name: string, count: number }>} categories
 * @property {Array<{ id: string, slug: string, name: string, count: number }>} brands
 * @property {{ min: number, max: number } | null} price
 * @property {Array<{ id: string, slug: string, name: string, unit: string, type: string,
 *   values: Array<{ value: string | number | boolean, label: string, count: number }> }>} attributes one per slug
 * @property {Array<{ key: string, label: string, count: number }>} grades
 */

/**
 * The facets for shoppers from the `$facet` answer: names added, unknown records dropped, values sorted. A slug's
 * facet is named by the field the listing's category defines for it ({@link attributeOf}); a value is labeled by that
 * field when it holds the value, else by the field that does.
 * @param {any} raw the single document the `$facet` stage answers
 * @param {{ categories: ReadonlyMap<string, { slug: string, name: string }>, brands: ReadonlyMap<string, { slug: string, name: string }>,
 *   attributes: ReadonlyMap<string, AttributeRecord>, grades: ReadonlyMap<string, { label: string }>,
 *   lineage?: ReadonlyArray<string> }} names `attributes`: the fields shoppers filter by; `lineage`: the listing's
 *   category and those above it, nearest first
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
	/** @type {Map<string, { field: AttributeRecord, list: Array<{ value: string | number | boolean, label: string, count: number }> }>} */
	const groups = new Map();
	for (const row of raw?.attributes ?? []) {
		const slug = row._id.g;
		const field = attributeOf(names.attributes, slug, names.lineage);
		/** @type {string[]} */
		const ids = row.ids ?? [];
		const owner = ids.includes(field?.id ?? '') ? field : ids.map((id) => names.attributes.get(id)).find(Boolean);
		if (!field || !owner || field.slug !== slug) continue;
		const group = groups.get(slug) ?? { field, list: [] };
		group.list.push({ value: row.v, label: valueLabel(owner, row.v), count: Number(row.count) });
		groups.set(slug, group);
	}
	return {
		categories: named(raw?.categories, names.categories),
		brands: named(raw?.brands, names.brands),
		price: price && typeof price.min === 'number' ? { min: price.min, max: price.max } : null,
		attributes: [...groups.values()]
			.sort((a, b) => a.field.sort - b.field.sort || a.field.name.localeCompare(b.field.name))
			.map(({ field, list }) => ({
				id: field.id,
				slug: field.slug,
				name: field.name,
				unit: field.unit,
				type: field.type,
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
 * The products sold in a unit of their own (their stock counts thousandths of their unit, `core/measure.js`):
 * physical products whose own type is a measured one, or with no type of their own whose first category's type is.
 * @typedef {{ keys: string[], categoryIds: string[] }} MeasuredScope
 */

/**
 * A match of the products of a {@link MeasuredScope}.
 * @param {MeasuredScope} scope
 */
const measuredMatch = (scope) => ({
	kind: 'physical',
	$or: [{ typeKey: { $in: scope.keys } }, { typeKey: { $in: [null, ''] }, 'categoryIds.0': { $in: scope.categoryIds } }],
});

/**
 * The same as an aggregation expression over a product.
 * @param {MeasuredScope} scope
 */
const measuredExpr = (scope) => ({
	$and: [
		{ $eq: ['$kind', 'physical'] },
		{
			$or: [
				{ $in: [{ $ifNull: ['$typeKey', ''] }, scope.keys] },
				{
					$and: [
						{ $eq: [{ $ifNull: ['$typeKey', ''] }, ''] },
						{ $in: [{ $arrayElemAt: [{ $ifNull: ['$categoryIds', []] }, 0] }, scope.categoryIds] },
					],
				},
			],
		},
	],
});

/**
 * A variant low on stock (E44, EN-18, PL-14), as a variant match: offered (active), not marked sold out, with more than
 * 0 and at most `level` units. Level 0: no variant is low.
 * @param {number} level the `catalog` setting `lowStock`
 */
const lowVariantMatch = (level) => ({ active: true, soldOut: { $ne: true }, stock: { $gt: 0, $lte: level } });

/**
 * Products with a variant low on stock (E44): products that track stock and are not archived. The level counts units:
 * a measured product's stock is compared in thousandths of its unit.
 * @param {number} level the `catalog` setting `lowStock`
 * @param {MeasuredScope | null} [scope] the measured products (null: none)
 */
const lowStockFilter = (level, scope = null) => ({
	trackStock: true,
	status: { $ne: 'archived' },
	...(scope
		? {
				$or: [
					{ $and: [measuredMatch(scope), { variants: { $elemMatch: lowVariantMatch(levelOf(level, true)) } }] },
					{ $and: [{ $nor: [measuredMatch(scope)] }, { variants: { $elemMatch: lowVariantMatch(level) } }] },
				],
			}
		: { variants: { $elemMatch: lowVariantMatch(level) } }),
});

/**
 * Whether a variant counts for stock levels (E44): its product tracks stock and is not archived, and it is offered and
 * not marked sold out.
 * @param {Pick<ProductRecord, 'trackStock' | 'status'>} product
 * @param {Pick<VariantRecord, 'active' | 'soldOut'>} variant
 */
export const countsForStock = (product, variant) =>
	product.trackStock && product.status !== 'archived' && variant.active && !variant.soldOut;

/**
 * The stock event a variant's move calls for (E44's levels): `stock.out` when its units drop to 0, `stock.low` when they
 * drop from above `level` into 1 to `level`; null for a rise, a drop within the same range, or level 0 for low.
 * @param {number} before units before the move
 * @param {number} after units after it
 * @param {number} level the `catalog` setting `lowStock`
 * @returns {'stock.out' | 'stock.low' | null}
 */
export const stockEventOf = (before, after, level) => {
	if (after >= before) return null;
	if (after <= 0) return 'stock.out';
	return after <= level && before > level ? 'stock.low' : null;
};

/** The groups of a count of variants by stock (E44). */
const VARIANT_STOCK = Object.freeze(/** @type {const} */ (['out', 'low', 'in']));

/**
 * The stages that count variants by stock (E44), after a `$match` on the website: the offered variants of products
 * that track stock and are not archived, `out` (no units, or marked sold out), `low` (1 to `level` units; a measured
 * product's in thousandths of its unit) or `in` (more).
 * @param {number} level the `catalog` setting `lowStock`
 * @param {MeasuredScope | null} [scope] the measured products (null: none)
 */
export const variantStockStages = (level, scope = null) => [
	{ $match: { trackStock: true, status: { $ne: 'archived' } } },
	{ $addFields: { lowLevel: scope ? { $cond: [measuredExpr(scope), levelOf(level, true), level] } : level } },
	{ $unwind: '$variants' },
	{ $match: { 'variants.active': true } },
	{
		$group: {
			_id: {
				$switch: {
					branches: [
						{
							case: { $or: [{ $eq: ['$variants.soldOut', true] }, { $lte: [{ $ifNull: ['$variants.stock', 0] }, 0] }] },
							then: 'out',
						},
						{ case: { $lte: ['$variants.stock', '$lowLevel'] }, then: 'low' },
					],
					default: 'in',
				},
			},
			n: { $sum: 1 },
		},
	},
];

/**
 * Counts of variants by stock (E44), as a pipeline over the products a list's filter keeps.
 * @param {string} websiteId
 * @param {Record<string, unknown>} match the products to look at (a list's filter, without `websiteId`)
 * @param {number} level the `catalog` setting `lowStock`
 * @param {MeasuredScope | null} [scope] the measured products (null: none)
 */
export const variantStockPipeline = (websiteId, match, level, scope = null) => [
	{ $match: { websiteId, $and: [match] } },
	...variantStockStages(level, scope),
];

/**
 * The counts of {@link variantStockStages}' rows, every group present.
 * @param {ReadonlyArray<{ _id: unknown, n: unknown }>} rows
 * @returns {{ out: number, low: number, in: number }}
 */
export const variantStockCounts = (rows) => {
	const counts = { out: 0, low: 0, in: 0 };
	for (const row of rows)
		if (VARIANT_STOCK.includes(/** @type {any} */ (row._id)))
			counts[/** @type {'out' | 'low' | 'in'} */ (row._id)] = Number(row.n);
	return counts;
};

/**
 * Where a product or variant field's values are kept on a product record (E24): `specs.<id>` or, on any of its
 * variants, `variants.attributes.<id>`.
 * @param {Pick<AttributeRecord, 'id' | 'on'>} field
 */
export const fieldPath = (field) => (field.on === 'product' ? `specs.${field.id}` : `variants.attributes.${field.id}`);

/**
 * The staff list's field filters (E24): `attr.<slug or id>=value[,value]` for the active product and variant fields
 * marked filterable, as the shop's listing takes them (a product's own value, or any of its variants'); a field not
 * marked filterable matches nothing.
 * @param {Record<string, string>} query
 * @param {ReadonlyMap<string, AttributeRecord>} attributes every field by id
 * @returns {Record<string, unknown>[]}
 */
const staffFieldFilters = (query, attributes) => {
	/** @type {Record<string, unknown>[]} */
	const and = [];
	for (const [name, value] of Object.entries(query)) {
		if (!name.startsWith('attr.')) continue;
		const values = listOf(value);
		if (values.length === 0 || and.length >= MAX_VALUES) continue;
		const fields = fieldsNamed(attributes, name.slice('attr.'.length));
		and.push(
			fields.length === 0
				? { id: { $in: [] } }
				: { $or: fields.map((field) => ({ [fieldPath(field)]: { $in: storedValues(field, values) } })) },
		);
	}
	return and;
};

/**
 * The staff's product list filter (the caller adds `websiteId`).
 * @param {Record<string, string>} query `q`, `status`, `kind`, `lowStock`, `featured`, `stockState` (one or several),
 *   `hasMedia`, `grade` (one or several), `ids` (product ids, at most 20), `attr.<slug or id>` (E24)
 * @param {{ categoryIds: string[] | null, brandIds: string[] | null, lowStock: number,
 *   measured?: MeasuredScope | null, attributes?: ReadonlyMap<string, AttributeRecord> }} resolved `measured`: the
 *   products sold in a unit of their own; `attributes`: every field by id, for `attr.` filters
 * @returns {Record<string, unknown>}
 */
export const staffFilter = (query, resolved) => {
	/** @type {Record<string, unknown>[]} */
	const and = [];
	const search = searchFilter(query.q ?? '');
	if (search) and.push(search);
	if (['draft', 'active', 'archived'].includes(query.status ?? '')) and.push({ status: query.status });
	if (['physical', 'digital', 'service'].includes(query.kind ?? '')) and.push({ kind: query.kind });
	if (resolved.categoryIds) and.push({ categoryIds: { $in: resolved.categoryIds } });
	if (resolved.brandIds) and.push({ brandId: { $in: resolved.brandIds } });
	if (query.lowStock === 'true' || query.lowStock === '1') and.push(lowStockFilter(resolved.lowStock, resolved.measured));
	if (query.featured === 'true' || query.featured === '1') and.push({ featured: true });
	if (query.featured === 'false' || query.featured === '0') and.push({ featured: { $ne: true } });
	const states = listOf(query.stockState).filter((state) => STOCK_STATES.includes(state));
	if (states.length > 0) and.push({ stockState: { $in: states } });
	if (query.hasMedia === 'true' || query.hasMedia === '1') and.push({ 'media.0': { $exists: true } });
	if (query.hasMedia === 'false' || query.hasMedia === '0') and.push({ 'media.0': { $exists: false } });
	const grades = listOf(query.grade);
	if (grades.length > 0) and.push({ grades: { $in: grades } });
	const ids = listOf(query.ids);
	if (ids.length > 0) and.push({ id: { $in: ids } });
	if (resolved.attributes) and.push(...staffFieldFilters(query, resolved.attributes));
	return and.length === 0 ? {} : { $and: and };
};
