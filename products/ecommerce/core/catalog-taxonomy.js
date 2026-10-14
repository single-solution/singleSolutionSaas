/**
 * Categories, brands, attributes and stock locations (PLAN 0.8.8 Catalog): their checks, the nested category tree
 * (each category keeps the ids of its ancestors in `path`; a move must not create a cycle and rewrites the paths of the
 * moved branch), and the tree with product counts shown to shoppers. No I/O.
 * @module
 */
import { LIMITS, cleanText, isObject, isSlug } from './catalog.js';
import { EMPTY_CONTENT, checkContent, checkFaqs, checkSeo, iconOf } from './catalog-content.js';

/** @typedef {import('./model.js').CategoryRecord} CategoryRecord */
/** @typedef {import('./model.js').BrandRecord} BrandRecord */
/** @typedef {import('./model.js').AttributeRecord} AttributeRecord */
/** @typedef {import('./model.js').LocationRecord} LocationRecord */
/** @typedef {import('./model.js').AttributeChoice} AttributeChoice */
/** @typedef {import('./model.js').AttributeVisibility} AttributeVisibility */
/** @typedef {import('./catalog.js').FieldError} FieldError */

/** Category statuses (E1): coming soon is listed with its products hidden; hidden is neither. */
export const CATEGORY_STATUSES = Object.freeze(/** @type {const} */ (['active', 'coming_soon', 'hidden']));
/** Brand statuses (E1). */
export const BRAND_STATUSES = Object.freeze(/** @type {const} */ (['active', 'hidden']));
/** Where an attribute's values live (E7). */
const ATTRIBUTE_ON = Object.freeze(/** @type {const} */ (['product', 'variant']));
/** When an attribute is shown (E7). */
const VISIBILITY = Object.freeze(/** @type {const} */ (['always', 'brands', 'grades', 'attribute']));
/** How product cards show an attribute (E7). */
const CARD_MODES = Object.freeze(/** @type {const} */ (['none', 'image', 'chips']));
/** At most this many FAQs on a category, a brand, a product, a glossary page or a landing page. */
export const MAX_FAQS = 20;
/** Most categories a brand or an attribute is limited to. */
const MAX_SCOPE = 200;
/** Longest glossary text. */
const GLOSSARY_BODY = 20_000;

/** Attribute types. */
const ATTRIBUTE_TYPES = Object.freeze(/** @type {const} */ (['text', 'number', 'boolean', 'choice']));

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
 *   faqs: import('./catalog-content.js').Faq[], sizeChartId: string | null, requiresSerial: boolean | null }} CategoryFields
 */

/** Stands for an explicit null among values a reader may answer (its null means "invalid"). */
const NULL_FLAG = Symbol('null');

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
	const requiresSerial = read(
		'requiresSerial',
		(v) => (v === null ? NULL_FLAG : typeof v === 'boolean' ? v : null),
		/** @type {boolean | null | typeof NULL_FLAG} */ (null),
		'Requires serial is true, false or null (as its parent).',
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
			requiresSerial: requiresSerial === NULL_FLAG ? null : requiresSerial,
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
 * The editable fields of an attribute.
 * @typedef {Omit<AttributeRecord, 'id'> & { slug: string, categoryId: string | null, categoryIds: string[], on: 'product' | 'variant',
 *   multiple: boolean, visibility: AttributeVisibility, card: 'none' | 'image' | 'chips', active: boolean,
 *   seo: { title: string, description: string, body: string, faqs: import('./catalog-content.js').Faq[] } }} AttributeFields
 */

/**
 * Check a new attribute or changes to one (E7; its slug, categories and visibility ids are checked by the route). An
 * attribute may be the definition for one category (`categoryId`, E45: the same slug once per category, with its own
 * name, choices, unit, glossary and SEO); null is for every category.
 * @param {unknown} body
 * @param {AttributeRecord | null} existing
 * @returns {{ ok: true, value: AttributeFields } | { ok: false, errors: FieldError[] }}
 */
export const checkAttribute = (body, existing) => {
	if (!isObject(body)) return { ok: false, errors: [{ path: '', message: 'Send the attribute as an object.' }] };
	/** @type {FieldError[]} */
	const errors = [];
	const read = reader(body, existing, errors);
	const name = read('name', nameOf, '', NAME_MESSAGE);
	if (!existing && body.name === undefined) errors.push({ path: '/name', message: 'Give the attribute a name.' });
	const slug = read('slug', slugOf, '', SLUG_MESSAGE);
	const type = read(
		'type',
		(v) => (ATTRIBUTE_TYPES.includes(/** @type {any} */ (v)) ? /** @type {AttributeRecord['type']} */ (v) : null),
		/** @type {AttributeRecord['type']} */ ('text'),
		'Type is text, number, boolean or choice.',
	);
	const choices = read(
		'choices',
		checkChoices,
		/** @type {AttributeChoice[]} */ ([]),
		`Give up to ${TAXONOMY_LIMITS.choices} different choices (a value and a label each).`,
	);
	if (type === 'choice' && choices.length === 0) errors.push({ path: '/choices', message: 'A choice attribute needs choices.' });
	const unit = read(
		'unit',
		(v) => cleanText(v, TAXONOMY_LIMITS.unit),
		'',
		`A unit has at most ${TAXONOMY_LIMITS.unit} characters.`,
	);
	const filterable = read('filterable', boolOf, false, 'Filterable is true or false.');
	const comparable = read('comparable', boolOf, false, 'Comparable is true or false.');
	const sort = read('sort', sortOf, 0, SORT_MESSAGE);
	const categoryIds = read('categoryIds', idsOf, /** @type {string[]} */ ([]), 'Pick existing categories ([] = all).');
	const categoryId = read(
		'categoryId',
		refOrNull,
		/** @type {string | null} */ (null),
		'Pick the category this attribute is for, or null for every category.',
	);
	const on = read(
		'on',
		(v) => (ATTRIBUTE_ON.includes(/** @type {any} */ (v)) ? /** @type {'product' | 'variant'} */ (v) : null),
		/** @type {'product' | 'variant'} */ ('product'),
		'On is product or variant.',
	);
	const multiple = read('multiple', boolOf, false, 'Multiple is true or false.');
	if (multiple && type !== 'choice' && type !== 'text')
		errors.push({ path: '/multiple', message: 'Only text and choice attributes take several values.' });
	if (on === 'variant' && type === 'boolean')
		errors.push({ path: '/on', message: 'Variants take text, number or choice attributes.' });
	const visibility = read(
		'visibility',
		checkVisibility,
		/** @type {AttributeVisibility} */ ({ ...ALWAYS }),
		'Visibility is always, or brands or grades with their ids, or attribute with an attributeId and a value.',
	);
	const card = read(
		'card',
		(v) => (CARD_MODES.includes(/** @type {any} */ (v)) ? /** @type {'none' | 'image' | 'chips'} */ (v) : null),
		/** @type {'none' | 'image' | 'chips'} */ ('none'),
		'Card is none, image or chips.',
	);
	const active = read('active', boolOf, true, 'Active is true or false.');
	const seo = read(
		'seo',
		glossaryOf,
		{ title: '', description: '', body: '', faqs: /** @type {import('./catalog-content.js').Faq[]} */ ([]) },
		`The glossary has a title, a description, a text of at most ${GLOSSARY_BODY} characters and at most ${MAX_FAQS} questions.`,
	);
	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			name,
			slug,
			type,
			choices: type === 'choice' ? choices : [],
			unit,
			filterable,
			comparable,
			sort,
			categoryId: categoryId || null,
			categoryIds,
			on,
			multiple,
			visibility,
			card,
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
