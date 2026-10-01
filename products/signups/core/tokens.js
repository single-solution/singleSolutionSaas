/**
 * The website's identity issuer (pure part). Signups **is** the identity issuer of every website it serves:
 *
 * - issuer `iss = <product base>/i/<websiteId>` — one issuer per website, so a token of one website is never valid on
 *   another; discovery at `<iss>/.well-known/openid-configuration`;
 * - public keys at `<product base>/.well-known/jwks/<websiteId>.json` (Ed25519, `alg: EdDSA`);
 * - access tokens are short-lived JWTs (`sub` = customer id, `sid` = session, `sv` = session version) that any product
 *   verifies offline once the merchant registers the issuer in the Portal (Website → Identity, PLAN §5.3 / F.14);
 * - refresh tokens are opaque (`rt1.<sessionId>.<secret>`), stored only as an HMAC, rotated on every use.
 *
 * Signing and hashing are adapters (`adapters/crypto.js`); this module builds and checks claims.
 * @module
 */

/** Clock skew tolerated on `exp`, `nbf` and `iat` (the same as app-kit identity verification). */
export const SKEW_MS = 60_000;
/** Longest accepted access token. */
export const TOKEN_MAX = 4096;

const OPAQUE = /^[A-Za-z0-9_-]+$/;

/**
 * @param {string} base product base URL
 * @param {string} websiteId
 */
export const issuerFor = (base, websiteId) => `${base.replace(/\/+$/, '')}/i/${websiteId}`;

/**
 * @param {string} base
 * @param {string} websiteId
 */
export const jwksUrlFor = (base, websiteId) => `${base.replace(/\/+$/, '')}/.well-known/jwks/${websiteId}.json`;

/**
 * OpenID-style discovery document of a website's issuer (signing metadata only; this is not an OAuth server).
 * @param {{ base: string, websiteId: string }} input
 */
export const discoveryDocument = ({ base, websiteId }) => ({
	issuer: issuerFor(base, websiteId),
	jwks_uri: jwksUrlFor(base, websiteId),
	id_token_signing_alg_values_supported: ['EdDSA'],
	subject_types_supported: ['public'],
	claims_supported: ['sub', 'sid', 'sv', 'amr', 'email', 'email_verified', 'phone_number', 'phone_number_verified'],
});

/**
 * Website id from a `<websiteId>.json` file name.
 * @param {unknown} file
 * @returns {string | null}
 */
export const websiteIdOfJwksFile = (file) => {
	if (typeof file !== 'string') return null;
	const match = /^(web_[0-9a-z]{1,64})\.json$/.exec(file);
	return match?.[1] ?? null;
};

/**
 * @typedef {object} AccessClaims
 * @property {string} iss
 * @property {string} sub customer id
 * @property {string} aud
 * @property {number} iat
 * @property {number} exp
 * @property {string} jti
 * @property {string} sid session id
 * @property {number} sv customer session version (revoke-all bumps it)
 * @property {string[]} amr how the customer proved control (`otp`, `magic_link`)
 * @property {string} [email]
 * @property {boolean} [email_verified]
 * @property {string} [phone_number]
 * @property {boolean} [phone_number_verified]
 */

/**
 * Claims of an access token.
 * @param {{ issuer: string, audience: string, customer: { id: string, email?: string | null, phone?: string | null,
 *   emailVerifiedAt?: string | null, phoneVerifiedAt?: string | null, sessionVersion?: number },
 *   sessionId: string, method: string, now: number, ttlMinutes: number, jti: string,
 *   include: { email: boolean, phone: boolean } }} input
 * @returns {AccessClaims}
 */
export const accessClaims = ({ issuer, audience, customer, sessionId, method, now, ttlMinutes, jti, include }) => {
	const iat = Math.floor(now / 1000);
	return {
		iss: issuer,
		sub: customer.id,
		aud: audience,
		iat,
		exp: iat + Math.max(1, Math.floor(ttlMinutes)) * 60,
		jti,
		sid: sessionId,
		sv: customer.sessionVersion ?? 0,
		amr: [method],
		...(include.email && customer.email ? { email: customer.email, email_verified: Boolean(customer.emailVerifiedAt) } : {}),
		...(include.phone && customer.phone
			? { phone_number: customer.phone, phone_number_verified: Boolean(customer.phoneVerifiedAt) }
			: {}),
	};
};

/**
 * Check the registered claims of a verified token.
 * @param {Record<string, unknown>} claims
 * @param {{ issuer: string, audience: string, now: number }} expected
 * @returns {{ ok: true, claims: AccessClaims } | { ok: false, code: 'issuer' | 'audience' | 'expired' | 'not_yet_valid' | 'malformed' }}
 */
export const checkAccessClaims = (claims, { issuer, audience, now }) => {
	if (claims.iss !== issuer) return { ok: false, code: 'issuer' };
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.includes(audience)) return { ok: false, code: 'audience' };
	const { exp, iat, sub, sid, sv } = claims;
	if (typeof exp !== 'number' || typeof iat !== 'number') return { ok: false, code: 'malformed' };
	if (now >= exp * 1000 + SKEW_MS) return { ok: false, code: 'expired' };
	if (now + SKEW_MS < iat * 1000) return { ok: false, code: 'not_yet_valid' };
	if (typeof sub !== 'string' || typeof sid !== 'string' || typeof sv !== 'number') return { ok: false, code: 'malformed' };
	return { ok: true, claims: /** @type {AccessClaims} */ (/** @type {unknown} */ (claims)) };
};

/**
 * An opaque `<prefix>.<id>.<secret>` token.
 * @param {string} prefix `rt1` (refresh) or `ml1` (magic link)
 * @param {string} id
 * @param {string} secret base64url
 */
export const formatToken = (prefix, id, secret) => `${prefix}.${id}.${secret}`;

/**
 * Parse an opaque token of the given prefix.
 * @param {unknown} token
 * @param {string} prefix
 * @returns {{ id: string, secret: string } | null}
 */
export const parseToken = (token, prefix) => {
	if (typeof token !== 'string' || token.length > 512) return null;
	const [p, id, secret, ...rest] = token.split('.');
	if (p !== prefix || !id || !secret || rest.length > 0) return null;
	if (!/^[a-z]{2,8}_[0-9a-z]{26}$/.test(id) || !OPAQUE.test(secret) || secret.length < 32) return null;
	return { id, secret };
};
