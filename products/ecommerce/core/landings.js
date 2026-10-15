/**
 * Landing pages (PLAN 0.8.10 E15, dynamic model §6): a category, a brand and a facet — one value of a field shoppers
 * filter by: a grade or a product or variant field by its slug — (at least one of them) with its own heading, title,
 * description, introduction and FAQs, indexed by search engines as `indexable` says (`auto`: while at least
 * `landingMinProducts` of its products and `autoMinInStockVariants` of their variants are in stock, judged on read;
 * SG-10). Automatic landing pages (E43, the `landing_pages` setting `auto`): every category and brand combination (with
 * `category_brand_facet` also with each value of the field `autoFacet`) with at least `autoMinProducts` products and
 * `autoMinInStockVariants` variants in stock is a landing page without a stored record (a stored one wins). Its address
 * is the `landing_pages` setting `landingUrl` with `{categoryUrl}`, `{category}`, `{brand}`, `{facet}` (the listing
 * parameter: `grade` or `attr.<slug>`) and `{value}`; query pairs with an empty name or value are left out. No I/O.
 * @module
 */
import { cleanText, isObject } from './catalog.js';
import { checkFaqs } from './catalog-content.js';
import { MAX_FAQS } from './catalog-taxonomy.js';

/** @typedef {import('./model.js').LandingRecord} LandingRecord */
/** @typedef {import('./model.js').LandingFacet} LandingFacet */
/** @typedef {import('./catalog.js').FieldError} FieldError */

/** Limits of a landing page's copy. */
const LANDING_LIMITS = Object.freeze({ h1: 200, title: 200, description: 500, intro: 5000, value: 100 });

/** The facet field of grades; any other is a field's slug. */
export const GRADE_FACET = 'grade';

/** A facet's field: `grade` or a field's slug (lowercase letters, digits and `-`). */
const FACET_FIELD = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The default address of a landing page. */
export const DEFAULT_LANDING_URL = '{categoryUrl}?brand={brand}&{facet}={value}';

/** @typedef {Omit<LandingRecord, 'id'>} LandingFields */

/**
 * Read a facet: `{ field, value }` (the value as a listing takes it, at most 100 characters) or null.
 * @param {unknown} input
 * @returns {LandingFacet | null | undefined} undefined when it is not one
 */
export const readFacet = (input) => {
	if (input === null) return null;
	if (!isObject(input) || typeof input.field !== 'string' || !FACET_FIELD.test(input.field)) return undefined;
	const value =
		typeof input.value === 'number' || typeof input.value === 'boolean'
			? String(input.value)
			: cleanText(input.value, LANDING_LIMITS.value);
	return value ? { field: input.field, value } : undefined;
};

/**
 * Check a new landing page or changes to one (what the category, brand and facet name is checked by the route).
 * @param {unknown} body
 * @param {LandingRecord | null} existing
 * @returns {{ ok: true, value: LandingFields } | { ok: false, errors: FieldError[] }}
 */
export const checkLanding = (body, existing) => {
	if (!isObject(body)) return { ok: false, errors: [{ path: '', message: 'Send the landing page as an object.' }] };
	/** @type {FieldError[]} */
	const errors = [];
	/** @param {'categoryId' | 'brandId'} name */
	const ref = (name) => {
		if (body[name] === undefined) return existing?.[name] ?? null;
		if (body[name] === null || body[name] === '') return null;
		if (typeof body[name] === 'string' && body[name].length <= 64) return /** @type {string} */ (body[name]);
		errors.push({ path: `/${name}`, message: 'Give an id, or null.' });
		return existing?.[name] ?? null;
	};
	const categoryId = ref('categoryId');
	const brandId = ref('brandId');
	let facet = existing?.facet ?? null;
	if (body.facet !== undefined) {
		const read = readFacet(body.facet);
		if (read === undefined)
			errors.push({
				path: '/facet',
				message: `Give the facet as { field, value }: grade or a field's slug, and one value of at most ${LANDING_LIMITS.value} characters; or null.`,
			});
		else facet = read;
	}
	if (!categoryId && !brandId && !facet)
		errors.push({ path: '/categoryId', message: 'A landing page names a category, a brand or a facet.' });
	/** @param {'h1' | 'title' | 'description' | 'intro'} name */
	const copy = (name) => {
		if (body[name] === undefined) return existing?.[name] ?? '';
		const text = cleanText(body[name], LANDING_LIMITS[name], { multiline: name === 'intro' });
		if (text === null) errors.push({ path: `/${name}`, message: `This text has at most ${LANDING_LIMITS[name]} characters.` });
		return text ?? existing?.[name] ?? '';
	};
	const h1 = copy('h1');
	const title = copy('title');
	const description = copy('description');
	const intro = copy('intro');
	let faqs = existing?.faqs ?? [];
	if (body.faqs !== undefined) faqs = checkFaqs(body.faqs, MAX_FAQS, '/faqs', errors) ?? faqs;
	const indexable = body.indexable === undefined ? (existing?.indexable ?? 'auto') : body.indexable;
	if (!['auto', 'yes', 'no'].includes(indexable)) errors.push({ path: '/indexable', message: 'Indexable is auto, yes or no.' });
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			categoryId,
			brandId,
			facet,
			h1,
			title,
			description,
			intro,
			faqs,
			indexable: /** @type {'auto' | 'yes' | 'no'} */ (indexable),
		},
	};
};

/**
 * What a combination has in stock: products (each once), variants, the lowest price of those variants (null without
 * any) and the newest content change of those products (`contentUpdatedAt`, null without any: the page's `lastmod`).
 * @typedef {{ products: number, variants: number, minPrice: number | null, lastmod: Date | null }} ComboStock
 */

/** @typedef {{ categoryId: string | null, brandId: string | null, facet: LandingFacet | null }} Combination */

/** Nothing in stock. @type {Readonly<ComboStock>} */
export const NO_STOCK = Object.freeze({ products: 0, variants: 0, minPrice: null, lastmod: null });

/**
 * Whether a landing page reaches the numbers to be indexed: `yes`, `no`, or with `auto` while at least `minProducts` of
 * its products and `minVariants` of their variants are in stock (SG-10); one indexed before stays indexed while it has
 * any product (G7.7, the route remembers it).
 * @param {Pick<LandingRecord, 'indexable'>} landing
 * @param {Pick<ComboStock, 'products' | 'variants'>} stock
 * @param {{ minProducts: number, minVariants: number }} minimum the `landingMinProducts` (stored pages) or
 *   `autoMinProducts` (automatic ones) and `autoMinInStockVariants` settings
 */
export const isIndexable = (landing, stock, { minProducts, minVariants }) =>
	landing.indexable === 'yes' ||
	(landing.indexable === 'auto' && stock.products >= minProducts && stock.variants >= minVariants);

/**
 * Whether a combination is one the `auto` setting makes automatic landing pages of (E43): a category and a brand, and
 * with `category_brand_facet` also a value of the field `autoFacet`.
 * @param {{ auto: unknown, autoFacet?: unknown }} rules the `landing_pages` settings `auto` and `autoFacet`
 * @param {Combination} combination
 */
export const isAutomatic = ({ auto, autoFacet }, { categoryId, brandId, facet }) =>
	(auto === 'category_brand' || auto === 'category_brand_facet') &&
	Boolean(categoryId) &&
	Boolean(brandId) &&
	(facet === null || (auto === 'category_brand_facet' && Boolean(autoFacet) && facet.field === autoFacet));

/**
 * A combination's key in a {@link comboStock} table and in the memory of pages indexed before (`category|brand|field=value`,
 * the value URI-encoded).
 * @param {Combination} combination
 */
export const comboKey = ({ categoryId, brandId, facet }) =>
	`${categoryId ?? ''}|${brandId ?? ''}|${facet ? `${facet.field}=${encodeURIComponent(facet.value)}` : ''}`;

/**
 * The combination of a {@link comboKey}.
 * @param {string} key
 * @returns {Combination}
 */
export const comboOfKey = (key) => {
	const [categoryId = '', brandId = '', facet = ''] = key.split('|');
	const at = facet.indexOf('=');
	let value = '';
	try {
		value = at > 0 ? decodeURIComponent(facet.slice(at + 1)) : '';
	} catch {
		value = '';
	}
	return {
		categoryId: categoryId || null,
		brandId: brandId || null,
		facet: at > 0 && value ? { field: facet.slice(0, at), value } : null,
	};
};

/** The newer of two times (null: none). @param {Date | null} a @param {unknown} b @returns {Date | null} */
const newer = (a, b) => (b instanceof Date && (a === null || b > a) ? b : a);

/**
 * A facet value as a listing takes it: numbers and yes/no as text; a field with several values gives each.
 * @param {unknown} raw
 * @returns {string[]}
 */
export const facetValues = (raw) => {
	const all = Array.isArray(raw) ? raw : [raw];
	return [
		...new Set(
			all
				.filter((value) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
				.map(String)
				.filter((value) => value !== '' && value.length <= LANDING_LIMITS.value),
		),
	];
};

/**
 * The stock of every category (with those above it), brand and facet value combination at once (E43, SG-10), from rows
 * of the in-stock variants grouped by product and facet value (`{ _id: { p, g }, c: categoryIds, b: brandId, n, min,
 * at }`, `g` the value, or values, of `field`; null without one): a product counts once in each combination, its variants
 * of the value (or all, without one) are added up; a product of a brand hidden in a category (`hiddenIn`, parity P3-12)
 * counts in none of that category's combinations, nor of those below it, as their listings leave it out.
 * @param {ReadonlyArray<any>} rows
 * @param {(categoryId: string) => string[]} above the ids of the categories above one
 * @param {{ field?: string | null, hiddenIn?: (brandId: string) => string[] }} [options] `field`: the facet field the
 *   rows are grouped by; `hiddenIn`: the categories a brand is hidden in
 * @returns {Map<string, ComboStock>}
 */
export const comboStock = (rows, above, { field = null, hiddenIn = () => [] } = {}) => {
	/** @type {Map<string, { products: Set<string>, variants: number, minPrice: number | null, lastmod: Date | null }>} */
	const table = new Map();
	for (const row of rows) {
		/** @type {string[]} */
		const own = Array.isArray(row.c) ? row.c.map(String) : [];
		const categories = [null, ...new Set(own.flatMap((id) => [id, ...above(id)]))];
		const brands = row.b ? [null, String(row.b)] : [null];
		/** @type {Array<LandingFacet | null>} */
		const facets = [null, ...(field ? facetValues(row._id?.g).map((value) => ({ field, value })) : [])];
		const out = row.b ? hiddenIn(String(row.b)) : [];
		for (const categoryId of categories) {
			if (categoryId !== null && out.length > 0 && [categoryId, ...above(categoryId)].some((id) => out.includes(id))) continue;
			for (const brandId of brands)
				for (const facet of facets) {
					if (categoryId === null && brandId === null && facet === null) continue;
					const key = comboKey({ categoryId, brandId, facet });
					const entry = table.get(key) ?? { products: new Set(), variants: 0, minPrice: null, lastmod: null };
					entry.products.add(String(row._id?.p));
					entry.variants += Number(row.n);
					entry.lastmod = newer(entry.lastmod, row.at);
					const min = typeof row.min === 'number' ? row.min : null;
					if (min !== null && (entry.minPrice === null || min < entry.minPrice)) entry.minPrice = min;
					table.set(key, entry);
				}
		}
	}
	return new Map(
		[...table.entries()].map(([key, entry]) => [
			key,
			{ products: entry.products.size, variants: entry.variants, minPrice: entry.minPrice, lastmod: entry.lastmod },
		]),
	);
};

/**
 * Where a facet field's values are: the variant's grade, or the fields with its slug on variants
 * (`attributes.<id>`) and on products (`specs.<id>`).
 * @typedef {{ grade: true } | { variantIds: string[], productIds: string[] }} FacetPlace
 */

/**
 * A facet field's value of an unwound variant, as an aggregation expression: the grade, or the first of its fields
 * that holds one (the variant's own, then the product's).
 * @param {FacetPlace} place
 */
const facetExpression = (place) => {
	if ('grade' in place) return '$variants.grade';
	const paths = [...place.variantIds.map((id) => `$variants.attributes.${id}`), ...place.productIds.map((id) => `$specs.${id}`)];
	return paths.reduceRight((/** @type {unknown} */ rest, path) => ({ $ifNull: [path, rest] }), null);
};

/**
 * The stages after a match of in-stock products that give {@link comboStock} its rows: their sellable variants grouped
 * by product and the value of the facet field (`group`); with `only`, only the variants of that facet value (stored
 * as `stored`: a number field's value is a number).
 * @param {{ group?: FacetPlace | null, only?: { place: FacetPlace, stored: unknown } | null }} [options]
 */
export const stockStages = ({ group = null, only = null } = {}) => {
	/** @type {Record<string, unknown> | null} */
	let match = null;
	if (only)
		match =
			'grade' in only.place
				? { 'variants.grade': only.stored }
				: {
						$or: [
							...only.place.variantIds.map((id) => ({ [`variants.attributes.${id}`]: only.stored })),
							...only.place.productIds.map((id) => ({ [`specs.${id}`]: only.stored })),
						],
					};
	return [
		{ $unwind: '$variants' },
		{
			$match: {
				'variants.active': true,
				'variants.soldOut': { $ne: true },
				$and: [{ $or: [{ trackStock: false }, { 'variants.stock': { $gt: 0 } }] }, ...(match ? [match] : [])],
			},
		},
		{
			$group: {
				_id: { p: '$id', g: group ? facetExpression(group) : null },
				c: { $first: '$categoryIds' },
				b: { $first: '$brandId' },
				n: { $sum: 1 },
				min: { $min: '$variants.price' },
				at: { $first: '$contentUpdatedAt' },
			},
		},
	];
};

/**
 * The stock of one combination from rows of {@link stockStages} (its products already matched).
 * @param {ReadonlyArray<any>} rows
 * @returns {ComboStock}
 */
export const stockOf = (rows) => {
	const products = new Set(rows.map((row) => String(row._id?.p)));
	/** @type {number[]} */
	const prices = rows.map((row) => row.min).filter((min) => typeof min === 'number');
	return {
		products: products.size,
		variants: rows.reduce((sum, row) => sum + Number(row.n), 0),
		minPrice: prices.length > 0 ? Math.min(...prices) : null,
		lastmod: rows.reduce((/** @type {Date | null} */ at, row) => newer(at, row.at), null),
	};
};

/**
 * The listing parameter of a facet: `grade`, or `attr.<slug>` for a field.
 * @param {LandingFacet | null} facet
 */
export const facetParameter = (facet) => (facet ? (facet.field === GRADE_FACET ? GRADE_FACET : `attr.${facet.field}`) : '');

/**
 * A landing page's address on the merchant's website: the template's placeholders filled (`{facet}` the listing
 * parameter, `{value}` the value; each URI-encoded but `{categoryUrl}`), query pairs with an empty name or value left
 * out.
 * @param {string} template the `landingUrl` setting
 * @param {{ categoryUrl: string, category: string, brand: string, facet: LandingFacet | null }} values slugs ('' when not set)
 * @param {string} domain
 */
export const landingLink = (template, { categoryUrl, category, brand, facet }, domain) => {
	const filled = String(template || DEFAULT_LANDING_URL)
		.replaceAll('{categoryUrl}', categoryUrl || `https://${domain}/`)
		.replaceAll('{category}', encodeURIComponent(category))
		.replaceAll('{brand}', encodeURIComponent(brand))
		.replaceAll('{facet}', encodeURIComponent(facetParameter(facet)).replaceAll('%2E', '.'))
		.replaceAll('{value}', encodeURIComponent(facet?.value ?? ''));
	const [path = '', query] = filled.split('?');
	const pairs = (query ?? '').split('&').filter((pair) => {
		const at = pair.indexOf('=');
		return pair !== '' && at > 0 && at < pair.length - 1;
	});
	const address = /^https:\/\//.test(path) ? path : `https://${domain}${path.startsWith('/') ? '' : '/'}${path}`;
	return pairs.length > 0 ? `${address}?${pairs.join('&')}` : address;
};

/**
 * Whether two facets are the same (both none, or the same field and value).
 * @param {LandingFacet | null} a
 * @param {LandingFacet | null} b
 */
export const sameFacet = (a, b) => (a === null || b === null ? a === b : a.field === b.field && a.value === b.value);

/**
 * The landing page that matches a listing's filters exactly (a category, one brand and one facet value, each or none).
 * @param {ReadonlyArray<LandingRecord>} landings
 * @param {Combination} wanted
 */
export const landingFor = (landings, { categoryId, brandId, facet }) =>
	landings.find(
		(landing) => landing.categoryId === categoryId && landing.brandId === brandId && sameFacet(landing.facet, facet),
	) ?? null;

/**
 * The stored query of a combination (a facet by its field and value; none: no facet).
 * @param {Combination} combination
 */
export const comboQuery = ({ categoryId, brandId, facet }) => ({
	categoryId,
	brandId,
	...(facet ? { 'facet.field': facet.field, 'facet.value': facet.value } : { facet: null }),
});
