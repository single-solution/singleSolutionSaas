/**
 * Analytics (pure): the merchant database aggregates reviews per local day (website time zone), this module rolls the
 * days up into day / week / month buckets, fills gaps with zeros and derives averages and rates. Ratings given on
 * other scales are normalised to the current one.
 * @module
 */
import { round1 } from './ratings.js';
import { bucketKey, bucketKeys, DAY_MS } from './time.js';

/**
 * @typedef {object} DayRow one aggregate row from the database
 * @property {string} day local `YYYY-MM-DD`
 * @property {'pending' | 'approved' | 'rejected'} status
 * @property {number} count
 * @property {number} normalisedSum sum of rating / scale (0..1 each)
 * @property {number} withPhotos
 * @property {number} verified
 * @property {number} replied
 */

/** @param {number} n @param {number} d */
const rate = (n, d) => (d > 0 ? Math.round((1000 * n) / d) / 1000 : 0);

/**
 * Bucket of a local day key (`YYYY-MM-DD`).
 * @param {string} day
 * @param {import('./time.js').Bucket} bucket
 */
const bucketOfDay = (day, bucket) => bucketKey(Date.parse(`${day}T12:00:00Z`), bucket, 'UTC');

/**
 * @param {{ rows: readonly DayRow[], from: number, to: number, bucket: import('./time.js').Bucket, timeZone: string,
 *   scale: number, requests?: { created: number, converted: number }, timing?: { decisionHours: number | null,
 *   replyHours: number | null }, topItems?: ReadonlyArray<{ itemId: string, count: number, normalisedSum: number }> }} input
 */
export const assembleAnalytics = ({ rows, from, to, bucket, timeZone, scale, requests, timing, topItems = [] }) => {
	const keys = bucketKeys(from, to, bucket, timeZone);
	/** @type {Map<string, { submitted: number, approved: number, approvedSum: number }>} */
	const series = new Map(keys.map((key) => [key, { submitted: 0, approved: 0, approvedSum: 0 }]));
	const totals = { submitted: 0, approved: 0, pending: 0, rejected: 0, verified: 0, withPhotos: 0, replied: 0, approvedSum: 0 };
	for (const row of rows) {
		const key = bucketOfDay(row.day, bucket);
		const point = series.get(key) ?? { submitted: 0, approved: 0, approvedSum: 0 };
		point.submitted += row.count;
		totals.submitted += row.count;
		totals[row.status] += row.count;
		totals.verified += row.verified;
		totals.withPhotos += row.withPhotos;
		if (row.status === 'approved') {
			point.approved += row.count;
			point.approvedSum += row.normalisedSum;
			totals.approvedSum += row.normalisedSum;
			totals.replied += row.replied;
		}
		series.set(key, point);
	}
	const average = (/** @type {number} */ sum, /** @type {number} */ count) => (count > 0 ? round1((sum / count) * scale) : null);
	return {
		from: new Date(from).toISOString(),
		to: new Date(to).toISOString(),
		bucket,
		timeZone,
		scale,
		totals: {
			submitted: totals.submitted,
			approved: totals.approved,
			pending: totals.pending,
			rejected: totals.rejected,
			averageRating: average(totals.approvedSum, totals.approved),
			verifiedShare: rate(totals.verified, totals.submitted),
			photoShare: rate(totals.withPhotos, totals.submitted),
			replyRate: rate(totals.replied, totals.approved),
			approvalRate: rate(totals.approved, totals.approved + totals.rejected),
		},
		series: [...series.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, point]) => ({
				key,
				submitted: point.submitted,
				approved: point.approved,
				averageRating: average(point.approvedSum, point.approved),
			})),
		requests: requests
			? { created: requests.created, converted: requests.converted, conversion: rate(requests.converted, requests.created) }
			: null,
		timing: timing ?? { decisionHours: null, replyHours: null },
		topItems: topItems.map((item) => ({
			itemId: item.itemId,
			count: item.count,
			averageRating: average(item.normalisedSum, item.count),
		})),
	};
};

/**
 * Resolve the analytics range from query values and the element's limits.
 * @param {{ from?: unknown, to?: unknown, bucket?: unknown }} query
 * @param {{ now: number, defaultDays: number, maxDays: number, defaultBucket: import('./time.js').Bucket }} limits
 * @returns {{ ok: true, from: number, to: number, bucket: import('./time.js').Bucket } | { ok: false, path: string, code: string }}
 */
export const analyticsRange = (query, { now, defaultDays, maxDays, defaultBucket }) => {
	const to = query.to === undefined ? now : Date.parse(String(query.to));
	if (!Number.isFinite(to)) return { ok: false, path: '/to', code: 'date_invalid' };
	const from = query.from === undefined ? to - defaultDays * DAY_MS : Date.parse(String(query.from));
	if (!Number.isFinite(from) || from > to) return { ok: false, path: '/from', code: 'date_invalid' };
	if (to - from > maxDays * DAY_MS) return { ok: false, path: '/from', code: 'range_too_long' };
	const bucket = query.bucket === undefined ? defaultBucket : query.bucket;
	if (bucket !== 'day' && bucket !== 'week' && bucket !== 'month') return { ok: false, path: '/bucket', code: 'bucket_invalid' };
	return { ok: true, from, to, bucket };
};
