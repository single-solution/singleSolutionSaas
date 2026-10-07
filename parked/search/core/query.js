/**
 * Query planning shared by both engines (pure): the normalised query, its words without the website's ignored words,
 * synonyms per word, whether the last word matches as a prefix (as you type) and how many typos each word allows
 * (bounded edit distance; never for numbers), plus pinned results. The same plan drives the portable engine's term
 * expansion and the Atlas `$search` builder, so both engines follow the same ranking settings.
 * @module
 */
import { normalise, tokenize } from './text.js';

/** Words of a query that count. */
export const MAX_QUERY_TOKENS = 10;
/** Synonyms one word expands to. */
export const MAX_SYNONYMS = 10;

/**
 * @typedef {object} Ranking resolved ranking settings
 * @property {Map<string, number>} weights field key → weight (absent = 1)
 * @property {Map<string, string[]>} synonyms term → alternative terms
 * @property {boolean} typo
 * @property {number} typoMin
 * @property {number} typoTwo
 * @property {number} maxEdits
 * @property {boolean} prefix
 * @property {'all' | 'any' | 'all_then_any'} mode
 * @property {Set<string>} stopwords
 * @property {number} boostWeight
 * @property {Map<string, string[]>} pinned normalised query → document ids
 */

/**
 * @typedef {object} PlannedToken
 * @property {string} term
 * @property {string[]} synonyms
 * @property {boolean} prefix
 * @property {number} maxEdits
 */

/**
 * @typedef {object} QueryPlan
 * @property {string} text normalised query
 * @property {PlannedToken[]} tokens
 * @property {string[]} pinned document ids shown first
 * @property {Ranking['mode']} mode
 */

/**
 * Ranking settings from the `ranking` configuration (feature schema defaults already applied).
 * @param {Record<string, any>} config
 * @returns {Ranking}
 */
export const rankingOf = (config) => {
	/** @type {Map<string, number>} */
	const weights = new Map();
	for (const entry of Array.isArray(config.field_boosts) ? config.field_boosts : [])
		if (typeof entry?.field === 'string' && typeof entry.weight === 'number' && Number.isFinite(entry.weight))
			weights.set(entry.field, Math.max(0, Math.min(100, entry.weight)));
	/** @type {Map<string, Set<string>>} */
	const synonyms = new Map();
	for (const group of Array.isArray(config.synonyms) ? config.synonyms : []) {
		const members = (Array.isArray(group?.terms) ? group.terms : [])
			.filter((/** @type {unknown} */ term) => typeof term === 'string')
			.map((/** @type {string} */ term) => tokenize(term))
			.filter((/** @type {string[]} */ tokens) => tokens.length > 0);
		for (const member of members) {
			if (member.length !== 1) continue;
			const term = /** @type {string} */ (member[0]);
			const set = synonyms.get(term) ?? new Set();
			for (const other of members) for (const token of other) if (token !== term) set.add(token);
			synonyms.set(term, set);
		}
	}
	/** @type {Map<string, string[]>} */
	const pinned = new Map();
	for (const entry of Array.isArray(config.pinned) ? config.pinned : []) {
		const key = normalise(entry?.query);
		if (key === '' || pinned.has(key) || !Array.isArray(entry.ids)) continue;
		pinned.set(key, entry.ids.filter((/** @type {unknown} */ id) => typeof id === 'string').slice(0, 10));
	}
	const mode = ['all', 'any', 'all_then_any'].includes(config.match_mode) ? config.match_mode : 'all_then_any';
	const int = (/** @type {unknown} */ value, /** @type {number} */ fallback) =>
		Number.isInteger(value) ? Number(value) : fallback;
	return {
		weights,
		synonyms: new Map([...synonyms].map(([term, set]) => [term, [...set].slice(0, MAX_SYNONYMS)])),
		typo: config.typo_tolerance !== false,
		typoMin: int(config.typo_min_length, 4),
		typoTwo: int(config.typo_two_edits_length, 8),
		maxEdits: Math.max(0, Math.min(2, int(config.max_edits, 2))),
		prefix: config.prefix_matching !== false,
		mode,
		stopwords: new Set(
			(Array.isArray(config.stopwords) ? config.stopwords : []).flatMap((/** @type {unknown} */ word) => tokenize(word)),
		),
		boostWeight: typeof config.document_boost_weight === 'number' ? Math.max(0, config.document_boost_weight) : 1,
		pinned,
	};
};

/**
 * Typos a word allows.
 * @param {string} term
 * @param {Ranking} ranking
 */
export const editsFor = (term, ranking) => {
	if (!ranking.typo || /^\p{N}+$/u.test(term)) return 0;
	const length = [...term].length;
	const edits = length >= ranking.typoTwo ? 2 : length >= ranking.typoMin ? 1 : 0;
	return Math.min(edits, ranking.maxEdits);
};

/**
 * Field weight (absent = 1).
 * @param {Ranking} ranking
 * @param {string} field
 */
export const weightOf = (ranking, field) => ranking.weights.get(field) ?? 1;

/**
 * Plan a query.
 * @param {unknown} raw the query as typed
 * @param {Ranking} ranking
 * @param {{ maxChars: number }} options
 * @returns {QueryPlan}
 */
export const planQuery = (raw, ranking, { maxChars }) => {
	const typed = String(raw ?? '').slice(0, maxChars);
	const text = normalise(typed);
	/** @type {string[]} */
	const words = [];
	for (const token of tokenize(text)) if (!words.includes(token)) words.push(token);
	const kept = words.filter((word) => !ranking.stopwords.has(word));
	const chosen = (kept.length > 0 ? kept : words).slice(0, MAX_QUERY_TOKENS);
	const asYouType = ranking.prefix && !/\s$/u.test(typed);
	return {
		text,
		tokens: chosen.map((term, index) => ({
			term,
			synonyms: ranking.synonyms.get(term) ?? [],
			prefix: asYouType && index === chosen.length - 1,
			maxEdits: editsFor(term, ranking),
		})),
		pinned: ranking.pinned.get(text) ?? [],
		mode: ranking.mode,
	};
};
