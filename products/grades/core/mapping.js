/**
 * Tier → external vocabulary mapping (pure). Vocabularies are merchant data (the `mapping` feature ships schema.org
 * `itemCondition` and a shopping-feed `condition` as editable defaults): each lists the values its target accepts,
 * a fallback and the tier → value table. A mapped value outside `allowed` is reported and replaced by the fallback,
 * so structured data and feeds built from the same table never disagree.
 * @module
 */
import { cleanText, isKey, isObject } from './text.js';

/** Targets a vocabulary can serve. */
export const TARGETS = Object.freeze(['structured_data', 'feed', 'marketplace', 'other']);

/**
 * @typedef {object} MappingRow
 * @property {string} tier
 * @property {string | null} value
 * @property {'mapped' | 'fallback' | 'none'} source
 * @property {string | null} problem `not_allowed` when the configured value is not an allowed value
 */

/**
 * @typedef {object} Vocabulary
 * @property {string} key
 * @property {string} name
 * @property {string} target
 * @property {string} property
 * @property {string[]} allowed
 * @property {string | null} fallback
 * @property {boolean} display
 * @property {MappingRow[]} rows one per tier, ladder order
 * @property {Readonly<Record<string, string | null>>} byTier
 */

/** @param {unknown} value @param {string[]} allowed */
const isAllowed = (value, allowed) => allowed.length === 0 || allowed.includes(/** @type {string} */ (value));

/**
 * The vocabularies of a website, resolved for every tier.
 * @param {unknown} list `mapping.vocabularies`
 * @param {ReadonlyArray<import('./tiers.js').Tier>} tiers
 * @returns {Vocabulary[]}
 */
export const resolveVocabularies = (list, tiers) => {
	const seen = new Set();
	/** @type {Vocabulary[]} */
	const out = [];
	for (const entry of Array.isArray(list) ? list : []) {
		if (!isObject(entry) || !isKey(entry.key) || seen.has(entry.key)) continue;
		seen.add(entry.key);
		const allowed = (Array.isArray(entry.allowed) ? entry.allowed : [])
			.map((value) => cleanText(value, 200))
			.filter((value) => value !== null);
		const rawFallback = cleanText(entry.fallback, 200);
		const fallback = rawFallback !== null && isAllowed(rawFallback, allowed) ? rawFallback : null;
		/** @type {Map<string, string>} */
		const configured = new Map();
		for (const row of Array.isArray(entry.values) ? entry.values : []) {
			const value = isObject(row) ? cleanText(row.value, 200) : null;
			if (isObject(row) && isKey(row.tier) && value !== null && !configured.has(row.tier)) configured.set(row.tier, value);
		}
		const rows = tiers.map((tier) => {
			const value = configured.get(tier.key);
			if (value !== undefined && isAllowed(value, allowed))
				return { tier: tier.key, value, source: /** @type {const} */ ('mapped'), problem: null };
			return {
				tier: tier.key,
				value: fallback,
				source: fallback === null ? /** @type {const} */ ('none') : /** @type {const} */ ('fallback'),
				problem: value === undefined ? null : 'not_allowed',
			};
		});
		out.push({
			key: entry.key,
			name: cleanText(entry.name, 80) ?? entry.key,
			target: TARGETS.includes(entry.target) ? entry.target : 'other',
			property: typeof entry.property === 'string' && entry.property.length > 0 ? entry.property.slice(0, 64) : entry.key,
			allowed,
			fallback,
			display: entry.display === true,
			rows,
			byTier: Object.freeze(Object.fromEntries(rows.map((row) => [row.tier, row.value]))),
		});
	}
	return out;
};

/**
 * Values of a tier in every vocabulary (`{ [vocabularyKey]: value }`; null without a value).
 * @param {Vocabulary[]} vocabularies
 * @param {string | null} tier
 * @returns {Record<string, string | null>}
 */
export const valuesFor = (vocabularies, tier) =>
	Object.fromEntries(vocabularies.map((v) => [v.key, tier === null ? v.fallback : (v.byTier[tier] ?? v.fallback)]));

/**
 * Structured-data properties of a tier (e.g. `{ itemCondition: 'https://schema.org/UsedCondition' }`) to merge into
 * an Offer node: the structured_data vocabularies with a value.
 * @param {Vocabulary[]} vocabularies
 * @param {string | null} tier
 * @returns {Record<string, string>}
 */
export const offerProperties = (vocabularies, tier) => {
	/** @type {Record<string, string>} */
	const out = {};
	const values = valuesFor(vocabularies, tier);
	for (const v of vocabularies)
		if (v.target === 'structured_data' && typeof values[v.key] === 'string' && !Object.hasOwn(out, v.property))
			out[v.property] = /** @type {string} */ (values[v.key]);
	return out;
};

/**
 * A readable form of a vocabulary value: the last path segment of a URL split at capitals
 * (`https://schema.org/UsedCondition` → `Used Condition`), other values unchanged.
 * @param {string} value
 */
export const readableValue = (value) => {
	if (!/^https?:\/\//.test(value)) return value;
	const segment =
		value
			.replace(/[/#?]+$/, '')
			.split(/[/#]/)
			.pop() ?? value;
	return segment.replace(/([a-z])([A-Z])/g, '$1 $2');
};

/**
 * Problems of the mapping table for the dashboard.
 * @param {Vocabulary[]} vocabularies
 * @returns {Array<{ vocabulary: string, tier: string, problem: string }>}
 */
export const mappingProblems = (vocabularies) =>
	vocabularies.flatMap((v) =>
		v.rows.flatMap((row) =>
			row.problem
				? [{ vocabulary: v.key, tier: row.tier, problem: row.problem }]
				: row.source === 'none'
					? [{ vocabulary: v.key, tier: row.tier, problem: 'unmapped' }]
					: [],
		),
	);
