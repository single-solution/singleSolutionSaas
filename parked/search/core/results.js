/**
 * The one response shape of both engines (pure): candidates with their engine score are re-ranked with the document
 * boost, pinned documents go first, the page is cut with an opaque offset cursor bound to the query, and every hit is
 * shown as the key may see it (`hitView`). `GET /v1/search` answers `{ query, items, total, hasMore, nextCursor,
 * engine, relaxed }` whatever engine ran.
 * @module
 */
import { hitView } from './schema.js';

/**
 * @typedef {{ doc: Record<string, any>, score: number }} Scored
 */

/**
 * Final score: engine score lifted by the document boost (logarithmic, weighted by `document_boost_weight`).
 * @param {number} score
 * @param {unknown} boost
 * @param {number} weight
 */
export const finalScore = (score, boost, weight) =>
	score * (1 + weight * Math.log10(1 + (typeof boost === 'number' && boost > 0 ? boost : 0)));

/**
 * Rank candidates (stable on ties by id), pinned documents first in their configured order.
 * @param {Scored[]} candidates
 * @param {{ boostWeight: number, pinned?: Array<Record<string, any>> }} options
 * @returns {Scored[]}
 */
export const rankCandidates = (candidates, { boostWeight, pinned = [] }) => {
	const ranked = candidates
		.map((entry) => ({ doc: entry.doc, score: finalScore(entry.score, entry.doc.boost, boostWeight) }))
		.sort((a, b) => b.score - a.score || String(a.doc.id).localeCompare(String(b.doc.id)));
	const first = pinned.map((doc) => ({ doc, score: ranked[0]?.score ?? 1 }));
	const pinnedIds = new Set(pinned.map((doc) => doc.id));
	return [...first, ...ranked.filter((entry) => !pinnedIds.has(entry.doc.id))];
};

/**
 * Opaque cursor of a result page (the offset, bound to the normalised query).
 * @param {number} offset
 * @param {string} text
 */
export const encodeCursor = (offset, text) =>
	Buffer.from(JSON.stringify({ o: offset, q: text.slice(0, 100) })).toString('base64url');

/**
 * @param {unknown} cursor
 * @param {string} text
 * @returns {number | null} the offset, null when absent; -1 when invalid
 */
export const decodeCursor = (cursor, text) => {
	if (cursor === undefined || cursor === null || cursor === '') return null;
	if (typeof cursor !== 'string' || cursor.length > 400) return -1;
	try {
		const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		return Number.isSafeInteger(value?.o) && value.o >= 0 && value.q === text.slice(0, 100) ? value.o : -1;
	} catch {
		return -1;
	}
};

/**
 * The search response.
 * @param {{ query: string, text: string, ranked: Scored[], offset: number, limit: number, maxResults: number,
 *   types: Map<string, import('./schema.js').TypeDef>, owner: boolean, engine: 'atlas' | 'portable',
 *   relaxed: boolean, capped: boolean, explain?: boolean }} input
 */
export const searchResponse = ({
	query,
	text,
	ranked,
	offset,
	limit,
	maxResults,
	types,
	owner,
	engine,
	relaxed,
	capped,
	explain = false,
}) => {
	const reachable = ranked.slice(0, maxResults);
	const slice = reachable.slice(offset, offset + limit);
	const end = offset + slice.length;
	const hasMore = end < reachable.length;
	return {
		query,
		items: slice.map(({ doc, score }) => ({
			...hitView(doc, types.get(String(doc.type)), { owner }),
			...(explain ? { score: Math.round(score * 1000) / 1000 } : {}),
		})),
		total: reachable.length,
		totalIsEstimate: capped,
		hasMore,
		nextCursor: hasMore ? encodeCursor(end, text) : null,
		engine,
		relaxed,
	};
};

/** @typedef {ReturnType<typeof searchResponse>} SearchResponse */
