/**
 * Customer sessions (pure). A session is one signed-in device: an absolute lifetime (`refresh_ttl_days`), an optional
 * idle timeout renewed by each refresh (`idle_timeout_days`, sliding renewal), a rotating refresh token and the
 * customer's session version (revoke-all bumps it, which also invalidates every access token on this product's own
 * routes at once — other products see it when the short-lived access token expires).
 *
 * Refresh-token reuse: every refresh replaces the stored hash and keeps the previous hashes. Presenting a previous
 * token means it was copied — the whole session is revoked (`reuse_detected`) — unless it happens within the grace
 * window right after a rotation, which is two tabs racing (answered `refresh_conflict`, nothing revoked).
 * @module
 */
import { DAY_MS } from './limits.js';

/** Previous refresh-token hashes kept per session for reuse detection. */
export const PREVIOUS_HASHES = 20;

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {string} customerId
 * @property {string} createdAt
 * @property {string} lastUsedAt
 * @property {string} expiresAt absolute end
 * @property {string | null} idleExpiresAt end of the idle window (null = no idle timeout)
 * @property {string | null} revokedAt
 * @property {string | null} [revokeReason]
 * @property {string} [rotatedAt] last refresh-token rotation
 * @property {string} method
 * @property {{ label: string, browser: string, os: string }} device
 * @property {string | null} [deviceHash]
 */

/**
 * Lifetime of a new session or after a refresh.
 * @param {{ createdAt: number, now: number, refreshTtlDays: number, idleTimeoutDays: number, sliding: boolean,
 *   previousIdle?: string | null }} input
 * @returns {{ expiresAt: string, idleExpiresAt: string | null }}
 */
export const sessionWindow = ({ createdAt, now, refreshTtlDays, idleTimeoutDays, sliding, previousIdle = null }) => {
	const expires = createdAt + refreshTtlDays * DAY_MS;
	if (idleTimeoutDays <= 0) return { expiresAt: new Date(expires).toISOString(), idleExpiresAt: null };
	const renewed = sliding || previousIdle === null ? now + idleTimeoutDays * DAY_MS : Date.parse(previousIdle);
	return { expiresAt: new Date(expires).toISOString(), idleExpiresAt: new Date(Math.min(renewed, expires)).toISOString() };
};

/**
 * Whether a session can still be used.
 * @param {Pick<Session, 'expiresAt' | 'idleExpiresAt' | 'revokedAt'>} session
 * @param {number} now
 * @returns {'active' | 'revoked' | 'expired' | 'idle'}
 */
export const sessionState = (session, now) => {
	if (session.revokedAt) return 'revoked';
	if (Date.parse(session.expiresAt) <= now) return 'expired';
	if (session.idleExpiresAt && Date.parse(session.idleExpiresAt) <= now) return 'idle';
	return 'active';
};

/**
 * What presenting an already-rotated refresh token means.
 * @param {{ rotatedAt?: string | null, now: number, graceSeconds: number, reuseDetection: boolean }} input
 * @returns {'conflict' | 'reuse' | 'invalid'}
 */
export const reuseDecision = ({ rotatedAt, now, graceSeconds, reuseDetection }) => {
	if (rotatedAt && now - Date.parse(rotatedAt) < graceSeconds * 1000) return 'conflict';
	return reuseDetection ? 'reuse' : 'invalid';
};

/**
 * Sessions to revoke so a customer keeps at most `max` (oldest last use first). The new session is not in the list.
 * @param {ReadonlyArray<Pick<Session, 'id' | 'lastUsedAt'>>} active
 * @param {number} max
 * @returns {string[]}
 */
export const sessionsOverLimit = (active, max) => {
	if (max <= 0 || active.length < max) return [];
	return [...active]
		.sort((a, b) => Date.parse(a.lastUsedAt) - Date.parse(b.lastUsedAt) || a.id.localeCompare(b.id))
		.slice(0, active.length - max + 1)
		.map((session) => session.id);
};

const BROWSERS = /** @type {const} */ ([
	['Edge', /\bEdg(?:e|A|iOS)?\//],
	['Opera', /\bOPR\/|\bOpera\b/],
	['Samsung Internet', /\bSamsungBrowser\//],
	['Firefox', /\bFirefox\/|\bFxiOS\//],
	['Chrome', /\bChrome\/|\bCriOS\//],
	['Safari', /\bSafari\//],
]);
const SYSTEMS = /** @type {const} */ ([
	['iOS', /\biPhone|\biPad|\biPod/],
	['Android', /\bAndroid\b/],
	['Windows', /\bWindows\b/],
	['macOS', /\bMac OS X\b|\bMacintosh\b/],
	['ChromeOS', /\bCrOS\b/],
	['Linux', /\bLinux\b/],
]);

/**
 * A coarse device description for the device list (never the raw user agent).
 * @param {unknown} userAgent
 * @returns {{ label: string, browser: string, os: string }}
 */
export const deviceOf = (userAgent) => {
	const ua = typeof userAgent === 'string' ? userAgent.slice(0, 512) : '';
	const browser = BROWSERS.find(([, pattern]) => pattern.test(ua))?.[0] ?? 'Unknown browser';
	const os = SYSTEMS.find(([, pattern]) => pattern.test(ua))?.[0] ?? 'Unknown system';
	return { label: `${browser} on ${os}`, browser, os };
};
