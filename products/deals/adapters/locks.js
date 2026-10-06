/**
 * Crypto adapter (node:crypto): signed **price-lock tokens**.
 *
 * A lock token is `pl1.<base64url(JSON claims)>.<base64url(HMAC-SHA-256)>` (claims: core/locks.js). It is bound to
 * one website (and, when configured, one customer), compared in constant time and verified by any instance without a
 * database. The secret is the generated secret (`product.secret`, kept in the control database) (≥ 32 chars), else derived with HKDF from the product signing key, so a
 * deployment works without an extra variable (rotating the key then invalidates outstanding locks, which live minutes).
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { isLockClaims } from '../core/locks.js';

const PREFIX = 'pl1';
/** Longest token accepted (claims carry a handful of ids). */
export const MAX_TOKEN_LENGTH = 2048;
/** Minimum length of a configured lock secret. */
export const MIN_SECRET_LENGTH = 32;

/**
 * The lock secret: the generated secret (`product.secret`, kept in the control database), else HKDF of the product signing key.
 * @param {{ secret?: string | undefined, signingKey?: string | Record<string, unknown> | null }} input
 * @returns {Buffer}
 */
export const lockSecret = ({ secret, signingKey }) => {
	if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) return Buffer.from(secret, 'utf8');
	const jwk = typeof signingKey === 'string' ? { d: signingKey.slice(signingKey.lastIndexOf(':') + 1) } : signingKey; // kid:seed
	const material = typeof jwk?.d === 'string' ? Buffer.from(jwk.d, 'base64url') : null;
	if (!material || material.length === 0)
		throw new Error('a generated secret (≥ 32 chars, product.secret) or the signing key is required');
	return Buffer.from(hkdfSync('sha256', material, 'ss-deals', 'price-lock/v1', 32));
};

/**
 * @param {{ secret: Buffer }} options
 */
export const createLockTokens = ({ secret }) => {
	/** @param {string} payload */
	const sign = (payload) => createHmac('sha256', secret).update(`${PREFIX}.${payload}`).digest('base64url');
	return Object.freeze({
		/**
		 * @param {import('../core/locks.js').LockClaims} claims
		 * @returns {string}
		 */
		sign: (claims) => {
			const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
			return `${PREFIX}.${payload}.${sign(payload)}`;
		},
		/**
		 * Claims of an authentic token, else null (expiry is policy, checked by core/locks.js).
		 * @param {unknown} token
		 * @returns {import('../core/locks.js').LockClaims | null}
		 */
		verify: (token) => {
			if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
			const [prefix, payload, signature, extra] = token.split('.');
			if (prefix !== PREFIX || !payload || !signature || extra !== undefined) return null;
			const expected = Buffer.from(sign(payload));
			const given = Buffer.from(signature);
			if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
			try {
				const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
				return isLockClaims(claims) ? claims : null;
			} catch {
				return null;
			}
		},
	});
};

/** @typedef {ReturnType<typeof createLockTokens>} LockTokens */
