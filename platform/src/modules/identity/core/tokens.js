/**
 * One-time tokens (e-mail verification, password reset, invites, MFA challenges, impersonation exchanges): 256-bit random, base64url,
 * shown once; only `HMAC-SHA-256(secret, "ss-identity-token.v1|<purpose>|<token>")` is stored, so a database leak
 * reveals no usable token and a token minted for one purpose never matches another. Deterministic given the
 * injected randomness (no I/O).
 * @module
 */
import { createHmac } from 'node:crypto';

export const TOKEN_PURPOSES = Object.freeze(['signup', 'password_reset', 'invite', 'mfa_challenge', 'impersonation']);

/** @typedef {'signup' | 'password_reset' | 'invite' | 'mfa_challenge' | 'impersonation'} TokenPurpose */

/** Lifetimes (ms). */
export const TOKEN_TTL_MS = Object.freeze({
	signup: 24 * 60 * 60_000,
	password_reset: 30 * 60_000,
	invite: 7 * 24 * 60 * 60_000,
	mfa_challenge: 5 * 60_000,
	/** staff → merchant session exchange: single use, one minute */
	impersonation: 60_000,
});

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
