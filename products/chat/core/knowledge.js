/**
 * Knowledge (pure): page text extraction, chunking and keyword retrieval with BM25 — no vector database. Chunks are
 * stored in the merchant database with their term frequencies; a query loads only chunks sharing a term (indexed),
 * scores them with BM25 (+ a per-source priority boost) and keeps passages covering a minimum share of the query.
 * @module
 */
import { tokenize, truncate } from './text.js';

/** @typedef {{ id: string, sourceType: 'entry' | 'page', sourceId: string, title: string, url: string | null, text: string, terms: string[], tf: Record<string, number>, length: number, priority: number }} Chunk */
/** @typedef {Omit<Chunk, 'id'>} ChunkDraft */

/** Chunking and ranking constants (code constants, never settings). */
export const RETRIEVAL = Object.freeze({ size: 900, overlap: 120, maxChunks: 200, k1: 1.2, b: 0.75, minMatch: 0.2, topK: 5 });

/** Most knowledge entries and pages a website has. */
export const MAX_ENTRIES = 2000;
export const MAX_PAGES = 200;

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
const termsOf = (text, { boost = '' } = {}) => {
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
 * Chunks of a knowledge entry: an FAQ entry is one chunk (question terms count twice); an article is chunked.
 * FAQ entries rank a little above articles and pages.
 * @param {{ id: string, kind: 'faq' | 'article', title: string, text: string }} entry
 * @returns {ChunkDraft[]}
 */
export const entryChunks = (entry) => {
	const pieces =
		entry.kind === 'faq'
			? [`${entry.title}\n${entry.text}`]
			: chunkText(entry.text, { size: RETRIEVAL.size, overlap: RETRIEVAL.overlap, max: RETRIEVAL.maxChunks });
	return pieces.map((text) => ({
		sourceType: /** @type {const} */ ('entry'),
		sourceId: entry.id,
		title: entry.title,
		url: null,
		text,
		...termsOf(text, { boost: entry.title }),
		priority: entry.kind === 'faq' ? 2 : 1,
	}));
};

/**
 * Chunks of a fetched website page.
 * @param {{ id: string, url: string, title: string, text: string }} page
 * @returns {ChunkDraft[]}
 */
export const pageChunks = (page) =>
	chunkText(page.text, { size: RETRIEVAL.size, overlap: RETRIEVAL.overlap, max: RETRIEVAL.maxChunks }).map((text) => ({
		sourceType: /** @type {const} */ ('page'),
		sourceId: page.id,
		title: page.title,
		url: page.url,
		text,
		...termsOf(text, { boost: page.title }),
		priority: 0,
	}));

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
 * Check a knowledge entry (FAQ entry or article).
 * @param {unknown} body
 * @returns {{ ok: true, value: { kind: 'faq' | 'article', title: string, text: string } } | { ok: false, errors: string[] }}
 */
export const checkEntry = (body) => {
	const b = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
	/** @type {string[]} */
	const errors = [];
	if (b.kind !== 'faq' && b.kind !== 'article') errors.push('The kind is faq or article.');
	const title = typeof b.title === 'string' ? b.title.trim() : '';
	if (!title || title.length > 300) errors.push('The question or title is 1–300 characters.');
	const text = typeof b.text === 'string' ? b.text.trim() : '';
	if (!text || text.length > 20_000) errors.push('The answer or text is 1–20,000 characters.');
	return errors.length > 0
		? { ok: false, errors }
		: { ok: true, value: { kind: /** @type {'faq' | 'article'} */ (b.kind), title, text } };
};
