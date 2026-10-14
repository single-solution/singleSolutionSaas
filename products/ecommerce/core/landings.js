/**
 * Landing pages (PLAN 0.8.10 E15): a category, brand and grade combination (at least one of them) with its own heading,
 * title, description, introduction and FAQs, indexed by search engines as `indexable` says (`auto`: while at least
 * `landingMinProducts` of its products and `autoMinInStockVariants` of their variants are in stock, judged on read;
 * SG-10). Automatic landing pages (E43, the `landing_pages` setting `auto`): every category and brand (and grade)
 * combination with at least `autoMinProducts` products and `autoMinInStockVariants` variants in stock is a landing
 * page without a stored record (a stored one wins). Its address is the `landing_pages` setting `landingUrl` with
 * `{categoryUrl}`, `{category}`, `{brand}` and `{grade}`; query pairs with an empty value are left out. No I/O.
 * @module
 */
import { cleanText, isObject } from './catalog.js';
import { checkFaqs } from './catalog-content.js';
import { MAX_FAQS } from './catalog-taxonomy.js';

/** @typedef {import('./model.js').LandingRecord} LandingRecord */
/** @typedef {import('./catalog.js').FieldError} FieldError */

/** Limits of a landing page's copy. */
const LANDING_LIMITS = Object.freeze({ h1: 200, title: 200, description: 500, intro: 5000 });

/** @typedef {Omit<LandingRecord, 'id'>} LandingFields */

/**
 * Check a new landing page or changes to one (the category, brand and grade are checked by the route).
 * @param {unknown} body
 * @param {LandingRecord | null} existing
 * @returns {{ ok: true, value: LandingFields } | { ok: false, errors: FieldError[] }}
 */
export const checkLanding = (body, existing) => {
	if (!isObject(body)) return { ok: false, errors: [{ path: '', message: 'Send the landing page as an object.' }] };
	/** @type {FieldError[]} */
	const errors = [];
	/** @param {'categoryId' | 'brandId' | 'grade'} name */
	const ref = (name) => {
		if (body[name] === undefined) return existing?.[name] ?? null;
		if (body[name] === null || body[name] === '') return null;
		if (typeof body[name] === 'string' && body[name].length <= 64) return /** @type {string} */ (body[name]);
		errors.push({ path: `/${name}`, message: 'Give an id, or null.' });
		return existing?.[name] ?? null;
	};
	const categoryId = ref('categoryId');
	const brandId = ref('brandId');
	const grade = ref('grade');
	if (!categoryId && !brandId && !grade)
		errors.push({ path: '/categoryId', message: 'A landing page names a category, a brand or a grade.' });
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
			grade,
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
 * What a combination has in stock: products (each once), variants, and the lowest price of those variants (null
 * without any).
 * @typedef {{ products: number, variants: number, minPrice: number | null }} ComboStock
 */

/** @typedef {{ categoryId: string | null, brandId: string | null, grade: string | null }} Combination */

/** Nothing in stock. @type {Readonly<ComboStock>} */
export const NO_STOCK = Object.freeze({ products: 0, variants: 0, minPrice: null });

/**
 * Whether search engines index a landing page: `yes`, `no`, or with `auto` while at least `minProducts` of its
 * products and `minVariants` of their variants are in stock (SG-10).
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
 * with `category_brand_grade` also a grade.
 * @param {unknown} mode the `landing_pages` setting `auto`
 * @param {Combination} combination
 */
export const isAutomatic = (mode, { categoryId, brandId, grade }) =>
	(mode === 'category_brand' || mode === 'category_brand_grade') &&
	Boolean(categoryId) &&
	Boolean(brandId) &&
	(grade === null || mode === 'category_brand_grade');

/**
 * A combination's key in a {@link comboStock} table.
 * @param {Combination} combination
 */
export const comboKey = ({ categoryId, brandId, grade }) => `${categoryId ?? ''}|${brandId ?? ''}|${grade ?? ''}`;

/**
 * The stock of every category (with those above it), brand and grade combination at once (E43, SG-10), from rows of
 * the in-stock variants grouped by product and grade (`{ _id: { p, g }, c: categoryIds, b: brandId, n, min }`): a
 * product counts once in each combination, its variants of the grade (or all, without one) are added up.
 * @param {ReadonlyArray<any>} rows
 * @param {(categoryId: string) => string[]} above the ids of the categories above one
 * @returns {Map<string, ComboStock>}
 */
export const comboStock = (rows, above) => {
	/** @type {Map<string, { products: Set<string>, variants: number, minPrice: number | null }>} */
	const table = new Map();
	for (const row of rows) {
		/** @type {string[]} */
		const own = Array.isArray(row.c) ? row.c.map(String) : [];
		const categories = [null, ...new Set(own.flatMap((id) => [id, ...above(id)]))];
		const brands = row.b ? [null, String(row.b)] : [null];
		const grades = row._id?.g ? [null, String(row._id.g)] : [null];
		for (const categoryId of categories)
			for (const brandId of brands)
				for (const grade of grades) {
					if (categoryId === null && brandId === null && grade === null) continue;
					const key = comboKey({ categoryId, brandId, grade });
					const entry = table.get(key) ?? { products: new Set(), variants: 0, minPrice: null };
					entry.products.add(String(row._id?.p));
					entry.variants += Number(row.n);
					const min = typeof row.min === 'number' ? row.min : null;
					if (min !== null && (entry.minPrice === null || min < entry.minPrice)) entry.minPrice = min;
					table.set(key, entry);
				}
	}
	return new Map(
		[...table.entries()].map(([key, entry]) => [
			key,
			{ products: entry.products.size, variants: entry.variants, minPrice: entry.minPrice },
		]),
	);
};

/**
 * The stages after a match of in-stock products that give {@link comboStock} its rows (and, with `grade`, only that
 * grade's variants): their sellable variants grouped by product and grade.
 * @param {string | null} [grade]
 */
export const stockStages = (grade = null) => [
	{ $unwind: '$variants' },
	{
		$match: {
			'variants.active': true,
			'variants.soldOut': { $ne: true },
			$or: [{ trackStock: false }, { 'variants.stock': { $gt: 0 } }],
			...(grade ? { 'variants.grade': grade } : {}),
		},
	},
	{
		$group: {
			_id: { p: '$id', g: '$variants.grade' },
			c: { $first: '$categoryIds' },
			b: { $first: '$brandId' },
			n: { $sum: 1 },
			min: { $min: '$variants.price' },
		},
	},
];

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
	};
};

/**
 * A landing page's address on the merchant's website.
 * @param {string} template the `landingUrl` setting
 * @param {{ categoryUrl: string, category: string, brand: string, grade: string }} values slugs ('' when not set)
 * @param {string} domain
 */
export const landingLink = (template, { categoryUrl, category, brand, grade }, domain) => {
	const filled = String(template || '{categoryUrl}?brand={brand}&grade={grade}')
		.replaceAll('{categoryUrl}', categoryUrl || `https://${domain}/`)
		.replaceAll('{category}', encodeURIComponent(category))
		.replaceAll('{brand}', encodeURIComponent(brand))
		.replaceAll('{grade}', encodeURIComponent(grade));
	const [path = '', query] = filled.split('?');
	const pairs = (query ?? '').split('&').filter((pair) => pair !== '' && !/^[^=]+=$/.test(pair));
	const address = /^https:\/\//.test(path) ? path : `https://${domain}${path.startsWith('/') ? '' : '/'}${path}`;
	return pairs.length > 0 ? `${address}?${pairs.join('&')}` : address;
};

/**
 * The landing page that matches a listing's filters exactly (a category, one brand and one grade, each or none).
 * @param {ReadonlyArray<LandingRecord>} landings
 * @param {{ categoryId: string | null, brandId: string | null, grade: string | null }} wanted
 */
export const landingFor = (landings, { categoryId, brandId, grade }) =>
	landings.find((landing) => landing.categoryId === categoryId && landing.brandId === brandId && landing.grade === grade) ??
	null;
