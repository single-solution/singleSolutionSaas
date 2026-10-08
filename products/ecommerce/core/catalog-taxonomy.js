/**
 * Categories, brands, attributes and stock locations (PLAN 0.8.8 Catalog): their checks, the nested category tree
 * (each category keeps the ids of its ancestors in `path`; a move must not create a cycle and rewrites the paths of the
 * moved branch), and the tree with product counts shown to shoppers. No I/O.
 * @module
 */
import { LIMITS, cleanText, isObject, isSlug } from './catalog.js';

/** @typedef {import('./model.js').CategoryRecord} CategoryRecord */
/** @typedef {import('./model.js').BrandRecord} BrandRecord */
/** @typedef {import('./model.js').AttributeRecord} AttributeRecord */
/** @typedef {import('./model.js').LocationRecord} LocationRecord */
/** @typedef {import('./catalog.js').FieldError} FieldError */

/** Attribute types. */
export const ATTRIBUTE_TYPES = Object.freeze(/** @type {const} */ (['text', 'number', 'boolean', 'choice']));

/** Limits of the catalog's records. */
export const TAXONOMY_LIMITS = Object.freeze({
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

/**
 * Check a new category or changes to one (the parent is checked by {@link placeCategory}).
 * @param {unknown} body
 * @param {CategoryRecord | null} existing
 * @returns {{ ok: true, value: Pick<CategoryRecord, 'name' | 'slug' | 'description' | 'seo' | 'sort'> & { parentId: string | null } } | { ok: false, errors: FieldError[] }}
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
	let seo = existing?.seo ?? { title: '', description: '' };
	if (body.seo !== undefined) {
		const raw = isObject(body.seo) ? body.seo : {};
		const title = raw.title === undefined ? seo.title : cleanText(raw.title, LIMITS.seoTitle);
		const text = raw.description === undefined ? seo.description : cleanText(raw.description, LIMITS.seoDescription);
		if (!isObject(body.seo) || title === null || text === null)
			errors.push({
				path: '/seo',
				message: `An SEO title has at most ${LIMITS.seoTitle} characters and a description ${LIMITS.seoDescription}.`,
			});
		seo = { title: title ?? seo.title, description: text ?? seo.description };
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { name, slug, description, parentId, sort, seo } };
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
 * Check a new brand or changes to one.
 * @param {unknown} body
 * @param {BrandRecord | null} existing
 * @returns {{ ok: true, value: Pick<BrandRecord, 'name' | 'slug' | 'description'> } | { ok: false, errors: FieldError[] }}
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
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { name, slug, description } };
};

/**
 * Check a new attribute or changes to one.
 * @param {unknown} body
 * @param {AttributeRecord | null} existing
 * @returns {{ ok: true, value: Omit<AttributeRecord, 'id'> } | { ok: false, errors: FieldError[] }}
 */
export const checkAttribute = (body, existing) => {
	if (!isObject(body)) return { ok: false, errors: [{ path: '', message: 'Send the attribute as an object.' }] };
	/** @type {FieldError[]} */
	const errors = [];
	const read = reader(body, existing, errors);
	const name = read('name', nameOf, '', NAME_MESSAGE);
	if (!existing && body.name === undefined) errors.push({ path: '/name', message: 'Give the attribute a name.' });
	const type = read(
		'type',
		(v) => (ATTRIBUTE_TYPES.includes(/** @type {any} */ (v)) ? /** @type {AttributeRecord['type']} */ (v) : null),
		/** @type {AttributeRecord['type']} */ ('text'),
		'Type is text, number, boolean or choice.',
	);
	const choices = read(
		'choices',
		(v) => {
			if (!Array.isArray(v) || v.length > TAXONOMY_LIMITS.choices) return null;
			const out = v.map((choice) => cleanText(choice, TAXONOMY_LIMITS.choice));
			return out.every(Boolean) && new Set(out).size === out.length ? /** @type {string[]} */ (out) : null;
		},
		/** @type {string[]} */ ([]),
		`Give up to ${TAXONOMY_LIMITS.choices} different choices.`,
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
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { name, type, choices: type === 'choice' ? choices : [], unit, filterable, comparable, sort } };
};

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
