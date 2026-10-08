/**
 * Reports (pure, PLAN 0.8.3): for a date range in the business.json time zone (default the last 30 days):
 * conversations per day, visitor messages, conversations answered only by the AI vs handed to a person, the median
 * first staff reply time, resolved conversations, the average rating and number of ratings, leads and AI tokens. The
 * numbers are read from the merchant database; there is no topic grouping.
 * @module
 */
import { dayKey } from './time.js';

/** Longest report range (days). */
export const MAX_REPORT_DAYS = 366;
/** The default range (days, today included). */
export const DEFAULT_REPORT_DAYS = 30;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The range asked for, else the last 30 days; null when it is not a valid range.
 * @param {{ from?: unknown, to?: unknown }} query
 * @param {number} now
 * @param {string} timeZone
 * @returns {{ from: string, to: string, dates: string[] } | null}
 */
export const reportRange = (query, now, timeZone) => {
	const today = dayKey(now, timeZone);
	const to = typeof query.to === 'string' ? query.to : today;
	const from =
		typeof query.from === 'string'
			? query.from
			: new Date(Date.parse(`${to}T00:00:00Z`) - (DEFAULT_REPORT_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
	if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to)
		return null;
	/** @type {string[]} */
	const dates = [];
	for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
		dates.push(new Date(t).toISOString().slice(0, 10));
		if (dates.length > MAX_REPORT_DAYS) return null;
	}
	return { from, to, dates };
};

/**
 * @typedef {object} ReportRow one conversation started in the range
 * @property {Date} createdAt
 * @property {number} visitorMessages
 * @property {number} aiReplies
 * @property {boolean} staffReplied
 * @property {Date | null} handedOffAt
 * @property {Date | null} firstVisitorAt
 * @property {Date | null} firstStaffReplyAt
 * @property {string} status
 * @property {{ score: number } | null} rating
 */

/** @param {number[]} values */
const median = (values) => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const upper = Number(sorted[mid]);
	return sorted.length % 2 === 1 ? upper : (Number(sorted[mid - 1]) + upper) / 2;
};

/**
 * @param {{ rows: ReportRow[], dates: string[], timeZone: string, leads: number, aiTokens: number }} input
 */
export const summarise = ({ rows, dates, timeZone, leads, aiTokens }) => {
	/** @type {Map<string, number>} */
	const perDay = new Map(dates.map((date) => [date, 0]));
	for (const row of rows) {
		const date = dayKey(new Date(row.createdAt).getTime(), timeZone);
		if (perDay.has(date)) perDay.set(date, /** @type {number} */ (perDay.get(date)) + 1);
	}
	const replyTimes = rows
		.filter((row) => row.firstStaffReplyAt && row.firstVisitorAt)
		.map((row) =>
			Math.max(
				0,
				(new Date(/** @type {Date} */ (row.firstStaffReplyAt)).getTime() -
					new Date(/** @type {Date} */ (row.firstVisitorAt)).getTime()) /
					1000,
			),
		);
	const rated = rows.filter((row) => row.rating !== null);
	const medianReply = median(replyTimes);
	return {
		days: [...perDay].map(([date, conversations]) => ({ date, conversations })),
		conversations: rows.length,
		visitorMessages: rows.reduce((sum, row) => sum + row.visitorMessages, 0),
		aiOnly: rows.filter((row) => row.aiReplies > 0 && !row.staffReplied && !row.handedOffAt).length,
		handedOff: rows.filter((row) => row.handedOffAt !== null).length,
		medianFirstReplySeconds: medianReply === null ? null : Math.round(medianReply),
		resolved: rows.filter((row) => row.status === 'resolved').length,
		rating: {
			average:
				rated.length === 0
					? null
					: Math.round(
							(rated.reduce((sum, row) => sum + /** @type {{ score: number }} */ (row.rating).score, 0) / rated.length) *
								100,
						) / 100,
			count: rated.length,
		},
		leads,
		aiTokens,
	};
};
