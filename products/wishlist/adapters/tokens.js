/**
 * Crypto adapters (node:crypto): ids, guest tokens and share tokens.
 *
 * - **Ids**: random `<prefix>_` + 26 Crockford base32 characters (130 bits).
 * - **Guest tokens** `wg1.<payload>.<hmac>` over `{ w: websiteId, g: guestId, e: expiry }`: bound to one website,
 *   compared in constant time, expiring. They hold no personal data — only the random guest id whose lists they open.
 * - **Share tokens**: 26 random base32 characters (130 bits), opaque, carried in share URLs. Only their SHA-256 is
 *   stored, so a database read never reveals a working link; rotating or revoking replaces the hash.
 * @module
 */
import { createHash, createHmac, hkdfSync, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const GUEST_PREFIX = 'wg1';
/** Minimum length of a configured token secret. */
export const MIN_SECRET_LENGTH = 32;
/** Longest token accepted from a request. */
export const MAX_TOKEN_LENGTH = 512;
const SHARE_TOKEN = /^[0-9a-hjkmnp-tv-z]{26}$/;

/**
 * 26 Crockford base32 characters of at least 17 bytes.
 * @param {Uint8Array} bytes
 */
const base32 = (bytes) => {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = ((value << 8) | byte) & 0xffff;
		bits += 8;
		while (bits >= 5 && out.length < 26) {
			out += CROCKFORD[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	return out;
};

/**
 * Random id: `<prefix>_` + 130 random bits.
 * @param {string} prefix
 * @param {(size: number) => Uint8Array} [random]
 */
export const randomId = (prefix, random = nodeRandomBytes) => `${prefix}_${base32(random(17))}`;

/**
 * SHA-256 (base64url) of a share token: the only form stored.
 * @param {string} token
 */
export const hashShareToken = (token) => createHash('sha256').update(`wishlist-share|${token}`).digest('base64url');

/**
 * The token secret: the generated secret (`product.secret`, kept in the control database), else derived (HKDF) from the product signing key so a deployment works
 * without an extra variable (rotating the key then signs every guest out of their guest list).
 * @param {{ secret?: string | undefined, signingKey?: string | Record<string, unknown> | null }} input
 * @returns {Buffer}
 */
export const tokenSecret = ({ secret, signingKey }) => {
	if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) return Buffer.from(secret, 'utf8');
	const jwk = typeof signingKey === 'string' ? { d: signingKey.slice(signingKey.lastIndexOf(':') + 1) } : signingKey; // kid:seed
	const material = typeof jwk?.d === 'string' ? Buffer.from(jwk.d, 'base64url') : null;
	if (!material || material.length === 0)
		throw new Error('a generated secret (≥ 32 chars, product.secret) or the signing key is required');
	return Buffer.from(hkdfSync('sha256', material, 'ss-wishlist', 'guest-token/v1', 32));
};

/**
 * @param {{ secret: Buffer, now?: () => number, random?: (size: number) => Uint8Array }} options
 */
export const createTokens = ({ secret, now = Date.now, random = nodeRandomBytes }) => {
	/** @param {string} payload */
	const sign = (payload) => createHmac('sha256', secret).update(`${GUEST_PREFIX}.${payload}`).digest('base64url');
	return Object.freeze({
		/**
		 * A guest token for a (new or existing) guest id.
		 * @param {{ websiteId: string, guestId?: string, ttlDays: number }} input
		 * @returns {{ token: string, guestId: string, expiresAt: number }}
		 */
		issueGuest: ({ websiteId, guestId = randomId('gst', random), ttlDays }) => {
			const exp = Math.floor(now() / 1000) + Math.max(1, Math.floor(ttlDays)) * 86_400;
			const payload = Buffer.from(JSON.stringify({ w: websiteId, g: guestId, e: exp })).toString('base64url');
			return { token: `${GUEST_PREFIX}.${payload}.${sign(payload)}`, guestId, expiresAt: exp * 1000 };
		},
		/**
		 * The guest of a valid token for this website, else null.
		 * @param {unknown} token
		 * @param {string} websiteId
		 * @returns {{ guestId: string, expiresAt: number } | null}
		 */
		verifyGuest: (token, websiteId) => {
			if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
			const [prefix, payload, signature, extra] = token.split('.');
			if (prefix !== GUEST_PREFIX || !payload || !signature || extra !== undefined) return null;
			const expected = Buffer.from(sign(payload));
			const given = Buffer.from(signature);
			if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
			try {
				const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
				if (claims.w !== websiteId || typeof claims.g !== 'string' || !(claims.e > now() / 1000)) return null;
				return { guestId: claims.g, expiresAt: claims.e * 1000 };
			} catch {
				return null;
			}
		},
		/** A new random share token. */
		newShareToken: () => base32(random(17)),
		/**
		 * Whether a value has the share-token shape (checked before any lookup).
		 * @param {unknown} value
		 * @returns {value is string}
		 */
		isShareToken: (value) => typeof value === 'string' && SHARE_TOKEN.test(value),
	});
};

/** @typedef {ReturnType<typeof createTokens>} Tokens */
