/**
 * One-time tokens (setup links, password resets, e-mail changes, two-step sign-in steps): 256-bit random, base64url,
 * shown once; only `HMAC-SHA-256(secret, "ss-identity-token.v1|<purpose>|<token>")` is stored, so a database leak
 * reveals no usable token and a token minted for one purpose never matches another. Deterministic given the
 * injected randomness (no I/O).
 * @module
 */
import { createHmac } from 'node:crypto';

export const TOKEN_PURPOSES = Object.freeze(['setup', 'password_reset', 'email_change', 'two_step']);

/** @typedef {'setup' | 'password_reset' | 'email_change' | 'two_step'} TokenPurpose */

/** Lifetimes (ms), PLAN 0.2: setup links 72 h for merchants and 24 h for admins (given per link), resets 30 minutes. */
export const TOKEN_TTL_MS = Object.freeze({
	setup: 72 * 60 * 60_000,
	password_reset: 30 * 60_000,
	email_change: 24 * 60 * 60_000,
	two_step: 5 * 60_000,
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
