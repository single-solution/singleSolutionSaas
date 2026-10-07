/**
 * The portable engine's pure part: expanding each query word to index terms (the word itself, its synonyms, longer
 * words it is a prefix of, words within its typo budget) and scoring candidate documents with field boosts and an
 * inverse document frequency, under the match mode. The adapters look the terms up in the vocabulary and fetch the
 * candidates through the multikey `terms` index (the inverted index); everything here is plain data in, data out.
 * @module
 */
import { editDistance } from './text.js';
import { weightOf } from './query.js';

/** How much each kind of match counts against an exact match. */
export const FACTORS = Object.freeze({ exact: 1, synonym: 0.9, typo1: 0.6, typo2: 0.4, prefixTypo: 0.8 });
/** Terms one word may expand to. */
export const MAX_PREFIX_TERMS = 20;
export const MAX_TYPO_TERMS = 8;
/** Terms of one candidate query. */
export const MAX_CANDIDATE_TERMS = 300;

/**
 * @typedef {{ term: string, df: number, pdf: number }} VocabularyEntry
 * @typedef {{ factor: number, kind: 'exact' | 'synonym' | 'prefix' | 'typo', edits: number }} Expansion
 * @typedef {{ token: import('./query.js').PlannedToken, terms: Map<string, Expansion> }} ExpandedToken
 */

/**
 * Prefix match factor: a longer typed prefix counts more (0.5–0.9).
 * @param {string} typed
 * @param {string} term
 */
export const prefixFactor = (typed, term) => 0.5 + 0.4 * Math.min(1, [...typed].length / Math.max(1, [...term].length));

/**
 * @param {Map<string, Expansion>} terms
 * @param {string} term
 * @param {Expansion} next
 */
const keepBest = (terms, term, next) => {
	const current = terms.get(term);
	if (!current || current.factor < next.factor) terms.set(term, next);
};

/**
 * Expand every planned word.
 * @param {import('./query.js').QueryPlan} plan
 * @param {{ prefixes: VocabularyEntry[][], typos: VocabularyEntry[][] }} lookups per token (same order as the plan)
 * @param {{ owner: boolean }} options browsers expand only to public vocabulary terms
 * @returns {ExpandedToken[]}
 */
export const expandTokens = (plan, lookups, { owner }) =>
	plan.tokens.map((token, index) => {
		/** @type {Map<string, Expansion>} */
		const terms = new Map();
		terms.set(token.term, { factor: FACTORS.exact, kind: 'exact', edits: 0 });
		for (const synonym of token.synonyms) keepBest(terms, synonym, { factor: FACTORS.synonym, kind: 'synonym', edits: 0 });
		const visible = (/** @type {VocabularyEntry} */ entry) => (owner ? entry.df > 0 : entry.pdf > 0);
		if (token.prefix) {
			const prefixes = (lookups.prefixes[index] ?? [])
				.filter((entry) => visible(entry) && entry.term.startsWith(token.term) && entry.term !== token.term)
				.sort((a, b) => (owner ? b.df - a.df : b.pdf - a.pdf) || a.term.localeCompare(b.term))
				.slice(0, MAX_PREFIX_TERMS);
			for (const entry of prefixes)
				keepBest(terms, entry.term, { factor: prefixFactor(token.term, entry.term), kind: 'prefix', edits: 0 });
		}
		if (token.maxEdits > 0) {
			const length = [...token.term].length;
			const typos = (lookups.typos[index] ?? [])
				.filter((entry) => visible(entry) && entry.term !== token.term)
				.map((entry) => {
					const full = editDistance(token.term, entry.term, token.maxEdits);
					const head = token.prefix
						? editDistance(token.term, [...entry.term].slice(0, length).join(''), token.maxEdits)
						: full;
					return { entry, edits: Math.min(full, head), partial: head < full };
				})
				.filter((match) => match.edits <= token.maxEdits)
				.sort((a, b) => a.edits - b.edits || (owner ? b.entry.df - a.entry.df : b.entry.pdf - a.entry.pdf))
				.slice(0, MAX_TYPO_TERMS);
			for (const { entry, edits, partial } of typos) {
				const base = edits === 1 ? FACTORS.typo1 : FACTORS.typo2;
				keepBest(terms, entry.term, { factor: partial ? base * FACTORS.prefixTypo : base, kind: 'typo', edits });
			}
		}
		return { token, terms };
	});

/**
 * Every term the candidates must contain one of (capped).
 * @param {ExpandedToken[]} expanded
 */
export const candidateTerms = (expanded) => {
	/** @type {Set<string>} */
	const out = new Set();
	for (const { terms } of expanded) for (const term of terms.keys()) if (out.size < MAX_CANDIDATE_TERMS) out.add(term);
	return [...out];
};

/**
 * Inverse document frequency weight of a term (1 for unknown terms).
 * @param {number} df documents with the term
 * @param {number} total documents in the index
 */
export const idf = (df, total) => 1 + Math.log(1 + Math.max(0, total) / (1 + Math.max(0, df)));

/**
 * @typedef {object} Candidate
 * @property {string} id
 * @property {string} type
 * @property {Record<string, string[]>} [fieldTerms]
 */

/**
 * Score candidates. A prefix expansion only matches fields that match as you type; private fields never match for
 * browsers (they are absent from `allowed`).
 * @template {Candidate} D
 * @param {D[]} docs
 * @param {ExpandedToken[]} expanded
 * @param {{ allowed: Map<string, Map<string, { prefix: boolean }>>, ranking: import('./query.js').Ranking,
 *   weightOfTerm: (term: string) => number, mode: import('./query.js').Ranking['mode'] }} context
 * @returns {{ scored: Array<{ doc: D, score: number, matched: number }>, relaxed: boolean }}
 */
export const scoreDocuments = (docs, expanded, { allowed, ranking, weightOfTerm, mode }) => {
	const needed = expanded.length;
	const all = docs.flatMap((doc) => {
		const fields = allowed.get(doc.type);
		if (!fields || needed === 0) return [];
		let score = 0;
		let matched = 0;
		for (const { terms } of expanded) {
			let best = 0;
			for (const [field, options] of fields) {
				const list = doc.fieldTerms?.[field];
				if (!Array.isArray(list) || list.length === 0) continue;
				const present = new Set(list);
				const weight = weightOf(ranking, field);
				for (const [term, expansion] of terms) {
					if (!present.has(term) || (expansion.kind === 'prefix' && !options.prefix)) continue;
					best = Math.max(best, weight * expansion.factor * weightOfTerm(term));
				}
			}
			if (best > 0) {
				matched += 1;
				score += best;
			}
		}
		return matched > 0 ? [{ doc, score: score * (matched / needed), matched }] : [];
	});
	const complete = all.filter((entry) => entry.matched === needed);
	if (mode === 'any') return { scored: all, relaxed: false };
	if (mode === 'all' || complete.length > 0 || needed === 1) return { scored: complete, relaxed: false };
	return { scored: all, relaxed: all.length > 0 };
};
