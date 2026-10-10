/**
 * Condition grades (PLAN 0.8.8 Items: used or refurbished items carry a condition grade; PLAN 0.8.10 E10): the
 * `grades` list the merchant keeps in the dashboard — a stable key (letters, digits, `_` and `-`), a label shown to
 * shoppers, a description, the item's return and warranty days for that grade (null = the `returns` setting), and per
 * grade the categories it is for ([] = all), a colour, an inspection video, content, whether it is offered, the item
 * condition structured data and feeds use, and its glossary SEO. Variants name a grade by its key. No I/O.
 * @module
 */
import { EMPTY_CONTENT, checkContent, checkFaqs } from './catalog-content.js';

/** At most this many grades. */
export const MAX_GRADES = 100;
/** Longest grade description. */
const MAX_DESCRIPTION = 1200;

/** Grade keys. */
const KEY = /^[a-z][a-z0-9_-]{0,39}$/;
/** A CSS colour as the website writes it (a name, `#rgb`, `#rrggbb`, `rgb(…)` …). */
const COLOUR = /^[#A-Za-z0-9(),.%\s-]{0,40}$/;
/** Grade conditions (schema.org item conditions). */
const CONDITIONS = Object.freeze(/** @type {const} */ (['new', 'refurbished', 'used']));

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/;

/** @typedef {'new' | 'refurbished' | 'used'} Condition */

/**
 * @typedef {object} Grade
 * @property {string} key
 * @property {string} label
 * @property {string} description
 * @property {number | null} returnDays
 * @property {number | null} warrantyDays
 * @property {string[]} [categoryIds] [] = every category
 * @property {string} [color] a CSS colour ('' = none)
 * @property {string} [video] a storage key or a YouTube id ('' = none)
 * @property {import('./catalog-content.js').Content} [content]
 * @property {boolean} [active] false: not offered for new variants, kept on old ones
 * @property {Condition | null} [condition] null = the SEO and feeds setting for graded items
 * @property {{ title: string, description: string, body: string, faqs: import('./catalog-content.js').Faq[] }} [seo]
 *   the glossary page (E15)
 */

/** @param {unknown} value */
const isDays = (value) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 3650);

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
	if (value.length > MAX_GRADES) return { ok: false, errors: [`At most ${MAX_GRADES} grades.`] };
	/** @type {string[]} */
	const errors = [];
	/** @type {Grade[]} */
	const out = [];
	value.forEach((entry, index) => {
		const n = index + 1;
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
			return void errors.push(`Grade ${n}: an object is expected.`);
		const key = typeof entry.key === 'string' ? entry.key.trim() : '';
		if (!KEY.test(key)) errors.push(`Grade ${n}: the key is lowercase letters, digits, _ and - (starting with a letter).`);
		else if (out.some((grade) => grade.key === key)) errors.push(`Grade ${n}: the key ${key} is used twice.`);
		const label = typeof entry.label === 'string' ? entry.label.trim() : '';
		if (!label || label.length > 60 || CONTROL.test(label)) errors.push(`Grade ${n}: give a label of 1 to 60 characters.`);
		const description = entry.description === undefined ? '' : entry.description;
		if (typeof description !== 'string' || description.length > MAX_DESCRIPTION)
			errors.push(`Grade ${n}: the description has at most ${MAX_DESCRIPTION} characters.`);
		const returnDays = entry.returnDays ?? null;
		const warrantyDays = entry.warrantyDays ?? null;
		if (!isDays(returnDays)) errors.push(`Grade ${n}: return days are whole days from 0 to 3650, or empty.`);
		if (!isDays(warrantyDays)) errors.push(`Grade ${n}: warranty days are whole days from 0 to 3650, or empty.`);
		const categoryIds = entry.categoryIds ?? [];
		if (
			!Array.isArray(categoryIds) ||
			categoryIds.length > 200 ||
			!categoryIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)
		)
			errors.push(`Grade ${n}: categories are a list of category ids.`);
		const color = entry.color === undefined ? '' : entry.color;
		if (typeof color !== 'string' || !COLOUR.test(color))
			errors.push(`Grade ${n}: the colour is a CSS colour of up to 40 characters.`);
		const video = entry.video === undefined ? '' : shortText(entry.video, 500);
		if (video === null) errors.push(`Grade ${n}: the video is a file key or a YouTube id.`);
		/** @type {Array<{ path: string, message: string }>} */
		const found = [];
		const content = entry.content === undefined ? { ...EMPTY_CONTENT } : checkContent(entry.content, 'content', found);
		const active = entry.active === undefined ? true : entry.active;
		if (typeof active !== 'boolean') errors.push(`Grade ${n}: active is true or false.`);
		const condition = entry.condition ?? null;
		if (condition !== null && !CONDITIONS.includes(condition))
			errors.push(`Grade ${n}: the condition is new, refurbished or used.`);
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
			label,
			description: typeof description === 'string' ? description.trim() : '',
			returnDays: /** @type {number | null} */ (returnDays),
			warrantyDays: /** @type {number | null} */ (warrantyDays),
			categoryIds: Array.isArray(categoryIds) ? [...new Set(/** @type {string[]} */ (categoryIds))] : [],
			color: typeof color === 'string' ? color.trim() : '',
			video: video ?? '',
			content: content ?? { ...EMPTY_CONTENT },
			active: active !== false,
			condition: /** @type {Condition | null} */ (condition),
			seo: /** @type {NonNullable<Grade['seo']>} */ (seo),
		});
	});
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
};

/**
 * The grades by key (anything malformed in a saved list is skipped).
 * @param {unknown} list
 * @returns {Map<string, Grade>}
 */
export const gradesByKey = (list) => {
	/** @type {Map<string, Grade>} */
	const out = new Map();
	for (const entry of Array.isArray(list) ? list : [])
		if (entry && typeof entry.key === 'string' && typeof entry.label === 'string') out.set(entry.key, entry);
	return out;
};

/**
 * The condition of a variant for structured data and feeds (E10): its grade's condition, else the merchant's setting
 * for graded items; physical goods without a grade are new; digital goods and bookings have none ('').
 * @param {{ kind: string }} product
 * @param {{ grade: string | null }} variant
 * @param {ReadonlyMap<string, Grade>} grades
 * @param {Condition} graded the setting for graded items
 * @returns {Condition | ''}
 */
export const gradeCondition = (product, variant, grades, graded) => {
	if (product.kind !== 'physical') return '';
	if (!variant.grade) return 'new';
	return grades.get(variant.grade)?.condition ?? graded;
};

/**
 * What shoppers see of a grade (E10).
 * @param {Grade} grade
 */
export const gradeView = (grade) => ({
	key: grade.key,
	label: grade.label,
	description: grade.description,
	color: grade.color ?? '',
	video: grade.video ?? '',
	content: grade.content ?? { ...EMPTY_CONTENT },
	condition: grade.condition ?? null,
	warrantyDays: grade.warrantyDays,
	returnDays: grade.returnDays,
});
