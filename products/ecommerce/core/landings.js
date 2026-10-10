/**
 * Landing pages (PLAN 0.8.10 E15): a category, brand and grade combination (at least one of them) with its own heading,
 * title, description, introduction and FAQs, indexed by search engines as `indexable` says (`auto`: while at least
 * `landingMinProducts` of its products are in stock, judged on read). Its address is the `landing_pages` setting
 * `landingUrl` with `{categoryUrl}`, `{category}`, `{brand}` and `{grade}`; query pairs with an empty value are left
 * out. No I/O.
 * @module
 */
import { cleanText, isObject } from './catalog.js';
import { checkFaqs } from './catalog-content.js';
import { MAX_FAQS } from './catalog-taxonomy.js';

/** @typedef {import('./model.js').LandingRecord} LandingRecord */
/** @typedef {import('./catalog.js').FieldError} FieldError */

/** Limits of a landing page's copy. */
export const LANDING_LIMITS = Object.freeze({ h1: 200, title: 200, description: 500, intro: 5000 });

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
 * Whether search engines index a landing page: `yes`, `no`, or with `auto` while at least `minimum` of its products are
 * in stock.
 * @param {Pick<LandingRecord, 'indexable'>} landing
 * @param {number} inStock its products in stock
 * @param {number} minimum the `landingMinProducts` setting
 */
export const isIndexable = (landing, inStock, minimum) =>
	landing.indexable === 'yes' || (landing.indexable === 'auto' && inStock >= minimum);

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
