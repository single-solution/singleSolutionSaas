/**
 * Search, suggestions and analytics services. One query path for every caller: the query is planned with the
 * website's ranking settings, the engine returns candidates, pinned documents go first, and the response is shaped by
 * `core/results.js` for the key that asked (browsers never see or match private fields). Searches are metered (unit
 * `query`) and, when analytics is on, counted per day and normalised query only.
 */
import { analyticsKey, dayOf, expiryOf, reportOf, windowStart } from '../core/analytics.js';
import { planQuery } from '../core/query.js';
import { decodeCursor, rankCandidates, searchResponse } from '../core/results.js';
import { hitView, matchableFields } from '../core/schema.js';
import { suggestionsOf } from '../core/suggestions.js';
import { normalise } from '../core/text.js';

/** @typedef {import('./documents.js').Site} Site */
/** @typedef {import('./documents.js').Failure} Failure */

/** Candidates the portable engine scores per query (upper bound). */
export const MAX_CANDIDATES = 2000;
/** How long popular queries are cached per website. */
const POPULAR_TTL_MS = 5 * 60_000;

/**
 * Integer query parameter within bounds.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number | null} null when invalid
 */
export const intParam = (value, fallback, min, max) => {
	if (value === undefined || value === null || value === '') return fallback;
	const number = Number(value);
	return Number.isInteger(number) && number >= min && number <= max ? number : null;
};

/**
 * Document types a request searches (`types=a,b`; empty = every type; unknown types are an error).
 * @param {unknown} value
 * @param {Map<string, unknown>} types
 * @returns {string[] | null}
 */
export const typesParam = (value, types) => {
	if (value === undefined || value === null || value === '') return [];
	if (typeof value !== 'string' || value.length > 400) return null;
	const list = [...new Set(value.split(',').map((part) => part.trim()))].filter((part) => part !== '');
	return list.every((type) => types.has(type)) ? list : null;
};

/**
 * @param {{ engines: import('./engine.js').Engines, now: () => number, record: (websiteId: string, quantity: number) => void,
 *   log?: { warn?: Function } | null }} deps
 */
export const createSearchService = ({ engines, now, record, log = null }) => {
	/** @type {Map<string, { rows: Array<{ q: string, searches: number }>, at: number }>} */
	const popularCache = new Map();

	/**
	 * Count a search in the analytics (after the response; failures are logged, never surfaced).
	 * @param {Site} site
	 * @param {string} query
	 * @param {number} results
	 */
	const count = async (site, query, results) => {
		const { analytics } = site.settings;
		if (!site.settings.enabled('analytics') || !analytics.store_queries) return;
		const q = analyticsKey(query);
		if (!q) return;
		try {
			await site.repos.queries.record({
				day: dayOf(now(), site.settings.timeZone),
				q,
				results,
				expireAt: expiryOf(now(), analytics.retention_days),
			});
		} catch (error) {
			log?.warn?.('analytics write failed', { websiteId: site.websiteId, code: /** @type {any} */ (error)?.code ?? 'error' });
		}
	};

	/**
	 * Search.
	 * @param {Site} site
	 * @param {{ q?: unknown, limit?: unknown, cursor?: unknown, types?: unknown, track?: unknown, explain?: boolean }} input
	 * @param {{ owner: boolean }} options
	 * @returns {Promise<{ ok: true, value: import('../core/results.js').SearchResponse, counted: Promise<void> } | Failure>}
	 */
	const search = async (site, input, { owner }) => {
		const { index } = site.settings;
		const raw = typeof input.q === 'string' ? input.q : input.q === undefined ? '' : null;
		/** @type {Array<{ path: string, code: string }>} */
		const errors = [];
		if (raw === null || raw.length > index.max_query_chars * 4) errors.push({ path: '/q', code: 'query_invalid' });
		const limit = intParam(input.limit, Math.min(10, index.max_page_size), 1, index.max_page_size);
		if (limit === null) errors.push({ path: '/limit', code: 'limit_range' });
		const only = typesParam(input.types, site.settings.types);
		if (only === null) errors.push({ path: '/types', code: 'type_unknown' });
		const plan = planQuery(raw ?? '', site.settings.rank, { maxChars: index.max_query_chars });
		const offset = decodeCursor(input.cursor, plan.text);
		if (offset === -1) errors.push({ path: '/cursor', code: 'cursor_invalid' });
		if (errors.length > 0) return { ok: false, reason: 'validation_failed', errors };
		const allowed = matchableFields(site.settings.types, { owner, only });
		const base = {
			query: raw ?? '',
			text: plan.text,
			offset: offset ?? 0,
			limit: /** @type {number} */ (limit),
			maxResults: index.max_results,
			types: site.settings.types,
			owner,
			explain: input.explain === true,
		};
		if ([...plan.text].length < index.min_query_chars || plan.tokens.length === 0 || allowed.size === 0)
			return {
				ok: true,
				value: searchResponse({ ...base, ranked: [], engine: 'portable', relaxed: false, capped: false }),
				counted: Promise.resolve(),
			};
		const result = await engines.search(site, plan, {
			owner,
			allowed,
			limit: Math.min(MAX_CANDIDATES, Math.max(index.max_results * 5, 200)),
		});
		const pinned =
			plan.pinned.length > 0
				? (await site.repos.documents.activeByIds(plan.pinned))
						.filter((/** @type {any} */ doc) => allowed.has(String(doc.type)))
						.sort((/** @type {any} */ a, /** @type {any} */ b) => plan.pinned.indexOf(a.id) - plan.pinned.indexOf(b.id))
				: [];
		const ranked = rankCandidates(result.candidates, { boostWeight: site.settings.rank.boostWeight, pinned });
		const value = searchResponse({
			...base,
			ranked,
			engine: result.engine,
			relaxed: result.relaxed,
			capped: result.capped,
		});
		record(site.websiteId, 1);
		const first = (offset ?? 0) === 0 && input.track !== '0' && input.track !== 'false';
		return { ok: true, value, counted: first ? count(site, raw ?? '', value.total) : Promise.resolve() };
	};

	/**
	 * Suggestions for an empty or partial query.
	 * @param {Site} site
	 * @param {{ q?: unknown, types?: unknown }} input
	 * @param {{ owner: boolean }} options
	 * @returns {Promise<{ ok: true, value: ReturnType<typeof suggestionsOf> } | Failure>}
	 */
	const suggest = async (site, input, { owner }) => {
		const { suggestions, index } = site.settings;
		const raw = typeof input.q === 'string' ? input.q.slice(0, index.max_query_chars) : input.q === undefined ? '' : null;
		const only = typesParam(input.types, site.settings.types);
		if (raw === null || only === null)
			return {
				ok: false,
				reason: 'validation_failed',
				errors: [
					...(raw === null ? [{ path: '/q', code: 'query_invalid' }] : []),
					...(only === null ? [{ path: '/types', code: 'type_unknown' }] : []),
				],
			};
		const text = normalise(raw);
		const last = text.split(' ').at(-1) ?? '';
		const types = [...matchableFields(site.settings.types, { owner, only }).keys()];
		const popular = suggestions.popular && site.settings.enabled('analytics') ? await popularOf(site).catch(() => []) : [];
		const completions =
			suggestions.completions && last !== '' ? await site.repos.vocabulary.prefixed(last, { publicOnly: true }) : [];
		const recent =
			suggestions.recent_documents && text === '' && types.length > 0
				? (await site.repos.documents.recent({ types, limit: suggestions.recent_limit })).map((/** @type {any} */ doc) =>
						hitView(doc, site.settings.types.get(String(doc.type)), { owner: false }),
					)
				: [];
		return { ok: true, value: suggestionsOf({ query: raw, popular, completions, recent, settings: suggestions }) };
	};

	/**
	 * Popular queries of a website (cached).
	 * @param {Site} site
	 */
	const popularOf = async (site) => {
		const cached = popularCache.get(site.websiteId);
		if (cached && now() - cached.at < POPULAR_TTL_MS) return cached.rows;
		const { suggestions } = site.settings;
		const rows = await site.repos.queries.totals(windowStart(now(), suggestions.popular_days, site.settings.timeZone), {
			limit: 200,
			sort: 'searches',
			minSearches: suggestions.popular_min_count,
			withResults: true,
		});
		popularCache.set(site.websiteId, { rows, at: now() });
		return rows;
	};

	/**
	 * Count a click on a result of a query.
	 * @param {Site} site
	 * @param {unknown} body `{ q, id? }`
	 * @returns {Promise<{ ok: true, value: { counted: boolean } } | Failure>}
	 */
	const click = async (site, body) => {
		const q = /** @type {any} */ (body)?.q;
		if (typeof q !== 'string' || q.length > site.settings.index.max_query_chars * 4)
			return { ok: false, reason: 'validation_failed', errors: [{ path: '/q', code: 'query_invalid' }] };
		const key = analyticsKey(q);
		if (!key || !site.settings.analytics.track_clicks) return { ok: true, value: { counted: false } };
		await site.repos.queries.click({
			day: dayOf(now(), site.settings.timeZone),
			q: key,
			expireAt: expiryOf(now(), site.settings.analytics.retention_days),
		});
		return { ok: true, value: { counted: true } };
	};

	/**
	 * Analytics report over the last `days` days.
	 * @param {Site} site
	 * @param {{ days?: unknown }} input
	 * @returns {Promise<{ ok: true, value: Record<string, unknown> } | Failure>}
	 */
	const report = async (site, { days }) => {
		const span = intParam(days, 30, 1, site.settings.analytics.retention_days);
		if (span === null) return { ok: false, reason: 'validation_failed', errors: [{ path: '/days', code: 'days_range' }] };
		const from = windowStart(now(), span, site.settings.timeZone);
		const limit = site.settings.analytics.top_limit;
		const [top, zero, daily] = await Promise.all([
			site.repos.queries.totals(from, { limit, sort: 'searches' }),
			site.repos.queries.totals(from, { limit, sort: 'zero' }),
			site.repos.queries.daily(from),
		]);
		const summary = reportOf(
			daily.map((/** @type {any} */ row) => ({ ...row, q: row.day })),
			{ limit: 0 },
		);
		return {
			ok: true,
			value: {
				from,
				days: span,
				totals: summary.totals,
				daily,
				top,
				zeroResults: zero.filter((/** @type {any} */ row) => row.zero > 0),
			},
		};
	};

	return { search, suggest, click, report, forget: (/** @type {string} */ websiteId) => popularCache.delete(websiteId) };
};

/** @typedef {ReturnType<typeof createSearchService>} SearchService */
