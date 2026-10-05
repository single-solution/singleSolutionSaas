/**
 * A small Atlas Search simulator for tests (mongodb-memory-server has no `$search`): it evaluates the operators the
 * product's `$search` builder uses — `compound` (filter / must / should / minimumShouldMatch), `equals`, `in`,
 * `text` (with `fuzzy.maxEdits`) and `autocomplete` (prefix of a word, optional fuzzy) — over documents read from the
 * merchant collection, with lucene-like analysis approximated by the product's own tokenizer. Scores add the `boost`
 * values of matching clauses. It lets the shared engine suite assert the same results for both engines.
 */
import { editDistance, tokenize } from '../core/text.js';

/** Fields Atlas would not return through the product's projection. */
const HIDDEN = new Set(['_id', 'terms', 'fieldTerms', 'publicTerms', 'suggest']);

/** @param {any} doc @param {string} path */
const valueAt = (doc, path) => path.split('.').reduce((v, key) => (v === null || v === undefined ? undefined : v[key]), doc);

/** @param {unknown} value */
const wordsOf = (value) => tokenize(Array.isArray(value) ? value.join(' ') : String(value ?? ''));

/**
 * @param {any} clause
 * @param {any} doc
 * @returns {number | null} score, null = no match
 */
export const evaluate = (clause, doc) => {
	if (clause.equals) return valueAt(doc, clause.equals.path) === clause.equals.value ? 0 : null;
	if (clause.in) return clause.in.value.includes(valueAt(doc, clause.in.path)) ? 0 : null;
	const boost = (/** @type {any} */ op) => op.score?.boost?.value ?? 1;
	if (clause.text) {
		const words = wordsOf(valueAt(doc, clause.text.path));
		const queries = (Array.isArray(clause.text.query) ? clause.text.query : [clause.text.query]).flatMap(
			(/** @type {string} */ q) => tokenize(q),
		);
		const edits = clause.text.fuzzy?.maxEdits ?? 0;
		const hit = queries.some((/** @type {string} */ q) => words.some((w) => editDistance(q, w, edits) <= edits));
		return hit ? boost(clause.text) : null;
	}
	if (clause.autocomplete) {
		const words = wordsOf(valueAt(doc, clause.autocomplete.path));
		const edits = clause.autocomplete.fuzzy?.maxEdits ?? 0;
		const queries = tokenize(clause.autocomplete.query);
		const hit = queries.every((q) =>
			words.some((w) => editDistance(q, [...w].slice(0, [...q].length).join(''), edits) <= edits),
		);
		return hit ? boost(clause.autocomplete) : null;
	}
	if (clause.compound) {
		const c = clause.compound;
		let score = 0;
		for (const f of c.filter ?? []) if (evaluate(f, doc) === null) return null;
		for (const m of c.must ?? []) {
			const s = evaluate(m, doc);
			if (s === null) return null;
			score += s;
		}
		let matched = 0;
		for (const s of c.should ?? []) {
			const v = evaluate(s, doc);
			if (v !== null) {
				matched += 1;
				score += v;
			}
		}
		if ((c.should ?? []).length > 0 && matched < (c.minimumShouldMatch ?? 0)) return null;
		return score;
	}
	throw new Error(`unsupported operator ${Object.keys(clause).join(',')}`);
};

/**
 * An `atlasRunner` for `createSearchApp`: evaluates the pipeline (`$search`, `$match`, `$limit`, `$project`) over the
 * collection's documents.
 * @param {{ calls?: any[] }} [record]
 */
export const createAtlasRunner =
	(record = {}) =>
	/** @param {any} collection @param {any[]} pipeline @param {string} websiteId */
	async (collection, pipeline, websiteId) => {
		record.calls?.push({ pipeline, websiteId });
		const [search, match, limit] = pipeline;
		const docs = await collection.find({ websiteId: match.$match.websiteId }).toArray();
		return docs
			.map((/** @type {any} */ doc) => ({ doc, score: evaluate({ compound: search.$search.compound }, doc) }))
			.filter((/** @type {any} */ entry) => entry.score !== null)
			.sort((/** @type {any} */ a, /** @type {any} */ b) => /** @type {number} */ (b.score) - /** @type {number} */ (a.score))
			.slice(0, limit.$limit)
			.map((/** @type {any} */ { doc, score }) => ({
				...Object.fromEntries(Object.entries(doc).filter(([key]) => !HIDDEN.has(key))),
				score,
			}));
	};

/** An `atlasProbe` that reports a ready index. */
export const readyProbe = async () => ({ state: 'ready', detail: null });
