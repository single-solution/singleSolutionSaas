/**
 * Crypto adapters (node:crypto): stable ids derived from idempotency keys, and customer **wallet tokens**.
 *
 * A browser wallet (Mode A/B) uses the website's `pk_` key, which identifies the website but not the customer. The
 * merchant's server — which knows who is signed in — mints a short-lived wallet token with its `sk_` key
 * (`POST /v1/wallet-tokens`); the browser sends it as `SS-Identity`. Tokens are HMAC-SHA-256 over
 * `{ w: websiteId, c: customerId, e: expiry }`, bound to one website, compared in constant time.
 */
import { createHash, createHmac, hkdfSync, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const TOKEN_PREFIX = 'wt1';
/** Minimum length of a configured wallet secret. */
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
		value = (value << 8) | byte;
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
 * The wallet-token secret: `LOYALTY_WALLET_SECRET`, else derived (HKDF) from the product signing key so a deployment
 * works without an extra variable.
 * @param {{ secret?: string | undefined, signingKey?: string | Record<string, unknown> | null }} input
 * @returns {Buffer}
 */
export const walletSecret = ({ secret, signingKey }) => {
	if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) return Buffer.from(secret, 'utf8');
	const jwk = typeof signingKey === 'string' ? { d: signingKey.slice(signingKey.lastIndexOf(':') + 1) } : signingKey; // kid:seed
	const material = typeof jwk?.d === 'string' ? Buffer.from(jwk.d, 'base64url') : null;
	if (!material || material.length === 0) throw new Error('LOYALTY_WALLET_SECRET (≥ 32 chars) or SIGNING_KEY is required');
	return Buffer.from(hkdfSync('sha256', material, 'ss-loyalty', 'wallet-token/v1', 32));
};

/**
 * @param {{ secret: Buffer, now?: () => number }} options
 */
export const createWalletTokens = ({ secret, now = Date.now }) => {
	/** @param {string} payload */
	const sign = (payload) => createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${payload}`).digest('base64url');
	return Object.freeze({
		/**
		 * @param {{ websiteId: string, customerId: string, ttlMinutes: number }} input
		 * @returns {{ token: string, expiresAt: string }}
		 */
		issue: ({ websiteId, customerId, ttlMinutes }) => {
			const exp = Math.floor(now() / 1000) + Math.max(1, Math.floor(ttlMinutes)) * 60;
			const payload = Buffer.from(JSON.stringify({ w: websiteId, c: customerId, e: exp })).toString('base64url');
			return { token: `${TOKEN_PREFIX}.${payload}.${sign(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
		},
		/**
		 * The customer of a valid token for this website, else null.
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
				if (claims.w !== websiteId || typeof claims.c !== 'string' || !(claims.e > now() / 1000)) return null;
				return claims.c;
			} catch {
				return null;
			}
		},
	});
};

/** @typedef {ReturnType<typeof createWalletTokens>} WalletTokens */
