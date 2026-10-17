/**
 * Timing (PLAN 0.8.5): retries on the next uses (the waits are fixed, `core/limits.js`; PLAN 0.8.10 N3), quiet hours per
 * weekday and channel, send limits and delayed send. Nothing runs on a timer:
 * a waiting message gets a due time and is sent on the first use of the website after it. Quiet hours are a wall-clock
 * rule in the recipient's time zone, else the business.json time zone (UTC when missing; PLAN 0.8.10 K8); send limits
 * and the delayed-send horizon are rolling spans of time, not calendar days. No I/O.
 * @module
 */
import { zonedParts } from '@ss/contracts/format';

/** @typedef {import('./channels.js').Channel} Channel */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A claimed message stays claimed this long (a crashed request releases it after that). */
export const LEASE_MS = 60_000;
/** Messages and webhook events sent right after one use, at most. */
export const DRAIN_BATCH = 5;

/**
 * When the next attempt is due after `attempts` failed attempts, or null when no attempt is left (the attempts are
 * one more than the waits).
 * @param {number} attempts failed attempts so far on this channel
 * @param {number} now
 * @param {ReadonlyArray<number>} delays the waits before attempts 2, 3, … (ms)
 * @returns {number | null}
 */
export const nextAttemptAt = (attempts, now, delays) => {
	if (attempts < 1 || attempts > delays.length) return null;
	return now + /** @type {number} */ (delays[attempts - 1]);
};

/**
 * A quiet window (fixed-choices N6): on the weekdays it starts (0 = Sunday … 6 = Saturday), from a local time until a
 * local time (`HH:MM`; `until` at or before `from` passes midnight into the next day), for some channels (none: every
 * channel). The same `from` and `until` is no quiet time.
 * @typedef {{ days: ReadonlyArray<number>, from: string, until: string, channels: ReadonlyArray<Channel> }} QuietWindow
 */

/** Today's quiet hours, the list's default: every day from 21:00 until 08:00, on every channel. */
export const DEFAULT_QUIET_HOURS = Object.freeze([
	Object.freeze({ days: Object.freeze([0, 1, 2, 3, 4, 5, 6]), from: '21:00', until: '08:00', channels: Object.freeze([]) }),
]);

/** @param {string} time `HH:MM` @returns {number} minutes after midnight */
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * The end of the quiet windows that hold a message at an instant, or null when none does.
 * @param {number} at
 * @param {ReadonlyArray<QuietWindow>} windows
 * @param {string | null | undefined} timeZone
 * @param {Channel} channel
 * @returns {number | null}
 */
const quietEndAt = (at, windows, timeZone, channel) => {
	const { hour, minute, weekday } = zonedParts(at, timeZone);
	const nowMinutes = hour * 60 + minute;
	const start = Math.floor(at / MINUTE) * MINUTE;
	/** @type {number | null} */
	let end = null;
	for (const span of windows) {
		if (span.channels.length > 0 && !span.channels.includes(channel)) continue;
		const from = minutesOf(span.from);
		const until = minutesOf(span.until);
		if (from === until) continue;
		/** @type {number | null} minutes left in this span */
		let left = null;
		if (from < until) {
			if (span.days.includes(weekday) && nowMinutes >= from && nowMinutes < until) left = until - nowMinutes;
		} else if (span.days.includes(weekday) && nowMinutes >= from) left = 1440 - nowMinutes + until;
		else if (span.days.includes((weekday + 6) % 7) && nowMinutes < until) left = until - nowMinutes;
		if (left !== null) end = Math.max(end ?? 0, start + left * MINUTE);
	}
	return end;
};

/**
 * When a non-urgent message may be sent: `at`, or the end of the quiet windows of its channel in the recipient's time
 * zone, else the business time zone (UTC when missing or unknown). Windows that follow one another are passed in turn,
 * within eight days.
 * @param {number} at
 * @param {ReadonlyArray<QuietWindow>} windows
 * @param {string | null | undefined} timeZone
 * @param {Channel} channel
 * @returns {number}
 */
export const quietUntil = (at, windows, timeZone, channel) => {
	let t = at;
	for (let step = 0; step <= windows.length * 8; step += 1) {
		const end = quietEndAt(t, windows, timeZone, channel);
		if (end === null || end <= t) return t;
		t = end;
		if (t - at > 8 * 24 * HOUR) return t;
	}
	return t;
};

/**
 * Whether one more message to a recipient stays within the send limits.
 * @param {{ lastHour: number, lastDay: number }} sent messages sent to the recipient in the last hour and day
 * @param {{ perHour: number, perDay: number }} limits
 */
export const withinLimits = (sent, limits) => sent.lastHour < limits.perHour && sent.lastDay < limits.perDay;

/**
 * Check a delayed send's time: an ISO-8601 time no later than `maxDays` from now. A time in the past sends now.
 * @param {unknown} value
 * @param {number} now
 * @param {number} maxDays
 * @returns {{ ok: true, at: number } | { ok: false }}
 */
export const checkSendAt = (value, now, maxDays) => {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value))
		return { ok: false };
	const at = Date.parse(value);
	if (!Number.isFinite(at) || at > now + maxDays * 86_400_000) return { ok: false };
	return { ok: true, at: Math.max(at, now) };
};
