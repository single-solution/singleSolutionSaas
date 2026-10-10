/**
 * The analytics report (PLAN 0.8.9 Own analytics) from the daily totals: visits and page views per day, top pages,
 * sources, devices and countries, the funnel (view → cart → checkout → purchase) with revenue per currency, site
 * searches and 404s, and Web Vitals (average and the share of good, needs-improvement and poor). Each part is there
 * only while its feature is on. Days are the days of the website's business time zone (business.json `timeZone`, UTC
 * when missing; PLAN 0.8.10 K8), and the report says which zone.
 * @module
 */
import { zonedDay, zonedDayStart } from '@ss/contracts/format';
import { FUNNEL_STEPS } from './widgets.js';
import { VITALS } from './events.js';

/** Rows of each top list. */
const TOP = 10;

/** Most days one report covers. */
const MAX_DAYS = 366;

/** Days a report covers when none are asked for. */
const DEFAULT_DAYS = 30;

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {{ metric: string, key: string, count: number, sum: number }} TotalRow one metric × key over the range
 * @typedef {{ day: string, metric: string, count: number }} DayRow visits or page views of one day
 */

/**
 * The day `count` days after (or before) a day: calendar arithmetic on the `YYYY-MM-DD` label.
 * @param {string} day
 * @param {number} count
 */
const shiftDay = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);

/**
 * True for a real calendar day `YYYY-MM-DD` (not 2026-02-30).
 * @param {string} day
 */
const isDay = (day) => DAY.test(day) && !Number.isNaN(zonedDayStart(day, 'UTC'));

/**
 * The instant a day starts in the business time zone (epoch ms), for showing the day with the website's Format.
 * @param {string} day `YYYY-MM-DD`
 * @param {string | null | undefined} timeZone the business.json time zone (UTC when missing or unknown)
 * @returns {number} NaN for a value that is not a day
 */
export const dayStart = (day, timeZone) => zonedDayStart(day, timeZone);

/**
 * The days a report covers when none are asked for: the last 30 days up to today in the business time zone.
 * @param {number} now
 * @param {string | null | undefined} timeZone the business.json time zone (UTC when missing or unknown)
 */
export const lastDays = (now, timeZone) => {
	const to = zonedDay(now, timeZone);
	return { from: shiftDay(to, -(DEFAULT_DAYS - 1)), to };
};

/**
 * The days a report covers: `from` and `to` (`YYYY-MM-DD`, days of the business time zone, both included), else the
 * last 30 days up to today in that zone.
 * @param {{ from?: unknown, to?: unknown }} query
 * @param {number} now
 * @param {string | null | undefined} timeZone the business.json time zone (UTC when missing or unknown)
 * @returns {{ ok: true, from: string, to: string } | { ok: false, message: string }}
 */
export const rangeOf = (query, now, timeZone) => {
	const to = typeof query.to === 'string' && query.to !== '' ? query.to : zonedDay(now, timeZone);
	if (!isDay(to)) return { ok: false, message: 'from and to are days (YYYY-MM-DD).' };
	const from = typeof query.from === 'string' && query.from !== '' ? query.from : shiftDay(to, -(DEFAULT_DAYS - 1));
	if (!isDay(from)) return { ok: false, message: 'from and to are days (YYYY-MM-DD).' };
	const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
	if (span < 0) return { ok: false, message: 'from must not be after to.' };
	if (span + 1 > MAX_DAYS) return { ok: false, message: `A report covers at most ${MAX_DAYS} days.` };
	return { ok: true, from, to };
};

/**
 * Every day of a range.
 * @param {string} from
 * @param {string} to
 */
export const daysOf = (from, to) => {
	const days = [];
	for (let day = from; day <= to; day = shiftDay(day, 1)) days.push(day);
	return days;
};

/**
 * The top rows of one metric, by count (then key).
 * @param {TotalRow[]} rows
 * @param {string} metric
 */
const top = (rows, metric) =>
	rows
		.filter((row) => row.metric === metric)
		.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
		.slice(0, TOP)
		.map((row) => ({ key: row.key, count: row.count }));

/**
 * @param {TotalRow[]} rows
 * @param {string} metric
 * @param {string} key
 */
const countOf = (rows, metric, key) => rows.find((row) => row.metric === metric && row.key === key)?.count ?? 0;

/**
 * The report.
 * @param {{ from: string, to: string, timeZone: string, on: ReadonlyArray<string>, totals: TotalRow[], days: DayRow[] }} input
 *   `timeZone`: the zone of the days (the business.json time zone, else UTC)
 */
export const buildReport = ({ from, to, timeZone, on, totals, days }) => {
	const series = daysOf(from, to).map((day) => ({
		day,
		visits: days.find((row) => row.day === day && row.metric === 'visits')?.count ?? 0,
		pageViews: days.find((row) => row.day === day && row.metric === 'page_views')?.count ?? 0,
	}));
	return {
		from,
		to,
		timeZone,
		totals: { visits: countOf(totals, 'visits', ''), pageViews: countOf(totals, 'page_views', '') },
		days: series,
		pages: top(totals, 'page'),
		sources: top(totals, 'source'),
		devices: top(totals, 'device'),
		countries: top(totals, 'country'),
		funnel: on.includes('conversion_funnel')
			? {
					steps: FUNNEL_STEPS.map((step) => ({ step, count: countOf(totals, 'funnel', step) })),
					revenue: totals
						.filter((row) => row.metric === 'revenue')
						.sort((a, b) => a.key.localeCompare(b.key))
						.map((row) => ({ currency: row.key, value: row.sum, orders: row.count })),
				}
			: null,
		searches: on.includes('searches_404s') ? top(totals, 'search') : null,
		emptySearches: on.includes('searches_404s') ? top(totals, 'search_empty') : null,
		notFound: on.includes('searches_404s') ? top(totals, 'not_found') : null,
		vitals: on.includes('web_vitals')
			? Object.keys(VITALS).map((name) => {
					const value = totals.find((row) => row.metric === 'vital_value' && row.key === name);
					const count = value?.count ?? 0;
					return {
						name,
						count,
						average: count > 0 ? Math.round((value?.sum ?? 0) / count) : null,
						good: countOf(totals, 'vital', `${name}:good`),
						needsImprovement: countOf(totals, 'vital', `${name}:needs_improvement`),
						poor: countOf(totals, 'vital', `${name}:poor`),
					};
				})
			: null,
	};
};

/** @typedef {ReturnType<typeof buildReport>} Report */
