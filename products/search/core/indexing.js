/**
 * Document analysis for the index (pure): the terms of every searchable field (the portable engine's inverted index is
 * the multikey `terms` index over them), the terms browsers may match (`publicTerms`, which also feed the public
 * vocabulary of completions and typo candidates), and the `suggest` text of public prefix fields (Atlas
 * autocomplete). Changes to the vocabulary are computed as set differences, so an update touches only the terms that
 * changed.
 * @module
 */
import { clip, termVariants, tokenize } from './text.js';
import { textOf } from './schema.js';

/** Unique terms kept per field and per document. */
export const MAX_FIELD_TERMS = 500;
export const MAX_TERMS = 2000;
/** Characters of the Atlas autocomplete text. */
export const MAX_SUGGEST = 1000;

/**
 * @typedef {object} Analysis
 * @property {Record<string, string[]>} fieldTerms
 * @property {string[]} terms every searchable field
 * @property {string[]} publicTerms searchable fields that are not private
 * @property {string} suggest text of public prefix fields
 */

/**
 * Unique terms of a text, in order of first use.
 * @param {string} text
 * @param {number} max
 */
export const termsOf = (text, max = MAX_FIELD_TERMS) => {
	/** @type {Set<string>} */
	const out = new Set();
	for (const token of tokenize(text)) {
		for (const term of termVariants(token)) {
			out.add(term);
			if (out.size >= max) return [...out];
		}
	}
	return [...out];
};

/**
 * @param {import('./schema.js').DocumentInput} doc
 * @param {import('./schema.js').TypeDef} type
 * @param {{ maxFieldChars: number }} options
 * @returns {Analysis}
 */
export const analyse = (doc, type, { maxFieldChars }) => {
	/** @type {Record<string, string[]>} */
	const fieldTerms = {};
	/** @type {Set<string>} */
	const all = new Set();
	/** @type {Set<string>} */
	const pub = new Set();
	/** @type {string[]} */
	const suggest = [];
	for (const field of type.fields) {
		if (!field.searchable || !Object.hasOwn(doc.fields, field.key)) continue;
		const text = clip(textOf(doc.fields[field.key]), maxFieldChars);
		const terms = termsOf(text);
		if (terms.length === 0) continue;
		fieldTerms[field.key] = terms;
		for (const term of terms) {
			if (all.size < MAX_TERMS) all.add(term);
			if (!field.private && pub.size < MAX_TERMS) pub.add(term);
		}
		if (field.prefix && !field.private) suggest.push(clip(text, 300));
	}
	return { fieldTerms, terms: [...all], publicTerms: [...pub], suggest: clip(suggest.join(' · '), MAX_SUGGEST) };
};

/**
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {string[]} terms of `a` not in `b`
 */
const minus = (a, b) => {
	const other = new Set(b);
	return a.filter((term) => !other.has(term));
};

/**
 * Vocabulary changes between two analyses (either may be absent: a new or a removed document).
 * @param {{ terms?: readonly string[], publicTerms?: readonly string[] } | null} before
 * @param {{ terms?: readonly string[], publicTerms?: readonly string[] } | null} after
 */
export const vocabularyChange = (before, after) => {
	const b = { terms: before?.terms ?? [], pub: before?.publicTerms ?? [] };
	const a = { terms: after?.terms ?? [], pub: after?.publicTerms ?? [] };
	return {
		add: minus(a.terms, b.terms),
		remove: minus(b.terms, a.terms),
		addPublic: minus(a.pub, b.pub),
		removePublic: minus(b.pub, a.pub),
	};
};
