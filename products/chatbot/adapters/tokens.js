/**
 * Crypto adapters (node:crypto): stable ids from idempotency keys, guest **marker tokens** and the per-website
 * **webhook-tool signing secret**.
 *
 * A guest's browser uses the website's `pk_` key, which identifies the website but not the visitor. The first
 * conversation returns a marker token — HMAC-SHA-256 over `{ w: websiteId, v: visitorId, e: expiry }` — that the
 * browser sends back as `SS-Identity` (the header CORS allows), so the guest can come back to its conversations
 * (ported from the ibrahimMobiles guest thread cookie). A signed-in customer is identified by the website's own
 * login token instead (app-kit identity); `POST /v1/conversations:claim` moves the guest's history to them.
 *
 * Secrets are `CHATBOT_TOKEN_SECRET` (≥ 32 chars) or derived with HKDF from the product signing key, so nothing has
 * to be stored. Webhook tools are signed with a per-website secret derived from it and the configured version
 * (rotation = increment `tools.signing_key_version`).
 */
import { createHash, createHmac, hkdfSync, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';
import { signatureBase } from '../core/tools.js';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const MARKER_PREFIX = 'cm1';
export const MIN_SECRET_LENGTH = 32;

/**
 * 26 lowercase Crockford base32 characters of SHA-256(text).
 * @param {string} text
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
 * Root secret: `CHATBOT_TOKEN_SECRET`, else HKDF of the product signing key.
 * @param {{ secret?: string | undefined, signingKey?: string | Record<string, unknown> | null }} input
 * @returns {Buffer}
 */
export const rootSecret = ({ secret, signingKey }) => {
	if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) return Buffer.from(secret, 'utf8');
	const jwk = typeof signingKey === 'string' ? { d: signingKey.slice(signingKey.lastIndexOf(':') + 1) } : signingKey; // kid:seed
	const material = typeof jwk?.d === 'string' ? Buffer.from(jwk.d, 'base64url') : null;
	if (!material || material.length === 0) throw new Error('CHATBOT_TOKEN_SECRET (≥ 32 chars) or SIGNING_KEY is required');
	return Buffer.from(hkdfSync('sha256', material, 'ss-chatbot', 'root/v1', 32));
};

/**
 * @param {{ secret: Buffer, now?: () => number }} options
 */
export const createTokens = ({ secret, now = Date.now }) => {
	const markerKey = Buffer.from(hkdfSync('sha256', secret, 'ss-chatbot', 'marker/v1', 32));
	/** @param {string} payload */
	const sign = (payload) => createHmac('sha256', markerKey).update(`${MARKER_PREFIX}.${payload}`).digest('base64url');
	return Object.freeze({
		/**
		 * @param {{ websiteId: string, visitorId: string, days: number }} input
		 * @returns {{ token: string, expiresAt: string }}
		 */
		issueMarker: ({ websiteId, visitorId, days }) => {
			const exp = Math.floor(now() / 1000) + Math.max(1, Math.floor(days)) * 86_400;
			const payload = Buffer.from(JSON.stringify({ w: websiteId, v: visitorId, e: exp })).toString('base64url');
			return { token: `${MARKER_PREFIX}.${payload}.${sign(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
		},
		/**
		 * The visitor of a valid marker for this website, else null.
		 * @param {unknown} token
		 * @param {string} websiteId
		 * @returns {string | null}
		 */
		verifyMarker: (token, websiteId) => {
			if (typeof token !== 'string' || token.length > 1024) return null;
			const [prefix, payload, signature, extra] = token.split('.');
			if (prefix !== MARKER_PREFIX || !payload || !signature || extra !== undefined) return null;
			const expected = Buffer.from(sign(payload));
			const given = Buffer.from(signature);
			if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
			try {
				const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
				if (claims.w !== websiteId || typeof claims.v !== 'string' || !(claims.e > now() / 1000)) return null;
				return claims.v;
			} catch {
				return null;
			}
		},
		/**
		 * The webhook-tool signing secret of a website (base64url, 32 bytes).
		 * @param {string} websiteId
		 * @param {number} version
		 */
		toolSecret: (websiteId, version) =>
			Buffer.from(hkdfSync('sha256', secret, 'ss-chatbot', `tools/${websiteId}/v${version}`, 32)).toString('base64url'),
		/**
		 * Signature header value for a webhook body.
		 * @param {{ websiteId: string, version: number, body: string, timestamp: number }} input
		 */
		signTool: ({ websiteId, version, body, timestamp }) => {
			const key = Buffer.from(hkdfSync('sha256', secret, 'ss-chatbot', `tools/${websiteId}/v${version}`, 32)).toString(
				'base64url',
			);
			const mac = createHmac('sha256', key).update(signatureBase(timestamp, body)).digest('hex');
			return `t=${timestamp},v1=${mac},kv=${version}`;
		},
	});
};

/** @typedef {ReturnType<typeof createTokens>} Tokens */
