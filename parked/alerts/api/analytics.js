/**
 * The analytics report of a website (element `analytics`, dashboard overview): aggregation rows from the merchant
 * database folded by the pure `core/analytics.js`.
 */
import { summarize } from '../core/analytics.js';
import { DAY_MS, iso } from '../core/time.js';

/** @typedef {import('./service.js').Site} Site */

/**
 * Analytics of a window.
 * @param {Site} site
 * @param {number} days
 * @param {number} now
 */
export const analyticsOf = async (site, days, now) => {
	const since = iso(now - days * DAY_MS);
	const [subscriptions, messages, signups, sends] = await Promise.all([
		site.repos.subscriptions.statsSince(since),
		site.repos.messages.statsSince(since),
		site.repos.subscriptions.dailySince(since),
		site.repos.messages.dailySentSince(since),
	]);
	/** @type {Map<string, { day: string, subscribed: number, sent: number }>} */
	const daily = new Map();
	for (const row of signups) daily.set(row.day, { day: row.day, subscribed: row.count, sent: 0 });
	for (const row of sends)
		daily.set(row.day, { day: row.day, subscribed: daily.get(row.day)?.subscribed ?? 0, sent: row.count });
	const list = Array.from({ length: days }, (_, index) => iso(now - (days - 1 - index) * DAY_MS).slice(0, 10));
	return summarize({ from: since, to: iso(now), subscriptions, messages, daily: [...daily.values()], days: list });
};
