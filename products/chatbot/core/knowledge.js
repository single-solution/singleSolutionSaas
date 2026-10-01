/**
 * Knowledge (pure): page text extraction, chunking and keyword retrieval with BM25 — no vector database. Chunks are
 * stored in the merchant database with their term frequencies; a query loads only chunks sharing a term (indexed),
 * scores them with BM25 (+ a per-source priority boost) and keeps passages covering a minimum share of the query.
 * @module
 */
import { tokenize, truncate } from './text.js';

/** @typedef {{ id: string, sourceType: 'faq' | 'page', sourceId: string, title: string, url: string | null, text: string, terms: string[], tf: Record<string, number>, length: number, priority: number }} Chunk */

const ENTITIES = Object.freeze(
	/** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }),
);

/**
 * Decode the common HTML entities and numeric references.
 * @param {string} text
 */
export const decodeEntities = (text) =>
	text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, ref) => {
		const name = String(ref).toLowerCase();
		if (name.startsWith('#x') || name.startsWith('#')) {
			const code = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
			return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : ' ';
		}
		return ENTITIES[name] ?? match;
	});

/**
 * Visible text and title of an HTML page (scripts, styles, navigation chrome and comments removed; blocks become
 * lines). Regex-based on purpose: it only has to produce indexable text, never safe HTML.
 * @param {string} html
 * @returns {{ title: string, text: string }}
 */
export const htmlToText = (html) => {
	const source = String(html ?? '');
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source);
	const title = titleMatch
		? decodeEntities(titleMatch[1] ?? '')
				.replace(/\s+/g, ' ')
				.trim()
		: '';
	const body = source
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer)\b[\s\S]*?<\/\1\s*>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre|dd|dt|summary|details)\s*>/gi, '\n')
		.replace(/<li\b[^>]*>/gi, '\n- ')
		.replace(/<[^>]+>/g, ' ');
	const text = decodeEntities(body)
		.split('\n')
		.map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
		.filter(Boolean)
		.join('\n');
	return { title, text };
};

/**
 * Split text into chunks of at most `size` characters on paragraph, then sentence boundaries, with `overlap`
 * characters carried over.
 * @param {string} text
 * @param {{ size: number, overlap: number, max: number }} options
 * @returns {string[]}
 */
export const chunkText = (text, { size, overlap, max }) => {
	const paragraphs = String(text ?? '')
		.split(/\n{1,}/)
		.map((p) => p.trim())
		.filter(Boolean);
	/** @type {string[]} */
	const pieces = [];
	for (const paragraph of paragraphs) {
		if (paragraph.length <= size) pieces.push(paragraph);
		else {
			const sentences = paragraph.split(/(?<=[.!?。！？])\s+/u);
			for (const sentence of sentences) {
				if (sentence.length <= size) pieces.push(sentence);
				else for (let i = 0; i < sentence.length; i += size) pieces.push(sentence.slice(i, i + size));
			}
		}
	}
	/** @type {string[]} */
	const chunks = [];
	let current = '';
	for (const piece of pieces) {
		if (current && current.length + 1 + piece.length > size) {
			chunks.push(current);
			if (chunks.length >= max) return chunks;
			const tail = overlap > 0 ? current.slice(-overlap) : '';
			const cut = tail.indexOf(' ');
			current = cut >= 0 && overlap > 0 ? `${tail.slice(cut + 1)}\n${piece}` : piece;
			if (current.length > size) current = piece;
		} else current = current ? `${current}\n${piece}` : piece;
	}
	if (current && chunks.length < max) chunks.push(current);
	return chunks;
};

/**
 * Term frequencies of a text.
 * @param {string} text
 * @param {{ boost?: string }} [options] extra text whose terms count twice (FAQ questions, titles)
 * @returns {{ terms: string[], tf: Record<string, number>, length: number }}
 */
export const termsOf = (text, { boost = '' } = {}) => {
	/** @type {Record<string, number>} */
	const tf = {};
	const all = [...tokenize(text), ...tokenize(boost), ...tokenize(boost)];
	for (const term of all) tf[term] = (tf[term] ?? 0) + 1;
	return { terms: Object.keys(tf).slice(0, 2000), tf, length: all.length };
};

/**
 * Query terms (deduplicated, most informative first by length, at most `max`).
 * @param {string} query
 * @param {number} [max]
 */
export const queryTerms = (query, max = 24) => [...new Set(tokenize(query))].sort((a, b) => b.length - a.length).slice(0, max);

/**
 * BM25 with a source priority boost and a minimum query coverage.
 * @param {{ terms: string[], chunks: Chunk[], stats: { count: number, avgLength: number, df: Record<string, number> },
 *   k1: number, b: number, minMatch: number, topK: number }} input
 * @returns {Array<{ chunk: Chunk, score: number, coverage: number }>}
 */
export const rank = ({ terms, chunks, stats, k1, b, minMatch, topK }) => {
	if (terms.length === 0 || chunks.length === 0) return [];
	const N = Math.max(stats.count, chunks.length, 1);
	const avg = stats.avgLength > 0 ? stats.avgLength : 1;
	const scored = chunks.map((chunk) => {
		let score = 0;
		let matched = 0;
		for (const term of terms) {
			const f = chunk.tf[term] ?? 0;
			if (f === 0) continue;
			matched += 1;
			const df = Math.max(1, stats.df[term] ?? 1);
			const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
			score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * chunk.length) / avg));
		}
		const coverage = matched / terms.length;
		return { chunk, score: score * (1 + 0.1 * Math.max(0, chunk.priority)), coverage };
	});
	return scored
		.filter((entry) => entry.score > 0 && entry.coverage >= minMatch)
		.sort((x, y) => y.score - x.score || x.chunk.id.localeCompare(y.chunk.id))
		.slice(0, topK);
};

/**
 * Chunk documents of a FAQ entry (one chunk: question + answer; question terms boosted).
 * @param {{ id: string, question: string, answer: string, tags?: string[] }} entry
 * @param {{ priority: number }} options
 * @returns {Omit<Chunk, 'id'>[]}
 */
export const faqChunks = (entry, { priority }) => {
	const text = `${entry.question}\n${entry.answer}`;
	const { terms, tf, length } = termsOf(text, { boost: `${entry.question} ${(entry.tags ?? []).join(' ')}` });
	return [{ sourceType: 'faq', sourceId: entry.id, title: entry.question, url: null, text, terms, tf, length, priority }];
};

/**
 * Chunk documents of a fetched page.
 * @param {{ id: string, url: string, title: string, text: string, priority: number }} page
 * @param {{ size: number, overlap: number, max: number }} options
 * @returns {Omit<Chunk, 'id'>[]}
 */
export const pageChunks = (page, options) =>
	chunkText(page.text, options).map((text) => {
		const { terms, tf, length } = termsOf(text, { boost: page.title });
		return {
			sourceType: /** @type {const} */ ('page'),
			sourceId: page.id,
			title: page.title,
			url: page.url,
			text,
			terms,
			tf,
			length,
			priority: page.priority,
		};
	});

/**
 * Passages for the prompt and citations.
 * @param {Array<{ chunk: Chunk, score: number }>} ranked
 * @param {{ maxChars: number }} options
 * @returns {Array<{ ref: number, title: string, url: string | null, text: string, score: number }>}
 */
export const passages = (ranked, { maxChars }) =>
	ranked.map((entry, index) => ({
		ref: index + 1,
		title: entry.chunk.title,
		url: entry.chunk.url,
		text: truncate(entry.chunk.text, maxChars),
		score: Math.round(entry.score * 1000) / 1000,
	}));

/**
 * Validate a FAQ entry body.
 * @param {unknown} body
 * @param {{ partial?: boolean }} [options]
 * @returns {Array<{ path: string, code: string }>}
 */
export const validateEntry = (body, { partial = false } = {}) => {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return [{ path: '', code: 'object_required' }];
	const b = /** @type {Record<string, unknown>} */ (body);
	/** @type {Array<{ path: string, code: string }>} */
	const problems = [];
	for (const [field, max] of /** @type {const} */ ([
		['question', 1000],
		['answer', 8000],
	])) {
		const value = b[field];
		if (value === undefined && partial) continue;
		if (typeof value !== 'string' || value.trim() === '') problems.push({ path: `/${field}`, code: 'required' });
		else if ([...value].length > max) problems.push({ path: `/${field}`, code: 'too_long' });
	}
	if (
		b.tags !== undefined &&
		(!Array.isArray(b.tags) || b.tags.length > 30 || b.tags.some((t) => typeof t !== 'string' || t.length > 40))
	)
		problems.push({ path: '/tags', code: 'invalid' });
	if (b.enabled !== undefined && typeof b.enabled !== 'boolean') problems.push({ path: '/enabled', code: 'invalid' });
	if (b.priority !== undefined && (!Number.isInteger(b.priority) || Number(b.priority) < 0 || Number(b.priority) > 10))
		problems.push({ path: '/priority', code: 'invalid' });
	for (const key of Object.keys(b))
		if (!['question', 'answer', 'tags', 'enabled', 'priority', 'id'].includes(key))
			problems.push({ path: `/${key}`, code: 'unknown_field' });
	return problems;
};
