/**
 * Crypto adapters (node:crypto): stable ids derived from idempotency keys, and **review link tokens**.
 *
 * A review request message carries a link to the merchant's review page with a token that proves the purchase without
 * a sign-in. Tokens are HMAC-SHA-256 over `{ w: websiteId, r: requestId, e: expiry }`, bound to one website and one
 * request, compared in constant time. The secret is the generated secret (`product.secret`, kept in the control database), else derived (HKDF) from the product
 * signing key, so a deployment works without an extra variable.
 */
import { createHash, createHmac, hkdfSync, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const TOKEN_PREFIX = 'rl1';
/** Minimum length of a configured link secret. */
export const MIN_SECRET_LENGTH = 32;

/**
 * 26 lowercase Crockford base32 characters (130 bits) of SHA-256(text): stable ids from idempotency keys.
 * @param {string} text
 * @returns {string}
 */
export const stableId = (text) => {
	const digest = createHash('sha256').update(text).digest();
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of digest) {
		value = ((value << 8) | byte) & 0xffff;
		bits += 8;
		while (bits >= 5 && out.length < 26) {
			out += CROCKFORD[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		if (out.length >= 26) break;
	}
	return out;
};

/** @param {number} n */
export const randomBytes = (n) => new Uint8Array(nodeRandomBytes(n));

/**
 * The link-token secret: the generated secret (`product.secret`, kept in the control database), else HKDF of the product signing key.
 * @param {{ secret?: string | undefined, signingKey?: string | Record<string, unknown> | null }} input
 * @returns {Buffer}
 */
export const linkSecret = ({ secret, signingKey }) => {
	if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) return Buffer.from(secret, 'utf8');
	const jwk = typeof signingKey === 'string' ? { d: signingKey.slice(signingKey.lastIndexOf(':') + 1) } : signingKey; // kid:seed
	const material = typeof jwk?.d === 'string' ? Buffer.from(jwk.d, 'base64url') : null;
	if (!material || material.length === 0)
		throw new Error('a generated secret (≥ 32 chars, product.secret) or the signing key is required');
	return Buffer.from(hkdfSync('sha256', material, 'ss-reviews', 'review-link/v1', 32));
};

/**
 * @param {{ secret: Buffer, now?: () => number }} options
 */
export const createLinkTokens = ({ secret, now = Date.now }) => {
	/** @param {string} payload */
	const sign = (payload) => createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${payload}`).digest('base64url');
	return Object.freeze({
		/**
		 * @param {{ websiteId: string, requestId: string, ttlDays: number }} input
		 * @returns {{ token: string, expiresAt: string }}
		 */
		issue: ({ websiteId, requestId, ttlDays }) => {
			const exp = Math.floor(now() / 1000) + Math.max(1, Math.floor(ttlDays)) * 86_400;
			const payload = Buffer.from(JSON.stringify({ w: websiteId, r: requestId, e: exp })).toString('base64url');
			return { token: `${TOKEN_PREFIX}.${payload}.${sign(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
		},
		/**
		 * The request id of a valid token for this website, else null.
		 * @param {unknown} token
		 * @param {string} websiteId
		 * @returns {string | null}
		 */
		verify: (token, websiteId) => {
			if (typeof token !== 'string' || token.length > 2048) return null;
			const [prefix, payload, signature] = token.split('.');
			if (prefix !== TOKEN_PREFIX || !payload || !signature) return null;
			const expected = Buffer.from(sign(payload));
			const given = Buffer.from(signature);
			if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
			try {
				const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
				if (claims.w !== websiteId || typeof claims.r !== 'string' || !(claims.e > now() / 1000)) return null;
				return claims.r;
			} catch {
				return null;
			}
		},
	});
};

/** @typedef {ReturnType<typeof createLinkTokens>} LinkTokens */
