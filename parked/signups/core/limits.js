/**
 * Fixed-window limits (pure). Counters live in the merchant database and are incremented atomically by the adapters;
 * this module names the windows and turns a counter value into a decision. Send limits follow the ibrahimMobiles order:
 * cooldown first (so a customer hammering "resend" does not burn the hourly budget), then the per-identity hourly cap,
 * the per-IP cap and finally the website-wide cap that bounds gateway spend even when numbers and IPs rotate.
 * @module
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Start of the fixed window that contains `now`.
 * @param {number} now
 * @param {number} windowMs
 */
export const windowStart = (now, windowMs) => Math.floor(now / windowMs) * windowMs;

/**
 * Seconds until a window ends (at least 1).
 * @param {number} start window start
 * @param {number} windowMs
 * @param {number} now
 */
export const secondsUntil = (start, windowMs, now) => Math.max(1, Math.ceil((start + windowMs - now) / 1000));

/**
 * @typedef {{ key: string, max: number, windowMs: number, code: string }} LimitSpec
 * A counter: `key` (already hashed — never a raw identifier or IP), `max` per window (0 = unlimited), the problem
 * code returned when it is exceeded.
 */

/**
 * The limits of one delivery (OTP or magic link), in evaluation order.
 * @param {{ identityKey: string, ipKey: string | null, prefix: string,
 *   perIdentityHour: number, perIpHour: number, globalHour: number }} input
 * @returns {LimitSpec[]}
 */
export const sendLimits = ({ identityKey, ipKey, prefix, perIdentityHour, perIpHour, globalHour }) => [
	{ key: `${prefix}:id:${identityKey}`, max: perIdentityHour, windowMs: HOUR_MS, code: 'send_limit' },
	...(ipKey ? [{ key: `${prefix}:ip:${ipKey}`, max: perIpHour, windowMs: HOUR_MS, code: 'send_limit' }] : []),
	{ key: `${prefix}:all`, max: globalHour, windowMs: HOUR_MS, code: 'send_limit' },
];

/**
 * Decision for a counter value after it was incremented.
 * @param {{ count: number, max: number, start: number, windowMs: number, now: number }} input
 * @returns {{ ok: true } | { ok: false, retryAfter: number }}
 */
export const counterDecision = ({ count, max, start, windowMs, now }) =>
	max <= 0 || count <= max ? { ok: true } : { ok: false, retryAfter: secondsUntil(start, windowMs, now) };

/**
 * Seconds left of a cooldown that ends at `until` (0 = none).
 * @param {number} until epoch ms
 * @param {number} now
 */
export const cooldownLeft = (until, now) => (until > now ? Math.ceil((until - now) / 1000) : 0);
