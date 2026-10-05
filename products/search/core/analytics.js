/**
 * Search analytics without personal data (pure): queries are counted per website, day and normalised text only —
 * never with a visitor, session, IP address or key — and a query that looks like personal data (an e-mail address, a
 * phone or card number, a link) is not counted at all. Days are calendar days in the website's time zone.
 * @module
 */
import { normalise } from './text.js';

/** Longest query text kept. */
export const MAX_ANALYTICS_QUERY = 100;
const DAY_MS = 86_400_000;

/**
 * True when a query might carry personal data.
 * @param {string} text normalised
 */
export const looksPersonal = (text) =>
	/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text) || /(?:\d[\s().+-]*){7,}/.test(text) || /\b(?:https?:\/\/|www\.)/.test(text);

/**
 * The key a query is counted under, or null when it is not counted.
 * @param {unknown} raw
 * @returns {string | null}
 */
export const analyticsKey = (raw) => {
	const text = normalise(raw).slice(0, MAX_ANALYTICS_QUERY).trim();
	if (text === '' || looksPersonal(text)) return null;
	return text;
};

/**
 * Calendar day (`YYYY-MM-DD`) of an instant in a time zone (UTC when the zone is unknown).
 * @param {number} ms
 * @param {string | null | undefined} timeZone
 */
export const dayOf = (ms, timeZone) => {
	/** @param {string} zone */
	const format = (zone) =>
		new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
	try {
		return format(timeZone || 'UTC');
	} catch {
		return format('UTC');
	}
};

/**
 * The first day of a window of `days` days ending today.
 * @param {number} ms
 * @param {number} days
 * @param {string | null | undefined} timeZone
 */
export const windowStart = (ms, days, timeZone) => dayOf(ms - (Math.max(1, days) - 1) * DAY_MS, timeZone);

/**
 * When a daily count expires (end of the retention window, with one day of margin).
 * @param {number} ms
 * @param {number} retentionDays
 */
export const expiryOf = (ms, retentionDays) => new Date(ms + (Math.max(1, retentionDays) + 1) * DAY_MS);

/**
 * @typedef {{ q: string, searches: number, zero: number, clicks: number, results: number }} QueryRow
 */

/**
 * Report rows: per query totals over a window, sorted by searches (ties by text).
 * @param {Array<{ q: string, searches?: number, zero?: number, clicks?: number, results?: number }>} rows daily rows
 * @param {{ limit: number }} options
 */
export const reportOf = (rows, { limit }) => {
	/** @type {Map<string, QueryRow>} */
	const byQuery = new Map();
	for (const row of rows) {
		const current = byQuery.get(row.q) ?? { q: row.q, searches: 0, zero: 0, clicks: 0, results: 0 };
		byQuery.set(row.q, {
			q: row.q,
			searches: current.searches + (row.searches ?? 0),
			zero: current.zero + (row.zero ?? 0),
			clicks: current.clicks + (row.clicks ?? 0),
			results: Math.max(current.results, row.results ?? 0),
		});
	}
	const all = [...byQuery.values()].sort((a, b) => b.searches - a.searches || a.q.localeCompare(b.q));
	const totals = all.reduce(
		(sum, row) => ({ searches: sum.searches + row.searches, zero: sum.zero + row.zero, clicks: sum.clicks + row.clicks }),
		{ searches: 0, zero: 0, clicks: 0 },
	);
	return {
		totals: {
			...totals,
			zeroRate: totals.searches > 0 ? Math.round((totals.zero / totals.searches) * 1000) / 1000 : 0,
			clickRate: totals.searches > 0 ? Math.round((totals.clicks / totals.searches) * 1000) / 1000 : 0,
		},
		top: all.slice(0, limit),
		zeroResults: all
			.filter((row) => row.zero > 0)
			.sort((a, b) => b.zero - a.zero || a.q.localeCompare(b.q))
			.slice(0, limit),
	};
};
