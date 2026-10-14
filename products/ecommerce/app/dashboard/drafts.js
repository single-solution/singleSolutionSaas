/**
 * Plain helpers of the dashboard's list editors (no React, so tests import them): keys made from names, lines and days
 * as saved, and a condition grade as edited (E10: every field of a `grades` item as text the editor shows) and as saved
 * (the shape `core/grades.js` `checkGrades` takes).
 * @module
 */
import { CONTENT_LIMITS } from '../../core/catalog-content.js';
import { CONDITIONS, MAX_GRADES } from '../../core/grades.js';

/** What a grade may hold, for the editor's counters and Add buttons. */
export const GRADE_LIMITS = Object.freeze({
	grades: MAX_GRADES,
	label: 60,
	key: 40,
	description: 1200,
	color: 40,
	video: 500,
	categories: 200,
	summary: CONTENT_LIMITS.summary,
	bullets: CONTENT_LIMITS.bullets,
	bullet: CONTENT_LIMITS.bullet,
	icon: CONTENT_LIMITS.icon,
	seoTitle: CONTENT_LIMITS.seoTitle,
	seoDescription: CONTENT_LIMITS.seoDescription,
	body: CONTENT_LIMITS.html,
	faqs: 20,
	question: CONTENT_LIMITS.question,
	answer: CONTENT_LIMITS.answer,
});

/** Grade keys as the server takes them. */
export const GRADE_KEY = /^[a-z][a-z0-9_-]{0,39}$/;

/** The standard conditions a grade maps to (structured data and feeds). */
export const GRADE_CONDITIONS = CONDITIONS;

/**
 * @typedef {object} GradeDraft a grade as edited: days as typed, empty strings for nothing
 * @property {string} key
 * @property {string} label
 * @property {string} description
 * @property {string} returnDays
 * @property {string} warrantyDays
 * @property {string} categoryId the category this entry is the definition for (E45); '' = every category
 * @property {string[]} categoryIds
 * @property {string} color
 * @property {string} video
 * @property {{ summary: string, bullets: Array<{ text: string, icon: string }> }} content
 * @property {boolean} active
 * @property {'new' | 'refurbished' | 'used'} condition
 * @property {{ title: string, description: string, body: string, faqs: Array<{ question: string, answer: string }> }} seo
 */

/**
 * A key made from a name when none was typed (`Express Delivery` → `express_delivery`).
 * @param {unknown} key
 * @param {unknown} name
 */
export const keyOf = (key, name) => {
	const typed = String(key ?? '').trim();
	if (typed !== '') return typed;
	return String(name ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^[^a-z]+|_+$/g, '')
		.slice(0, 40);
};

/**
 * Lines as saved: trimmed, empty ones dropped.
 * @param {unknown} lines
 */
export const cleanLines = (lines) =>
	(Array.isArray(lines) ? lines : []).map((line) => String(line).trim()).filter((line) => line !== '');

/**
 * Whole days typed, or null when left empty (the feature's own default applies).
 * @param {unknown} text
 */
export const daysOf = (text) => {
	const value = String(text ?? '').trim();
	return value === '' ? null : Number(value);
};

/**
 * Ids typed or pasted into a tag field: split on commas, spaces and new lines, trimmed, without repeats.
 * @param {string} text
 * @returns {string[]}
 */
export const splitIds = (text) => [
	...new Set(
		text
			.split(/[\s,;]+/)
			.map((part) => part.trim())
			.filter((part) => part !== ''),
	),
];

/**
 * The YouTube video id of a pasted YouTube address (watch, youtu.be, shorts, embed or live), else the text as typed (a
 * storage key or an id).
 * @param {string} text
 */
export const videoOf = (text) => {
	const value = text.trim();
	let url;
	try {
		url = new URL(value);
	} catch {
		return value;
	}
	const host = url.hostname.replace(/^(www\.|m\.)/, '');
	const id =
		host === 'youtu.be'
			? url.pathname.split('/')[1]
			: host === 'youtube.com' || host === 'youtube-nocookie.com'
				? (url.searchParams.get('v') ?? /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(url.pathname)?.[1])
				: undefined;
	return id && /^[\w-]{6,20}$/.test(id) ? id : value;
};

/** @param {number | null} value */
const daysText = (value) => (value === null ? '' : String(value));

/** @returns {GradeDraft} a new grade (offered, used) */
export const blankGrade = () => ({
	key: '',
	label: '',
	description: '',
	returnDays: '',
	warrantyDays: '',
	categoryId: '',
	categoryIds: [],
	color: '',
	video: '',
	content: { summary: '', bullets: [] },
	active: true,
	condition: 'used',
	seo: { title: '', description: '', body: '', faqs: [] },
});

/**
 * A grade of the saved list (`core/grades.js` `checkGrades` stores every field).
 * @typedef {Required<Omit<import('../../core/grades.js').Grade, 'videoUrl'>>} SavedGrade
 */

/**
 * A saved grade as the editor shows it: days as text, no category as ''.
 * @param {SavedGrade} grade
 * @returns {GradeDraft}
 */
export const loadGrade = (grade) => ({
	key: grade.key,
	label: grade.label,
	description: grade.description,
	returnDays: daysText(grade.returnDays),
	warrantyDays: daysText(grade.warrantyDays),
	categoryId: grade.categoryId ?? '',
	categoryIds: [...grade.categoryIds],
	color: grade.color,
	video: grade.video,
	content: {
		summary: grade.content.summary,
		bullets: grade.content.bullets.map((bullet) => ({ text: bullet.text, icon: bullet.icon })),
	},
	active: grade.active,
	condition: grade.condition,
	seo: {
		title: grade.seo.title,
		description: grade.seo.description,
		body: grade.seo.body,
		faqs: grade.seo.faqs.map((faq) => ({ question: faq.question, answer: faq.answer })),
	},
});

/**
 * A grade as saved: the key made from the name when empty, texts trimmed, empty bullets and questions dropped, days as
 * numbers (null = the Returns setting).
 * @param {GradeDraft} draft
 */
export const cleanGrade = (draft) => ({
	key: keyOf(draft.key, draft.label),
	label: draft.label.trim(),
	description: draft.description.trim(),
	returnDays: daysOf(draft.returnDays),
	warrantyDays: daysOf(draft.warrantyDays),
	categoryId: draft.categoryId.trim() || null,
	categoryIds: cleanLines(draft.categoryIds),
	color: draft.color.trim(),
	video: videoOf(draft.video),
	content: {
		summary: draft.content.summary.trim(),
		bullets: draft.content.bullets
			.map((bullet) => ({ text: bullet.text.trim(), icon: bullet.icon.trim() }))
			.filter((bullet) => bullet.text !== ''),
	},
	active: draft.active,
	condition: draft.condition,
	seo: {
		title: draft.seo.title.trim(),
		description: draft.seo.description.trim(),
		body: draft.seo.body.trim(),
		faqs: draft.seo.faqs
			.map((faq) => ({ question: faq.question.trim(), answer: faq.answer.trim() }))
			.filter((faq) => faq.question !== '' || faq.answer !== ''),
	},
});

/**
 * What stops a grade being applied to the list, by field: a name, a key the server takes and that no other grade for
 * the same category (or for every category) has (E45).
 * @param {GradeDraft} draft
 * @param {string[]} otherKeys the keys of the other grades for the same category (as saved)
 * @returns {{ label?: 'missing', key?: 'invalid' | 'taken' }}
 */
export const gradeProblems = (draft, otherKeys) => {
	const key = keyOf(draft.key, draft.label);
	const unnamed = draft.label.trim() === '';
	/** @type {{ key?: 'invalid' | 'taken' }} */
	const keyed = !GRADE_KEY.test(key)
		? // nothing typed yet: the missing name says it
			unnamed && key === ''
			? {}
			: { key: 'invalid' }
		: otherKeys.includes(key)
			? { key: 'taken' }
			: {};
	return { ...(unnamed ? { label: /** @type {const} */ ('missing') } : {}), ...keyed };
};

// ------------------------------------------------------------------------------------------------- order flow

/** @typedef {import('../../core/model.js').OrderFlow} OrderFlow */

/**
 * The flow with a status's key changed: its moves, triggers and starts follow it.
 * @param {Required<OrderFlow>} flow @param {string} from the key before @param {string} to the key now
 * @returns {Required<OrderFlow>}
 */
export const renameFlowStatus = (flow, from, to) => {
	/** @param {string} key */
	const swap = (key) => (key === from ? to : key);
	return {
		statuses: flow.statuses.map((status) => (status.key === from ? { ...status, key: to } : status)),
		moves: flow.moves.map((move) => ({ ...move, from: swap(move.from), to: swap(move.to) })),
		triggers: {
			paid: swap(flow.triggers.paid),
			windowEnd: swap(flow.triggers.windowEnd),
			refundsCover: swap(flow.triggers.refundsCover),
		},
		starts: { cod: swap(flow.starts.cod), pickup: swap(flow.starts.pickup), free: swap(flow.starts.free) },
	};
};

/**
 * The flow without a status: its moves go, and a trigger or start that named it is left out (the server fills today's
 * choice; `paid` and `refundsCover` become none).
 * @param {Required<OrderFlow>} flow @param {string} key
 * @returns {OrderFlow}
 */
export const removeFlowStatus = (flow, key) => ({
	statuses: flow.statuses.filter((status) => status.key !== key),
	moves: flow.moves.filter((move) => move.from !== key && move.to !== key),
	triggers: /** @type {any} */ (
		Object.fromEntries(
			Object.entries(flow.triggers)
				.filter(([name, value]) => value !== key || name !== 'windowEnd')
				.map(([name, value]) => [name, value === key ? '' : value]),
		)
	),
	starts: /** @type {any} */ (Object.fromEntries(Object.entries(flow.starts).filter(([, value]) => value !== key))),
});

/**
 * The flow to save: statuses saved without a key get one from their name (`keyOf`) and everything naming them follows;
 * names are trimmed; moves the role rules do not allow (`allowed`) are left out. Every other field is kept as it is, so
 * saving never drops an option, a shopper text, a trigger or a start.
 * @param {OrderFlow} flow @param {(flow: OrderFlow, move: OrderFlow['moves'][number]) => boolean} allowed
 * @returns {OrderFlow}
 */
export const flowToSave = (flow, allowed) => {
	const keys = new Map(flow.statuses.map((status) => [status.key, keyOf(status.key, status.label)]));
	/** @param {string} key */
	const swap = (key) => keys.get(key) ?? key;
	const statuses = flow.statuses.map((status) => ({ ...status, key: swap(status.key), label: status.label.trim() }));
	const moves = flow.moves.map((move) => ({ ...move, from: swap(move.from), to: swap(move.to) }));
	/** @param {Record<string, string> | undefined} entries */
	const remap = (entries) =>
		entries
			? Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, value ? swap(value) : value]))
			: undefined;
	const next = { statuses, moves };
	return {
		...next,
		moves: moves.filter((move) => allowed(next, move)),
		.../** @type {any} */ (flow.triggers ? { triggers: remap(/** @type {any} */ (flow.triggers)) } : {}),
		.../** @type {any} */ (flow.starts ? { starts: remap(/** @type {any} */ (flow.starts)) } : {}),
	};
};
