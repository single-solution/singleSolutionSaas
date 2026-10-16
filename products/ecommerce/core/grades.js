/**
 * Condition grades (PLAN 0.8.8 Items: used or refurbished items carry a condition grade; PLAN 0.8.10 E10): the
 * `grades` list the merchant keeps in the dashboard — a stable key (letters, digits, `_` and `-`), a label shown to
 * shoppers, a description, the item's return and warranty times for that grade (a number and its unit, E14; null = the
 * `returns` setting), and per
 * grade the categories and the item types it is for ([] = all: a grade set per item type, owner 2026-10-14 Q4), a color,
 * a condition video, content, whether it is offered, the standard condition structured data and feeds use, and its
 * glossary SEO. A grade entry may be the definition for one category
 * (`categoryId`, E45): the same key then exists once per category with its own label, texts, days and SEO, and once
 * without a category for every other one. Variants name a grade by its key; a product's grade is the entry of its
 * category or the nearest one above it, then the one without a category ({@link gradesFor}). No I/O.
 * @module
 */
import { EMPTY_CONTENT, checkContent, checkFaqs } from './catalog-content.js';
import { DURATION_RULE, durationOf } from './durations.js';

/** What a grade may hold (the dashboard's editor counts with the same). */
export const GRADE_LIMITS = Object.freeze({
	grades: 100,
	label: 60,
	key: 40,
	description: 1200,
	color: 40,
	categories: 200,
	types: 50,
});

/** Grade and item type keys. */
export const KEY = new RegExp(`^[a-z][a-z0-9_-]{0,${GRADE_LIMITS.key - 1}}$`);
/** A CSS color as the website writes it (a name, `#rgb`, `#rrggbb`, `rgb(…)` …). */
const COLOUR = new RegExp(`^[#A-Za-z0-9(),.%\\s-]{0,${GRADE_LIMITS.color}}$`);
/** Grade conditions (schema.org item conditions), the standard condition every grade maps to (owner, 2026-10-14). */
export const CONDITIONS = Object.freeze(/** @type {const} */ (['new', 'refurbished', 'used']));

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;

/** @typedef {'new' | 'refurbished' | 'used'} Condition */

/**
 * @typedef {object} Grade
 * @property {string} key
 * @property {string} label
 * @property {string} description
 * @property {import('./durations.js').Duration | null} returnTime its return time, a number and its unit (E14; null = the
 *   `returns` setting)
 * @property {import('./durations.js').Duration | null} warrantyTime
 * @property {string | null} categoryId the category this entry is the definition for (E45); null = every category
 * @property {string[]} categoryIds [] = every category
 * @property {string[]} typeKeys the item types whose items take it (`core/item-types.js` keys, built-in ones too); [] =
 *   every type that has grades
 * @property {string} color a CSS color ('' = none)
 * @property {string} video a storage key or a YouTube id ('' = none)
 * @property {import('./catalog-content.js').Content} content
 * @property {boolean} active false: not offered for new variants, kept on old ones
 * @property {Condition} condition the standard condition structured data and feeds give its items (`used` when not
 *   given)
 * @property {{ title: string, description: string, body: string, faqs: import('./catalog-content.js').Faq[] }} seo
 *   the glossary page (E15)
 * @property {string | null} [videoUrl] the condition video's address, filled in for shoppers (not stored)
 */

/** @param {unknown} value */

/** @param {unknown} value @param {number} max */
const shortText = (value, max) =>
	typeof value === 'string' && value.length <= max && !CONTROL.test(value) ? value.trim() : null;

/**
 * Check the list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: Grade[] } | { ok: false, errors: string[] }}
 */
export const checkGrades = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: ['A list is expected.'] };
	if (value.length > GRADE_LIMITS.grades) return { ok: false, errors: [`At most ${GRADE_LIMITS.grades} grades.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {Grade[]} */
	const out = [];
	value.forEach((entry, index) => {
		const n = index + 1;
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
			return void errors.push(`Grade ${n}: an object is expected.`);
		const key = typeof entry.key === 'string' ? entry.key.trim() : '';
		const categoryId = entry.categoryId === undefined || entry.categoryId === '' ? null : entry.categoryId;
		if (categoryId !== null && (typeof categoryId !== 'string' || categoryId.length > 64))
			errors.push(`Grade ${n}: the category is a category id, or null for every category.`);
		if (!KEY.test(key)) errors.push(`Grade ${n}: the key is lowercase letters, digits, _ and - (starting with a letter).`);
		else if (out.some((grade) => grade.key === key && grade.categoryId === categoryId))
			errors.push(
				categoryId === null
					? `Grade ${n}: the key ${key} is used twice.`
					: `Grade ${n}: the key ${key} is used twice for the same category.`,
			);
		const label = typeof entry.label === 'string' ? entry.label.trim() : '';
		if (!label || label.length > GRADE_LIMITS.label || CONTROL.test(label))
			errors.push(`Grade ${n}: give a label of 1 to ${GRADE_LIMITS.label} characters.`);
		const description = entry.description === undefined ? '' : entry.description;
		if (typeof description !== 'string' || description.length > GRADE_LIMITS.description)
			errors.push(`Grade ${n}: the description has at most ${GRADE_LIMITS.description} characters.`);
		const returnTime = durationOf(entry.returnTime ?? null);
		const warrantyTime = durationOf(entry.warrantyTime ?? null);
		if (returnTime === undefined) errors.push(`Grade ${n}: the return time: ${DURATION_RULE}`);
		if (warrantyTime === undefined) errors.push(`Grade ${n}: the warranty time: ${DURATION_RULE}`);
		const categoryIds = entry.categoryIds ?? [];
		if (
			!Array.isArray(categoryIds) ||
			categoryIds.length > GRADE_LIMITS.categories ||
			!categoryIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)
		)
			errors.push(`Grade ${n}: categories are a list of category ids.`);
		const typeKeys = entry.typeKeys ?? [];
		if (
			!Array.isArray(typeKeys) ||
			typeKeys.length > GRADE_LIMITS.types ||
			!typeKeys.every((key) => typeof key === 'string' && KEY.test(key))
		)
			errors.push(`Grade ${n}: item types are a list of at most ${GRADE_LIMITS.types} item type keys.`);
		const color = entry.color === undefined ? '' : entry.color;
		if (typeof color !== 'string' || !COLOUR.test(color))
			errors.push(`Grade ${n}: the color is a CSS color of up to 40 characters.`);
		const video = entry.video === undefined ? '' : shortText(entry.video, 500);
		if (video === null) errors.push(`Grade ${n}: the video is a file key or a YouTube id.`);
		/** @type {Array<{ path: string, message: string }>} */
		const found = [];
		const content = entry.content === undefined ? { ...EMPTY_CONTENT } : checkContent(entry.content, 'content', found);
		const active = entry.active === undefined ? true : entry.active;
		if (typeof active !== 'boolean') errors.push(`Grade ${n}: active is true or false.`);
		const condition = entry.condition === undefined ? 'used' : entry.condition;
		if (!CONDITIONS.includes(condition)) errors.push(`Grade ${n}: the condition is new, refurbished or used.`);
		const rawSeo = entry.seo ?? {};
		const seo = {
			title: rawSeo.title === undefined ? '' : shortText(rawSeo.title, 200),
			description: rawSeo.description === undefined ? '' : shortText(rawSeo.description, 500),
			body:
				rawSeo.body === undefined
					? ''
					: typeof rawSeo.body === 'string' && rawSeo.body.length <= 20_000
						? rawSeo.body.trim()
						: null,
			faqs: rawSeo.faqs === undefined ? [] : checkFaqs(rawSeo.faqs, 20, 'seo/faqs', found),
		};
		if (Object.values(seo).some((part) => part === null) || typeof rawSeo !== 'object')
			errors.push(`Grade ${n}: the SEO has a title, a description, a text and at most 20 questions.`);
		for (const problem of found) errors.push(`Grade ${n}: ${problem.message}`);
		out.push({
			key,
			categoryId: typeof categoryId === 'string' ? categoryId : null,
			label,
			description: typeof description === 'string' ? description.trim() : '',
			returnTime: returnTime ?? null,
			warrantyTime: warrantyTime ?? null,
			categoryIds: Array.isArray(categoryIds) ? [...new Set(/** @type {string[]} */ (categoryIds))] : [],
			typeKeys: Array.isArray(typeKeys) ? [...new Set(/** @type {string[]} */ (typeKeys))] : [],
			color: typeof color === 'string' ? color.trim() : '',
			video: video ?? '',
			content: content ?? { ...EMPTY_CONTENT },
			active: active !== false,
			condition: /** @type {Condition} */ (condition),
			seo: /** @type {NonNullable<Grade['seo']>} */ (seo),
		});
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
};

/**
 * The entries of a list that have a key (anything else is skipped).
 * @param {unknown} list
 * @returns {Grade[]}
 */
const entriesOf = (list) => (Array.isArray(list) ? list : []).filter((entry) => entry && typeof entry.key === 'string');

/**
 * The grades by key, where no category is known: each key's entry without a category, else its first entry for a
 * category (E45). In the order of the list; entries without a label are skipped.
 * @param {unknown} list
 * @returns {Map<string, Grade>}
 */
export const gradesByKey = (list) =>
	gradesFor(
		entriesOf(list).filter((entry) => typeof entry.label === 'string'),
		[],
	);

/**
 * The grades by key for a product or a page of these categories (E45): each key's entry for the first of the categories
 * that has one, else its entry without a category, else (no category given) its first entry. In the order of the list.
 * Give the categories with those above them, nearest first (`core/catalog-taxonomy.js` `lineageOf`), so a category's
 * entry also applies to the categories below it.
 * @param {unknown} list
 * @param {ReadonlyArray<string | null | undefined>} categoryIds the categories, nearest first
 * @returns {Map<string, Grade>}
 */
export const gradesFor = (list, categoryIds) => {
	const entries = entriesOf(list);
	const wanted = categoryIds.filter((id) => typeof id === 'string' && id !== '');
	/** @param {Grade} entry */
	const rank = (entry) => {
		const own = entry.categoryId;
		if (own === null) return wanted.length;
		const at = wanted.indexOf(own);
		return at !== -1 ? at : wanted.length === 0 ? wanted.length + 1 : -1;
	};
	/** @type {Map<string, Grade>} */
	const best = new Map();
	for (const entry of entries) {
		const at = rank(entry);
		if (at === -1) continue;
		const held = best.get(entry.key);
		if (!held || at < rank(held)) best.set(entry.key, entry);
	}
	/** @type {Map<string, Grade>} */
	const out = new Map();
	for (const entry of entries) if (best.get(entry.key) === entry) out.set(entry.key, entry);
	return out;
};

/**
 * The item types each grade key is for: a key's entries together (E45), [] when one of them is for every type.
 * @param {unknown} list
 * @returns {Map<string, string[]>}
 */
export const gradeTypes = (list) => {
	/** @type {Map<string, string[]>} */
	const out = new Map();
	for (const entry of entriesOf(list)) {
		const own = Array.isArray(entry.typeKeys) ? entry.typeKeys : [];
		const held = out.get(entry.key);
		out.set(entry.key, held?.length === 0 || own.length === 0 ? [] : [...new Set([...(held ?? []), ...own])]);
	}
	return out;
};

/**
 * Whether a grade is for an item type (its types, [] = every type).
 * @param {ReadonlyArray<string>} typeKeys @param {string} typeKey
 */
export const gradeForType = (typeKeys, typeKey) => typeKeys.length === 0 || typeKeys.includes(typeKey);

/**
 * The condition of a variant for structured data and feeds (E10): its grade's standard condition (a grade no longer
 * in the list counts as used); physical goods without a grade are new; digital goods and bookings have none ('').
 * @param {{ kind: string }} product
 * @param {{ grade: string | null }} variant
 * @param {ReadonlyMap<string, Grade>} grades
 * @returns {Condition | ''}
 */
export const gradeCondition = (product, variant, grades) => {
	if (product.kind !== 'physical') return '';
	if (!variant.grade) return 'new';
	return grades.get(variant.grade)?.condition ?? 'used';
};

/**
 * What shoppers see of a grade (E10).
 * @param {Grade} grade
 */
export const gradeView = (grade) => ({
	key: grade.key,
	label: grade.label,
	description: grade.description,
	color: grade.color,
	video: grade.video,
	videoUrl: grade.videoUrl ?? null,
	content: grade.content,
	condition: grade.condition,
	warrantyTime: grade.warrantyTime,
	returnTime: grade.returnTime,
});
