/**
 * Categories, brands, attributes and stock locations (PLAN 0.8.8 Catalog): their checks, the nested category tree
 * (each category keeps the ids of its ancestors in `path`; a move must not create a cycle and rewrites the paths of the
 * moved branch), and the tree with product counts shown to shoppers. No I/O.
 * @module
 */
import { LIMITS, cleanText, isObject, isSlug } from './catalog.js';
import { EMPTY_CONTENT, checkContent, checkFaqs, checkSeo, iconOf } from './catalog-content.js';
import {
	FIELD_DATES,
	FIELD_LIMITS,
	FIELD_ON,
	FIELD_TYPES,
	REQUIRED_AT,
	checkFormatRule,
	checkShow,
	showDefaults,
} from './fields.js';

/** @typedef {import('./model.js').CategoryRecord} CategoryRecord */
/** @typedef {import('./model.js').BrandRecord} BrandRecord */
/** @typedef {import('./model.js').AttributeRecord} AttributeRecord */
/** @typedef {import('./model.js').LocationRecord} LocationRecord */
/** @typedef {import('./model.js').AttributeChoice} AttributeChoice */
/** @typedef {import('./model.js').AttributeVisibility} AttributeVisibility */
/** @typedef {import('./catalog.js').FieldError} FieldError */
/** @typedef {import('./fields.js').FieldOn} FieldOn */
/** @typedef {import('./fields.js').FieldType} FieldType */

/** Category statuses (E1): coming soon is listed with its products hidden; hidden is neither. */
export const CATEGORY_STATUSES = Object.freeze(/** @type {const} */ (['active', 'coming_soon', 'hidden']));
/** Brand statuses (E1). */
export const BRAND_STATUSES = Object.freeze(/** @type {const} */ (['active', 'hidden']));
/** When an attribute is shown (E7). */
const VISIBILITY = Object.freeze(/** @type {const} */ (['always', 'brands', 'grades', 'attribute']));
/** At most this many FAQs on a category, a brand, a product, a glossary page or a landing page. */
export const MAX_FAQS = 20;
/** Most categories a brand or an attribute is limited to. */
const MAX_SCOPE = 200;
/** Longest glossary text. */
const GLOSSARY_BODY = 20_000;

/** Limits of the catalog's records. */
const TAXONOMY_LIMITS = Object.freeze({
	name: 120,
	description: 5000,
	choices: 100,
	choice: LIMITS.specText,
	unit: 20,
	sort: 1_000_000,
	depth: 10,
});

/**
 * @param {Record<string, any>} input
 * @param {Record<string, any> | null} existing
 * @param {FieldError[]} errors
 */
const reader =
	(input, existing, errors) =>
	/**
	 * @template T
	 * @param {string} name
	 * @param {(value: unknown) => T | null} read null = invalid
	 * @param {T} fallback
	 * @param {string} message
	 * @returns {T}
	 */
	(name, read, fallback, message) => {
		const before = existing && name in existing ? existing[name] : fallback;
		if (input[name] === undefined) return before;
		const value = read(input[name]);
		if (value === null) {
			errors.push({ path: `/${name}`, message });
			return before;
		}
		return value;
	};

/** @param {unknown} v */
const nameOf = (v) => cleanText(v, TAXONOMY_LIMITS.name) || null;
/** @param {unknown} v */
const slugOf = (v) => (v === '' ? '' : isSlug(v) ? v : null);
/** @param {unknown} v */
const sortOf = (v) => (Number.isSafeInteger(v) && Math.abs(Number(v)) <= TAXONOMY_LIMITS.sort ? Number(v) : null);
/** @param {unknown} v */
const boolOf = (v) => (typeof v === 'boolean' ? v : null);

const NAME_MESSAGE = `Give a name of 1 to ${TAXONOMY_LIMITS.name} characters.`;
const SLUG_MESSAGE = 'Use lowercase letters, digits and dashes.';
const SORT_MESSAGE = 'Sort is a whole number.';

/** @typedef {'active' | 'coming_soon' | 'hidden'} CategoryStatus */
/**
 * The editable fields of a category.
 * @typedef {Pick<CategoryRecord, 'name' | 'slug' | 'description' | 'seo' | 'sort'> & { parentId: string | null,
 *   status: CategoryStatus, icon: string, content: import('./catalog-content.js').Content,
 *   faqs: import('./catalog-content.js').Faq[], sizeChartId: string | null, typeKey: string | null }} CategoryFields
 */

/** An id of another record, or null to clear it (the route checks it exists). @param {unknown} v */
const refOrNull = (v) => (v === null || v === '' ? NULL_REF : typeof v === 'string' && v.length <= 64 ? v : null);
/** The cleared reference (a reader's null means "invalid"). */
const NULL_REF = '';

/**
 * The content block and FAQs of a category, over the existing ones.
 * @param {Record<string, any>} body
 * @param {{ content?: import('./catalog-content.js').Content, faqs?: import('./catalog-content.js').Faq[] } | null} existing
 * @param {FieldError[]} errors
 */
const contentAndFaqs = (body, existing, errors) => {
	let content = existing?.content ?? { ...EMPTY_CONTENT };
	if (body.content !== undefined) content = checkContent(body.content, '/content', errors) ?? content;
	let faqs = existing?.faqs ?? [];
	if (body.faqs !== undefined) faqs = checkFaqs(body.faqs, MAX_FAQS, '/faqs', errors) ?? faqs;
	return { content, faqs };
};

/**
 * Check a new category or changes to one (the parent is checked by {@link placeCategory}).
 * @param {unknown} body
 * @param {CategoryRecord | null} existing
 * @returns {{ ok: true, value: CategoryFields } | { ok: false, errors: FieldError[] }}
 */
export const checkCategory = (body, existing) => {
	if (!isObject(body)) return { ok: false, errors: [{ path: '', message: 'Send the category as an object.' }] };
	/** @type {FieldError[]} */
	const errors = [];
	const read = reader(body, existing, errors);
	const name = read('name', nameOf, '', NAME_MESSAGE);
	if (!existing && body.name === undefined) errors.push({ path: '/name', message: 'Give the category a name.' });
	const slug = read('slug', slugOf, '', SLUG_MESSAGE);
	const description = read(
		'description',
		(v) => cleanText(v, TAXONOMY_LIMITS.description, { multiline: true }),
		'',
		`A description has at most ${TAXONOMY_LIMITS.description} characters.`,
	);
	let parentId = existing?.parentId ?? null;
	if (body.parentId !== undefined) {
		if (body.parentId === null || body.parentId === '') parentId = null;
		else if (typeof body.parentId === 'string') parentId = body.parentId;
		else errors.push({ path: '/parentId', message: 'Pick an existing parent category.' });
	}
	const sort = read('sort', sortOf, 0, SORT_MESSAGE);
	const seo = checkSeo(body.seo, existing?.seo, '/seo', errors);
	const status = read(
		'status',
		(v) => (CATEGORY_STATUSES.includes(/** @type {any} */ (v)) ? /** @type {CategoryStatus} */ (v) : null),
		/** @type {CategoryStatus} */ ('active'),
		'Status is active, coming_soon or hidden.',
	);
	const icon = read('icon', iconOf, '', 'An icon name has at most 40 characters.');
	const { content, faqs } = contentAndFaqs(body, existing, errors);
	const sizeChartId = read(
		'sizeChartId',
		refOrNull,
		/** @type {string | null} */ (null),
		'Pick an existing size chart, or null.',
	);
	// the item type its products have unless they name their own (the route checks it exists)
	const typeKey = read(
		'typeKey',
		refOrNull,
		/** @type {string | null} */ (null),
		'Pick an item type, or null for its parent’s.',
	);
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			name,
			slug,
			description,
			parentId,
			sort,
			seo,
			status,
			icon,
			content,
			faqs,
			sizeChartId: sizeChartId || null,
			typeKey: typeKey || null,
		},
	};
};

/**
 * Where a category goes: its `path` under the parent, or why it cannot go there (unknown parent, itself or one of its
 * own descendants, too deep).
 * @param {string | null} id the category (null for a new one)
 * @param {string | null} parentId
 * @param {ReadonlyMap<string, Pick<CategoryRecord, 'id' | 'path'>>} byId every category of the website
 * @returns {{ ok: true, path: string[] } | { ok: false, message: string }}
 */
export const placeCategory = (id, parentId, byId) => {
	if (parentId === null) return { ok: true, path: [] };
	const parent = byId.get(parentId);
	if (!parent) return { ok: false, message: 'Pick an existing parent category.' };
	if (id !== null && (parent.id === id || parent.path.includes(id)))
		return { ok: false, message: 'A category cannot be placed inside itself.' };
	const path = [...parent.path, parent.id];
	if (path.length >= TAXONOMY_LIMITS.depth)
		return { ok: false, message: `Categories go at most ${TAXONOMY_LIMITS.depth} levels deep.` };
	return { ok: true, path };
};

/**
 * The new paths of a moved category's descendants.
 * @param {string} id the moved category
 * @param {string[]} path its new path
 * @param {ReadonlyArray<Pick<CategoryRecord, 'id' | 'path'>>} categories every category of the website
 * @returns {Array<{ id: string, path: string[] }>}
 */
export const movedPaths = (id, path, categories) =>
	categories
		.filter((category) => category.path.includes(id))
		.map((category) => ({ id: category.id, path: [...path, id, ...category.path.slice(category.path.indexOf(id) + 1)] }));

/**
 * A category and every category below it.
 * @param {string} id
 * @param {ReadonlyArray<Pick<CategoryRecord, 'id' | 'path'>>} categories
 */
export const withDescendants = (id, categories) => [id, ...categories.filter((c) => c.path.includes(id)).map((c) => c.id)];

/**
 * Categories with those above them, nearest first, for the definitions of attributes and grades (E45: a category's
 * definition applies to the categories below it too, the nearest one up the tree winning): each category in its order,
 * then its parent, its parent's parent … up to the top, each once. A product's first category and those above it come
 * before its second category.
 * @param {ReadonlyArray<string | null | undefined>} categoryIds a product's categories in their order, or a page's one
 * @param {ReadonlyMap<string, Pick<CategoryRecord, 'path'>>} categories every category by id (an unknown one has no parents)
 * @returns {string[]}
 */
export const lineageOf = (categoryIds, categories) => [
	...new Set(
		categoryIds
			.filter((id) => typeof id === 'string' && id !== '')
			.flatMap((id) => [
				/** @type {string} */ (id),
				...[...(categories.get(/** @type {string} */ (id))?.path ?? [])].reverse(),
			]),
	),
];

/**
 * @template {{ sort: number, name: string }} T
 * @param {T} a @param {T} b
 */
const bySortThenName = (a, b) => a.sort - b.sort || a.name.localeCompare(b.name);

/**
 * @typedef {{ id: string, slug: string, name: string, count: number, children: CategoryNode[] }} CategoryNode
 */

/**
 * The category tree with how many products each holds, itself or below (a product in several categories of one branch
 * counts once).
 * @param {ReadonlyArray<CategoryRecord>} categories
 * @param {ReadonlyArray<{ categoryIds: string[], count: number }>} groups products grouped by their category lists
 * @param {(category: CategoryRecord) => Record<string, unknown>} [extra] more fields of each node
 * @returns {CategoryNode[]}
 */
export const categoryTree = (categories, groups, extra = () => ({})) => {
	const byId = new Map(categories.map((category) => [category.id, category]));
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const group of groups) {
		const reached = new Set();
		for (const id of group.categoryIds) {
			const category = byId.get(id);
			if (!category) continue;
			reached.add(id);
			for (const ancestor of category.path) reached.add(ancestor);
		}
		for (const id of reached) counts.set(id, (counts.get(id) ?? 0) + group.count);
	}
	/** @param {string | null} parentId @returns {CategoryNode[]} */
	const childrenOf = (parentId) =>
		categories
			.filter((category) => category.parentId === parentId)
			.sort(bySortThenName)
			.map((category) => ({
				id: category.id,
				slug: category.slug,
				name: category.name,
				...extra(category),
				count: counts.get(category.id) ?? 0,
				children: childrenOf(category.id),
			}));
	return childrenOf(null);
};

/**
 * A list of record ids (the route checks they exist), or null when invalid.
 * @param {unknown} v
 */
const idsOf = (v) =>
	Array.isArray(v) && v.length <= MAX_SCOPE && v.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)
		? [...new Set(/** @type {string[]} */ (v))]
		: null;

/**
 * The editable fields of a brand.
 * @typedef {Pick<BrandRecord, 'name' | 'slug' | 'description'> & { status: 'active' | 'hidden', categoryIds: string[],
 *   seo: import('./catalog-content.js').SeoFields, sizeChartId: string | null }} BrandFields
 */

/**
 * Check a new brand or changes to one (its categories and size chart are checked by the route).
 * @param {unknown} body
 * @param {BrandRecord | null} existing
 * @returns {{ ok: true, value: BrandFields } | { ok: false, errors: FieldError[] }}
 */
export const checkBrand = (body, existing) => {
	if (!isObject(body)) return { ok: false, errors: [{ path: '', message: 'Send the brand as an object.' }] };
	/** @type {FieldError[]} */
	const errors = [];
	const read = reader(body, existing, errors);
	const name = read('name', nameOf, '', NAME_MESSAGE);
	if (!existing && body.name === undefined) errors.push({ path: '/name', message: 'Give the brand a name.' });
	const slug = read('slug', slugOf, '', SLUG_MESSAGE);
	const description = read(
		'description',
		(v) => cleanText(v, TAXONOMY_LIMITS.description, { multiline: true }),
		'',
		`A description has at most ${TAXONOMY_LIMITS.description} characters.`,
	);
	const status = read(
		'status',
		(v) => (BRAND_STATUSES.includes(/** @type {any} */ (v)) ? /** @type {'active' | 'hidden'} */ (v) : null),
		/** @type {'active' | 'hidden'} */ ('active'),
		'Status is active or hidden.',
	);
	const categoryIds = read('categoryIds', idsOf, /** @type {string[]} */ ([]), 'Pick existing categories ([] = all).');
	const seo = checkSeo(body.seo, existing?.seo, '/seo', errors);
	const sizeChartId = read(
		'sizeChartId',
		refOrNull,
		/** @type {string | null} */ (null),
		'Pick an existing size chart, or null.',
	);
	return errors.length > 0
		? { ok: false, errors }
		: { ok: true, value: { name, slug, description, status, categoryIds, seo, sizeChartId: sizeChartId || null } };
};

/** @param {unknown} v @returns {AttributeChoice[] | null} */
const checkChoices = (v) => {
	if (!Array.isArray(v) || v.length > TAXONOMY_LIMITS.choices) return null;
	/** @type {AttributeChoice[]} */
	const out = [];
	for (const entry of v) {
		const value = cleanText(isObject(entry) ? entry.value : entry, TAXONOMY_LIMITS.choice);
		const label = isObject(entry) && entry.label !== undefined ? cleanText(entry.label, TAXONOMY_LIMITS.choice) : value;
		if (!value || !label || out.some((choice) => choice.value === value)) return null;
		out.push({ value, label });
	}
	return out;
};

/** @type {Readonly<AttributeVisibility>} */
const ALWAYS = Object.freeze({ when: 'always', ids: [], attributeId: null, value: null });

/** @param {unknown} v @returns {AttributeVisibility | null} */
const checkVisibility = (v) => {
	if (v === 'always' || v === null) return { ...ALWAYS };
	if (!isObject(v) || !VISIBILITY.includes(v.when)) return null;
	if (v.when === 'always') return { ...ALWAYS };
	if (v.when === 'attribute') {
		const value = cleanText(v.value, TAXONOMY_LIMITS.choice);
		return typeof v.attributeId === 'string' && v.attributeId && value
			? { when: 'attribute', ids: [], attributeId: v.attributeId, value }
			: null;
	}
	const ids = Array.isArray(v.ids) && v.ids.length > 0 && v.ids.length <= MAX_SCOPE ? idsOf(v.ids) : null;
	return ids ? { when: v.when, ids, attributeId: null, value: null } : null;
};

/** @param {unknown} v */
const glossaryOf = (v) => {
	if (!isObject(v)) return null;
	/** @type {FieldError[]} */
	const errors = [];
	const title = v.title === undefined ? '' : cleanText(v.title, LIMITS.seoTitle);
	const description = v.description === undefined ? '' : cleanText(v.description, LIMITS.seoDescription);
	const body = v.body === undefined ? '' : cleanText(v.body, GLOSSARY_BODY, { multiline: true });
	const faqs = v.faqs === undefined ? [] : checkFaqs(v.faqs, MAX_FAQS, '/seo/faqs', errors);
	return title === null || description === null || body === null || faqs === null ? null : { title, description, body, faqs };
};

/**
 * The editable fields of an attribute (a merchant field, PLAN 0.8.10 dynamic model §2).
 * @typedef {Omit<AttributeRecord, 'id'>} AttributeFields
 */

/** @param {unknown} v */
const numberOrNull = (v) =>
	v === null ? NULL_NUMBER : typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= FIELD_LIMITS.number ? v : null;
/** Stands for an explicit null among numbers a reader may answer (its null means "invalid"). */
const NULL_NUMBER = Symbol('no number');

/**
 * Check a new attribute or changes to one (E7; its slug, categories and visibility ids are checked by the route): a
 * merchant field (PLAN 0.8.10 dynamic model §2) whose values live on products, variants, units, orders or customers; its
 * type (text, number, choice, yes/no or date) with what the type takes (choices, a unit, a range and decimals, which
 * dates, a format), whether it takes several values (up to `maxValues`), whether it is required (order fields: at
 * checkout or before a stage), where its values show, its category scope (product and variant fields; unit fields
 * apply through the item types that name them), visibility and glossary (product and variant fields). An attribute may be the definition for one category (`categoryId`, E45: the same slug once per
 * category, with its own name, choices, unit, glossary and SEO); null is for every category.
 * @param {unknown} body
 * @param {AttributeRecord | null} existing
 * @returns {{ ok: true, value: AttributeFields } | { ok: false, errors: FieldError[] }}
 */
export const checkAttribute = (body, existing) => {
	if (!isObject(body)) return { ok: false, errors: [{ path: '', message: 'Send the field as an object.' }] };
	/** @type {FieldError[]} */
	const errors = [];
	const read = reader(body, existing, errors);
	const name = read('name', nameOf, '', NAME_MESSAGE);
	if (!existing && body.name === undefined) errors.push({ path: '/name', message: 'Give the field a name.' });
	const slug = read('slug', slugOf, '', SLUG_MESSAGE);
	const on = read(
		'on',
		(v) => (FIELD_ON.includes(/** @type {any} */ (v)) ? /** @type {FieldOn} */ (v) : null),
		/** @type {FieldOn} */ ('product'),
		`On is one of ${FIELD_ON.join(', ')}.`,
	);
	const catalog = on === 'product' || on === 'variant';
	const type = read(
		'type',
		(v) => (FIELD_TYPES.includes(/** @type {any} */ (v)) ? /** @type {FieldType} */ (v) : null),
		/** @type {FieldType} */ ('text'),
		`Type is one of ${FIELD_TYPES.join(', ')}.`,
	);
	if (on === 'variant' && type === 'yes_no')
		errors.push({ path: '/type', message: 'Variant fields are text, number, choice or date fields.' });
	if (on === 'unit' && type !== 'text')
		errors.push({ path: '/type', message: 'Unit fields are text: each value names one unit.' });
	const choices = read(
		'choices',
		checkChoices,
		/** @type {AttributeChoice[]} */ ([]),
		`Give up to ${TAXONOMY_LIMITS.choices} different choices (a value and a label each).`,
	);
	if (type === 'choice' && choices.length === 0) errors.push({ path: '/choices', message: 'A choice field needs choices.' });
	const unit = read(
		'unit',
		(v) => cleanText(v, TAXONOMY_LIMITS.unit),
		'',
		`A unit has at most ${TAXONOMY_LIMITS.unit} characters.`,
	);
	if (unit && (type === 'yes_no' || type === 'date'))
		errors.push({ path: '/unit', message: 'Yes/no and date fields have no unit.' });
	const min = read(
		'min',
		numberOrNull,
		/** @type {number | null | typeof NULL_NUMBER} */ (null),
		'The least is a number, or null.',
	);
	const max = read(
		'max',
		numberOrNull,
		/** @type {number | null | typeof NULL_NUMBER} */ (null),
		'The most is a number, or null.',
	);
	const least = min === NULL_NUMBER ? null : min;
	const most = max === NULL_NUMBER ? null : max;
	const decimals = read(
		'decimals',
		(v) => (Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 3 ? Number(v) : null),
		2,
		'Decimals are 0 to 3.',
	);
	if (type !== 'number' && (least !== null || most !== null))
		errors.push({ path: '/min', message: 'Only number fields have a range.' });
	if (least !== null && most !== null && least > most)
		errors.push({ path: '/min', message: 'The least is no more than the most.' });
	const dates = read(
		'dates',
		(v) => (FIELD_DATES.includes(/** @type {any} */ (v)) ? /** @type {typeof FIELD_DATES[number]} */ (v) : null),
		/** @type {typeof FIELD_DATES[number]} */ ('any'),
		`Dates are one of ${FIELD_DATES.join(', ')}.`,
	);
	if (type !== 'date' && dates !== 'any') errors.push({ path: '/dates', message: 'Only date fields limit their dates.' });
	const multiple = read('multiple', boolOf, false, 'Multiple is true or false.');
	if (multiple && type !== 'choice' && type !== 'text')
		errors.push({ path: '/multiple', message: 'Only text and choice fields take several values.' });
	const valuesCap = on === 'unit' ? FIELD_LIMITS.unitValues : FIELD_LIMITS.values;
	const maxValues = read(
		'maxValues',
		(v) => (Number.isSafeInteger(v) && Number(v) >= 1 && Number(v) <= FIELD_LIMITS.values ? Number(v) : null),
		multiple ? valuesCap : 1,
		`A field takes 1 to ${FIELD_LIMITS.values} values.`,
	);
	const values = multiple ? (body.maxValues === undefined && !existing?.multiple ? valuesCap : maxValues) : 1;
	if (multiple && (values < 2 || values > valuesCap))
		errors.push({
			path: '/maxValues',
			message:
				on === 'unit'
					? 'A unit field takes up to 2 values (two numbers of one unit).'
					: `Several values are 2 to ${valuesCap}.`,
		});
	const format = (() => {
		if (body.format === undefined) return existing?.format ?? null;
		const checked = checkFormatRule(body.format);
		if (!checked.ok) {
			errors.push(...checked.errors);
			return null;
		}
		return checked.value;
	})();
	if (format && type !== 'text') errors.push({ path: '/format', message: 'Only text fields have a format.' });
	const required = read('required', boolOf, false, 'Required is true or false.');
	if (required && on === 'customer')
		errors.push({ path: '/required', message: 'Customer fields are filled by staff when they have the value.' });
	const requiredAt = read(
		'requiredAt',
		(v) => (v === null ? NULL_REF : REQUIRED_AT.includes(/** @type {any} */ (v)) ? /** @type {string} */ (v) : null),
		/** @type {string | null} */ (null),
		`Required at is one of ${REQUIRED_AT.join(', ')}, or null.`,
	);
	const show = (() => {
		const checked = checkShow(body.show, on, existing && existing.on === on ? existing.show : null);
		if (!checked.ok) {
			errors.push(...checked.errors);
			return showDefaults(on);
		}
		return checked.value;
	})();
	const stage = on === 'order' && required ? requiredAt || null : null;
	if (on === 'order' && required && !stage)
		errors.push({
			path: '/requiredAt',
			message: 'Say when a required order field is needed: checkout, packed, shipped or delivered.',
		});
	if (stage === 'checkout' && !show.shopper)
		errors.push({ path: '/requiredAt', message: 'Only fields shoppers see are asked at checkout.' });
	if (on !== 'order' && requiredAt) errors.push({ path: '/requiredAt', message: 'Only order fields are required at a stage.' });
	const sort = read('sort', sortOf, 0, SORT_MESSAGE);
	const categoryIds = read('categoryIds', idsOf, /** @type {string[]} */ ([]), 'Pick existing categories ([] = all).');
	const categoryId = read(
		'categoryId',
		refOrNull,
		/** @type {string | null} */ (null),
		'Pick the category this field is for, or null for every category.',
	);
	if ((on === 'order' || on === 'customer') && (categoryId || categoryIds.length > 0))
		errors.push({ path: '/categoryIds', message: 'Order and customer fields are for every order and customer.' });
	if (on === 'unit' && (categoryId || categoryIds.length > 0))
		errors.push({ path: '/categoryIds', message: 'Unit fields apply to the units of the item types that name them.' });
	const visibility = read(
		'visibility',
		checkVisibility,
		/** @type {AttributeVisibility} */ ({ ...ALWAYS }),
		'Visibility is always, or brands or grades with their ids, or attribute with an attributeId and a value.',
	);
	if (!catalog && visibility.when !== 'always')
		errors.push({ path: '/visibility', message: 'Only product and variant fields depend on brands, grades or fields.' });
	const active = read('active', boolOf, true, 'Active is true or false.');
	const seo = read(
		'seo',
		glossaryOf,
		{ title: '', description: '', body: '', faqs: /** @type {import('./catalog-content.js').Faq[]} */ ([]) },
		`The glossary has a title, a description, a text of at most ${GLOSSARY_BODY} characters and at most ${MAX_FAQS} questions.`,
	);
	if (!catalog && (seo.title || seo.description || seo.body || seo.faqs.length > 0))
		errors.push({ path: '/seo', message: 'Only product and variant fields have a glossary page.' });
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			name,
			slug,
			on,
			type,
			choices: type === 'choice' ? choices : [],
			unit,
			min: type === 'number' ? least : null,
			max: type === 'number' ? most : null,
			decimals: type === 'number' ? decimals : 0,
			dates: type === 'date' ? dates : 'any',
			multiple,
			maxValues: values,
			format: type === 'text' ? format : null,
			required,
			requiredAt: /** @type {AttributeRecord['requiredAt']} */ (stage),
			show,
			sort,
			categoryId: categoryId || null,
			categoryIds,
			visibility,
			active,
			seo,
		},
	};
};

/**
 * A stored record as the API answers it: without the times the data layer stamps on every write (`createdAt`,
 * `updatedAt`), so a record answers the same members whether it was just written or read back.
 * @template {Record<string, any>} T
 * @param {T} record
 * @returns {Omit<T, 'createdAt' | 'updatedAt'>}
 */
export const withoutStamps = (record) =>
	/** @type {Omit<T, 'createdAt' | 'updatedAt'>} */ (
		Object.fromEntries(Object.entries(record).filter(([name]) => name !== 'createdAt' && name !== 'updatedAt'))
	);

/**
 * Check a new location or changes to one.
 * @param {unknown} body
 * @param {LocationRecord | null} existing
 * @returns {{ ok: true, value: Omit<LocationRecord, 'id'> } | { ok: false, errors: FieldError[] }}
 */
export const checkLocation = (body, existing) => {
	if (!isObject(body)) return { ok: false, errors: [{ path: '', message: 'Send the location as an object.' }] };
	/** @type {FieldError[]} */
	const errors = [];
	const read = reader(body, existing, errors);
	const name = read('name', nameOf, '', NAME_MESSAGE);
	if (!existing && body.name === undefined) errors.push({ path: '/name', message: 'Give the location a name.' });
	const pickup = read('pickup', boolOf, false, 'Pickup is true or false.');
	const sort = read('sort', sortOf, 0, SORT_MESSAGE);
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { name, pickup, sort } };
};
