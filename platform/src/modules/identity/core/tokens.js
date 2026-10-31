/**
 * One-time tokens (setup links, password resets, email changes, two-step sign-in steps): 256-bit random, base64url,
 * shown once; only `HMAC-SHA-256(secret, "ss-identity-token.v1|<purpose>|<token>")` is stored, so a database leak
 * reveals no usable token and a token minted for one purpose never matches another. Deterministic given the
 * injected randomness (no I/O).
 * @module
 */
import { createHmac } from 'node:crypto';

const TOKEN_PURPOSES = Object.freeze(['setup', 'password_reset', 'email_change', 'two_step', 'step_up_otp']);

/** @typedef {'setup' | 'password_reset' | 'email_change' | 'two_step' | 'step_up_otp'} TokenPurpose */

/** Lifetimes (ms), PLAN 0.2: resets 30 minutes; setup links give their own ({@link SETUP_TTL_MS}). */
export const TOKEN_TTL_MS = Object.freeze({
	password_reset: 30 * 60_000,
	email_change: 24 * 60 * 60_000,
	two_step: 5 * 60_000,
	step_up_otp: 10 * 60_000,
});

/** Setup link lifetimes per kind of login (PLAN 0.0 Setup link). */
export const SETUP_TTL_MS = Object.freeze({ merchant: 72 * 60 * 60_000, admin: 24 * 60 * 60_000 });

/**
 * @param {(n: number) => Uint8Array} randomBytes
 * @returns {string} 43 base64url characters
 */
export const newToken = (randomBytes) => Buffer.from(randomBytes(32)).toString('base64url');

/**
 * @param {Uint8Array} secret
 * @param {TokenPurpose} purpose
 * @param {string} token
 * @returns {string}
 */
export const hashToken = (secret, purpose, token) => {
	if (!TOKEN_PURPOSES.includes(purpose)) throw new TypeError(`unknown token purpose ${purpose}`);
	return createHmac('sha256', secret).update(`ss-identity-token.v1|${purpose}|${token}`).digest('hex');
};

/** Console paths of each link kind. */
const LINK_PATHS = Object.freeze({
	setup: '/set-password',
	password_reset: '/reset-password',
	email_change: '/confirm-email',
});

/**
 * Console links sent by email or copied by an admin. The token travels in the URL fragment so it never reaches
 * server logs, proxies or Referer headers; the console page reads it and posts it to the API.
 * @param {string} portalUrl `PORTAL_URL` (no trailing slash)
 * @param {keyof typeof LINK_PATHS} kind
 * @param {string} token
 */
export const linkFor = (portalUrl, kind, token) =>
	`${portalUrl.replace(/\/+$/, '')}${LINK_PATHS[kind]}#token=${encodeURIComponent(token)}`;
