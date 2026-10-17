/**
 * The analytics report (PLAN 0.8.9 Own analytics) from the daily totals: visits and page views per day, top pages,
 * sources, devices and countries, the merchant's goals and funnels (G1: each step an event or a page, counted per day;
 * the shop funnel view → cart → checkout → purchase to start with) with revenue per currency, site
 * searches and 404s, and Web Vitals (average and the share of good, needs-improvement and poor). Each part is there
 * only while its feature is on. Days are the days of the website's business time zone (business `timeZone`, UTC
 * when missing; PLAN 0.8.10 K8), and the report says which zone.
 *
 * With the `detail` setting `sessions` (PLAN 0.8.10 G3) it adds sessions, bounce (sessions that saw one page), their
 * average duration (time between their first and last page) and pages, browsers, systems and cities, Web Vitals per
 * page and 404 referrers from the daily totals, and live visitors (sessions seen in the last 5 minutes) and the latest
 * journeys from the raw events, judged when it is read.
 * @module
 */
import { zonedDay, zonedDayStart } from '@ss/contracts/format';
import { VITALS } from './events.js';

/** Rows of each top list, unless the request asks for more (`top`, at most {@link MAX_TOP}). */
const TOP = 10;
/** Most rows of a top list. */
const MAX_TOP = 100;
/** Sessions seen this recently are live visitors (G3). */
export const LIVE_MS = 5 * 60_000;
/** Latest journeys in a report (G3). */
export const JOURNEYS = 20;

/** Most days one report covers. */
const MAX_DAYS = 366;

/** Days a report covers when none are asked for. */
const DEFAULT_DAYS = 30;

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One session's journey (G3): when it started and ended, its first steps and where it came from.
 * @typedef {{ session: string, startedAt: string, endedAt: string, duration: number, events: number, pages: number,
 *   device: string | null, browser: string | null, os: string | null, country: string | null, city: string | null,
 *   source: string | null, steps: Array<{ type: string, path: string, at: string, term?: string, value?: number,
 *   currency?: string | null }> }} Journey
 */

/**
 * @typedef {{ metric: string, key: string, count: number, sum: number }} TotalRow one metric × key over the range
 * @typedef {{ day: string, metric: string, count: number }} DayRow visits or page views of one day
 */

/**
 * The day `count` days after (or before) a day: calendar arithmetic on the `YYYY-MM-DD` label.
 * @param {string} day
 * @param {number} count
 */
export const shiftDay = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);

/**
 * True for a real calendar day `YYYY-MM-DD` (not 2026-02-30).
 * @param {unknown} day
 * @returns {day is string}
 */
export const isDay = (day) => typeof day === 'string' && DAY.test(day) && !Number.isNaN(zonedDayStart(day, 'UTC'));

/**
 * The instant a day starts in the business time zone (epoch ms), for showing the day with the website's Format.
 * @param {string} day `YYYY-MM-DD`
 * @param {string | null | undefined} timeZone the business time zone (UTC when missing or unknown)
 * @returns {number} NaN for a value that is not a day
 */
export const dayStart = (day, timeZone) => zonedDayStart(day, timeZone);

/** The range presets of the analytics dashboard. */
export const PRESETS = Object.freeze(['today', '7d', '30d', '90d', 'month', 'lastMonth', '12m']);

/**
 * The days of a range preset, up to today in the business time zone: today, the last 7, 30 or 90 days, this month,
 * last month, or the last 12 months (365 days).
 * @param {string} preset one of {@link PRESETS}
 * @param {number} now
 * @param {string | null | undefined} timeZone
 * @returns {{ from: string, to: string }}
 */
export const presetRange = (preset, now, timeZone) => {
	const today = zonedDay(now, timeZone);
	const monthStart = `${today.slice(0, 8)}01`;
	if (preset === 'today') return { from: today, to: today };
	if (preset === 'month') return { from: monthStart, to: today };
	if (preset === 'lastMonth') {
		const to = shiftDay(monthStart, -1);
		return { from: `${to.slice(0, 8)}01`, to };
	}
	const days = { '7d': 7, '90d': 90, '12m': 365 }[preset] ?? DEFAULT_DAYS;
	return { from: shiftDay(today, -(days - 1)), to: today };
};

/**
 * The days a report covers: `from` and `to` (`YYYY-MM-DD`, days of the business time zone, both included), else the
 * last 30 days up to today in that zone.
 * @param {{ from?: unknown, to?: unknown }} query
 * @param {number} now
 * @param {string | null | undefined} timeZone the business time zone (UTC when missing or unknown)
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
 * How many rows each top list has: the request's `top` (1–100), else 10.
 * @param {unknown} value
 */
export const topOf = (value) => {
	const n = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : NaN;
	return n >= 1 && n <= MAX_TOP ? n : TOP;
};

/**
 * The top rows of one metric, by count (then key).
 * @param {TotalRow[]} rows
 * @param {string} metric
 * @param {number} [size]
 */
const top = (rows, metric, size = TOP) =>
	rows
		.filter((row) => row.metric === metric)
		.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
		.slice(0, size)
		.map((row) => ({ key: row.key, count: row.count }));

/**
 * Web Vitals per page (G3): each page's average of each vital, the slowest largest paint first.
 * @param {TotalRow[]} rows
 * @param {number} size
 */
const vitalPagesOf = (rows, size) => {
	/** @type {Map<string, { path: string, samples: number, averages: Record<string, number | null> }>} */
	const pages = new Map();
	for (const row of rows.filter((entry) => entry.metric === 'vital_page')) {
		const cut = row.key.lastIndexOf('\n');
		const path = row.key.slice(0, cut);
		const name = row.key.slice(cut + 1);
		const page = pages.get(path) ?? {
			path,
			samples: 0,
			averages: Object.fromEntries(Object.keys(VITALS).map((key) => [key, null])),
		};
		page.samples += row.count;
		if (Object.hasOwn(VITALS, name) && row.count > 0) page.averages[name] = Math.round(row.sum / row.count);
		pages.set(path, page);
	}
	return [...pages.values()]
		.sort((a, b) => (b.averages.LCP ?? -1) - (a.averages.LCP ?? -1) || b.samples - a.samples || a.path.localeCompare(b.path))
		.slice(0, size);
};

/**
 * 404 referrers (G3): the missing page and where its visitors came from (a path on the website, another site, or
 * direct), most first.
 * @param {TotalRow[]} rows
 * @param {number} size
 */
const notFoundFromOf = (rows, size) =>
	top(rows, 'not_found_from', size).map((row) => {
		const cut = row.key.lastIndexOf('\n');
		return { path: row.key.slice(0, cut), from: row.key.slice(cut + 1), count: row.count };
	});

/**
 * @param {TotalRow[]} rows
 * @param {string} metric
 * @param {string} key
 */
const countOf = (rows, metric, key) => rows.find((row) => row.metric === metric && row.key === key)?.count ?? 0;

/**
 * The session figures of a range (G3): sessions, bounces and the bounce rate (percent, one decimal), the average
 * duration (seconds) and pages per session (one decimal).
 * @param {TotalRow[]} totals
 */
const sessionsOf = (totals) => {
	const count = countOf(totals, 'sessions', '');
	const bounces = Math.max(0, count - countOf(totals, 'engaged', ''));
	const duration = totals.find((row) => row.metric === 'duration' && row.key === '')?.sum ?? 0;
	return {
		count,
		bounces,
		bounceRate: count > 0 ? Math.round((bounces / count) * 1000) / 10 : null,
		averageDuration: count > 0 ? Math.round(duration / count / 1000) : null,
		pagesPerSession: count > 0 ? Math.round((countOf(totals, 'session_pages', '') / count) * 10) / 10 : null,
	};
};

/**
 * The report.
 * @param {{ from: string, to: string, timeZone: string, on: ReadonlyArray<string>, totals: TotalRow[], days: DayRow[],
 *   top?: number, detail?: 'anonymous' | 'sessions',
 *   live?: { visitors: number, pages: Array<{ key: string, count: number }> } | null,
 *   journeys?: Journey[] | null, goals?: ReadonlyArray<{ key: string, name: string, kind: string, match: string }>,
 *   funnels?: ReadonlyArray<{ key: string, name: string, steps: ReadonlyArray<{ name: string, kind: string, match: string }> }> }} input
 *   `timeZone`: the zone of the days (the business time zone, else UTC); `top`: rows of each top list; `detail`:
 *   the `visitor_analytics` setting; `live` and `journeys`: read from the raw events with `sessions`; `goals` and
 *   `funnels`: the merchant's lists (G1)
 */
export const buildReport = ({
	from,
	to,
	timeZone,
	on,
	totals,
	days,
	top: size = TOP,
	detail = 'anonymous',
	live = null,
	journeys = null,
	goals = [],
	funnels = [],
}) => {
	/** How many times an event happened, or a page pattern was viewed (G1). @param {{ kind: string, match: string }} entry */
	const countOfMatch = (entry) => countOf(totals, entry.kind === 'page' ? 'page_match' : 'event', entry.match);
	const counting = on.includes('conversion_funnel');
	const sessions = detail === 'sessions';
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
		detail,
		pages: top(totals, 'page', size),
		sources: top(totals, 'source', size),
		devices: top(totals, 'device', size),
		countries: top(totals, 'country', size),
		sessions: sessions ? sessionsOf(totals) : null,
		browsers: sessions ? top(totals, 'browser', size) : null,
		systems: sessions ? top(totals, 'os', size) : null,
		cities: sessions ? top(totals, 'city', size) : null,
		live: sessions ? (live ?? { visitors: 0, pages: [] }) : null,
		journeys: sessions ? (journeys ?? []) : null,
		goals: counting
			? goals.map((goal) => ({
					key: goal.key,
					name: goal.name,
					kind: goal.kind,
					match: goal.match,
					count: countOfMatch(goal),
				}))
			: null,
		funnels: counting
			? funnels.map((funnel) => ({
					key: funnel.key,
					name: funnel.name,
					steps: funnel.steps.map((step) => ({
						name: step.name,
						kind: step.kind,
						match: step.match,
						count: countOfMatch(step),
					})),
				}))
			: null,
		revenue: counting
			? totals
					.filter((row) => row.metric === 'revenue')
					.sort((a, b) => a.key.localeCompare(b.key))
					.map((row) => ({ currency: row.key, value: row.sum, orders: row.count }))
			: null,
		searches: on.includes('searches_404s') ? top(totals, 'search', size) : null,
		emptySearches: on.includes('searches_404s') ? top(totals, 'search_empty', size) : null,
		notFound: on.includes('searches_404s') ? top(totals, 'not_found', size) : null,
		notFoundFrom: sessions && on.includes('searches_404s') ? notFoundFromOf(totals, size) : null,
		vitalPages: sessions && on.includes('web_vitals') ? vitalPagesOf(totals, size) : null,
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
