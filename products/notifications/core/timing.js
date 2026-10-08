/**
 * Timing (PLAN 0.8.5): retries on the next uses, quiet hours, send limits and delayed send. Nothing runs on a timer:
 * a waiting message gets a due time and is sent on the first use of the website after it. No I/O.
 * @module
 */

/** Attempts on one channel before the message fails there (then the fallback channel, if any). */
const MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and 3 (judged on the next use after it). */
const RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000]);
/** Attempts to deliver one outgoing webhook event. */
export const MAX_WEBHOOK_ATTEMPTS = 5;
/** Wait before webhook attempts 2–5. */
export const WEBHOOK_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]);
/** A claimed message stays claimed this long (a crashed request releases it after that). */
export const LEASE_MS = 60_000;
/** Messages and webhook events sent right after one use, at most. */
export const DRAIN_BATCH = 5;

/**
 * When the next attempt is due after `attempts` failed attempts, or null when no attempt is left.
 * @param {number} attempts failed attempts so far on this channel
 * @param {number} now
 * @param {{ max?: number, delays?: ReadonlyArray<number> }} [policy]
 * @returns {number | null}
 */
export const nextAttemptAt = (attempts, now, { max = MAX_ATTEMPTS, delays = RETRY_DELAYS_MS } = {}) => {
	if (attempts >= max) return null;
	return now + (delays[Math.min(attempts - 1, delays.length - 1)] ?? 0);
};

/**
 * The local hour and minute at an instant in a time zone.
 * @param {number} at epoch ms
 * @param {string} timeZone IANA
 */
export const localTime = (at, timeZone) => {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(at));
	/** @param {string} type */
	const part = (type) => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
	return { hour: part('hour'), minute: part('minute') };
};

/**
 * Whether a local hour is inside the quiet window `[startHour, endHour)`, which may pass midnight. Equal hours mean no
 * quiet hours.
 * @param {number} hour
 * @param {{ startHour: number, endHour: number }} quiet
 */
export const isQuietHour = (hour, { startHour, endHour }) => {
	if (startHour === endHour) return false;
	return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
};

/**
 * When a non-urgent message may be sent: now, or the end of the quiet window in the recipient's time zone (their
 * morning).
 * @param {number} now
 * @param {{ startHour: number, endHour: number }} quiet
 * @param {string} timeZone
 * @returns {number}
 */
export const quietUntil = (now, quiet, timeZone) => {
	const { hour, minute } = localTime(now, timeZone);
	if (!isQuietHour(hour, quiet)) return now;
	const minutesNow = hour * 60 + minute;
	const wait = (((quiet.endHour * 60 - minutesNow) % 1440) + 1440) % 1440;
	return Math.floor(now / 60_000) * 60_000 + wait * 60_000;
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
