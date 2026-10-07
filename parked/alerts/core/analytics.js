/**
 * Analytics (pure): folds the aggregation rows of the merchant database into the report `GET /v1/analytics` returns —
 * subscriptions by type and status, messages by channel and status, alerts delivered, unsubscribe rate and a daily
 * series. Rates are integer basis points (1 % = 100) so the report never carries floating-point noise.
 * @module
 */

/** @typedef {{ type: string, status: string, count: number }} SubscriptionRow */
/** @typedef {{ channel: string, status: string, count: number, alerts: number }} MessageRow */
/** @typedef {{ day: string, subscribed: number, sent: number }} DailyRow */

/**
 * @param {number} part
 * @param {number} whole
 */
const bps = (part, whole) => (whole > 0 ? Math.round((part * 10_000) / whole) : 0);

/**
 * @param {{ from: string, to: string, subscriptions: readonly SubscriptionRow[], messages: readonly MessageRow[],
 *   daily: readonly DailyRow[], days: readonly string[] }} input `days`: every day of the window (gaps become zeros)
 */
export const summarize = ({ from, to, subscriptions, messages, daily, days }) => {
	/** @type {Record<string, Record<string, number>>} */
	const byType = {};
	/** @type {Record<string, number>} */
	const byStatus = {};
	let total = 0;
	for (const row of subscriptions) {
		(byType[row.type] ??= {})[row.status] = (byType[row.type]?.[row.status] ?? 0) + row.count;
		byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
		total += row.count;
	}
	/** @type {Record<string, Record<string, number>>} */
	const byChannel = {};
	let sent = 0;
	let failed = 0;
	let alertsDelivered = 0;
	for (const row of messages) {
		(byChannel[row.channel] ??= {})[row.status] = (byChannel[row.channel]?.[row.status] ?? 0) + row.count;
		if (row.status === 'sent') {
			sent += row.count;
			alertsDelivered += row.alerts;
		}
		if (row.status === 'failed') failed += row.count;
	}
	const unsubscribed = byStatus.unsubscribed ?? 0;
	const notified = byStatus.notified ?? 0;
	const series = new Map(daily.map((row) => [row.day, row]));
	return {
		window: { from, to },
		subscriptions: { total, byStatus, byType },
		messages: { sent, failed, byChannel, alertsDelivered },
		rates: {
			notifiedBps: bps(notified, total),
			unsubscribedBps: bps(unsubscribed, total),
			deliveryBps: bps(sent, sent + failed),
		},
		daily: days.map((day) => ({ day, subscribed: series.get(day)?.subscribed ?? 0, sent: series.get(day)?.sent ?? 0 })),
	};
};
