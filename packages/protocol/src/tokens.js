/**
 * Browser, server and link tokens (PLAN 0.4.4; settings-ownership design 8.3) plus the domain and origin rules they rely on.
 *
 * Each product on a website has exactly two tokens, both Portal-signed compact JWS (`typ: ss-token+jws`, EdDSA). The
 * claims are exactly `{ iss, jti, websiteId, domain, productId, kind, iat }`: no expiry, no environment, no scopes, no
 * address. A product verifies them offline against the pinned Portal keys and the revocation list, and accepts only
 * tokens that name it. Every failure throws the same `invalid_token` error, so callers cannot tell the cases apart.
 *
 * A third kind, `link`, is the key of one product calling another on one website (Chat → Notifications): `productId` is
 * the callee, the extra claim `caller` names the calling product, and there are still no scopes in the token. The Portal
 * decides what a link may do and tells the callee (`links.in`); the callee enforces it. A link token is never accepted
 * where a browser or server token is wanted, and a verification that names no kind never takes one.
 *
 * Browser tokens are accepted only from `https://<exact domain>` on the default port, or from a local origin
 * (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`, any port, http or https). Tickets may name any https origin or a
 * local origin.
 */
import { normalizeDomain as normalizeDomainRule } from '@ss/contracts';
import { createProtocolError, isProtocolError } from './errors.js';
import { defaultRandomBytes, randomId } from './encoding.js';
import { nowSeconds, requireString, signCompact, verifyCompact } from './jws.js';

/** @import { KeyResolver, Signer } from './keys.js' */

/** JOSE `typ` of browser and server tokens. */
const TOKEN_TYP = 'ss-token+jws';

/** Token kinds. */
export const TOKEN_KINDS = Object.freeze(/** @type {const} */ (['browser', 'server', 'link']));

/** Format of a product id (the manifest `id`). */
const PRODUCT_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/** Accepted difference between the Portal clock and the product clock when checking `iat`, seconds. */
const IAT_SKEW_SECONDS = 300;
const INVALID_TOKEN_MESSAGE = 'token is not valid';
const MAX_CLAIM_LENGTH = 256;

/** @typedef {typeof TOKEN_KINDS[number]} TokenKind */
/**
 * @typedef {{ iss: string, jti: string, websiteId: string, domain: string, productId: string, kind: TokenKind,
 *   iat: number, caller?: string }} TokenClaims `caller`: link tokens only, the product that calls (`productId` is the callee)
 */

/**
 * @param {string} value
 * @returns {boolean} true when the string has C0 control characters, DEL, whitespace or a backslash
 */
const hasUnsafeChars = (value) => {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
	}
	return /\s/.test(value);
};

/**
 * True for a valid product id (`^[a-z][a-z0-9-]{1,30}$`).
 * @param {unknown} value
 * @returns {value is string}
 */
export const isProductId = (value) => typeof value === 'string' && PRODUCT_ID_PATTERN.test(value);

/**
 * Normalize a website domain to lower-case ASCII (punycode) without a trailing dot, by the one domain rule of
 * `@ss/contracts` (`normalizeDomain`), and only from a bare host name: a token names exactly the domain the Portal
 * stored, so nothing is stripped here. Throws `invalid_argument` on anything that is not a plain public host name:
 * scheme, port, path, userinfo, wildcard, whitespace, IP literals, `localhost` / `*.localhost` and single-label names.
 * @param {unknown} domain
 * @returns {string}
 */
export const normalizeDomain = (domain) => {
	if (typeof domain !== 'string' || domain.length === 0 || domain.length > 253) {
		throw createProtocolError('invalid_argument', 'domain is required');
	}
	if (/[/:@?#*%[\]]/.test(domain) || hasUnsafeChars(domain)) {
		throw createProtocolError('invalid_argument', 'domain must be a bare host name');
	}
	const result = normalizeDomainRule(domain);
	if (!result.ok) throw createProtocolError('invalid_argument', result.message);
	return result.value;
};

/**
 * Canonical form of a browser origin: `scheme://host[:port]`, lower-cased, punycode host, default port dropped. Only
 * http and https. Returns `null` for anything else, including userinfo, any path (even `/`), query, fragment,
 * whitespace, control characters, backslashes and the opaque origin `null`.
 * @param {unknown} value
 * @returns {string | null}
 */
export const canonicalOrigin = (value) => {
	if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || hasUnsafeChars(value)) return null;
	if (!/^https?:\/\/[^/?#@]+$/i.test(value)) return null;
	/** @type {URL} */
	let url;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
	return url.origin;
};

/**
 * @param {string} hostname WHATWG URL hostname (lower-case; IPv6 in brackets)
 * @returns {boolean}
 */
const isLocalHostname = (hostname) =>
	hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';

/**
 * True for `http(s)://localhost`, `*.localhost`, `127.0.0.1` or `[::1]` on any port.
 * @param {unknown} origin
 * @returns {boolean}
 */
export const isLocalOrigin = (origin) => {
	const canonical = canonicalOrigin(origin);
	return canonical !== null && isLocalHostname(new URL(canonical).hostname);
};

/**
 * Browser-token rule: true only for `https://<exact domain>` on the default port, or a local origin. No subdomains and
 * no Referer fallback; a missing Origin is refused.
 * @param {{ origin: unknown, domain: unknown }} params
 * @returns {boolean}
 */
export const originAllowed = ({ origin, domain }) => {
	const canonical = canonicalOrigin(origin);
	if (canonical === null) return false;
	if (isLocalOrigin(canonical)) return true;
	try {
		return canonical === `https://${normalizeDomain(domain)}`;
	} catch {
		return false;
	}
};

/**
 * Ticket rule (PLAN 0.4.5 step 2): true for any `https://` origin or a local origin.
 * @param {unknown} origin
 * @returns {boolean}
 */
export const ticketOriginAllowed = (origin) => {
	const canonical = canonicalOrigin(origin);
	return canonical !== null && (canonical.startsWith('https://') || isLocalOrigin(canonical));
};

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const isClaimString = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_CLAIM_LENGTH;

/**
 * Issue a browser, server or link token (Portal side).
 * @param {{
 *   signer: Signer, issuer: string, websiteId: string, domain: string, productId: string, kind: TokenKind, caller?: string,
 *   jti?: string, now?: () => number, randomBytes?: (length: number) => Uint8Array,
 * }} params `issuer` is the Portal's `PORTAL_URL`; `caller` is required for a link token (the calling product, never the
 *   callee itself) and refused for any other kind.
 * @returns {Promise<{ token: string, claims: TokenClaims }>}
 */
export const issueToken = async ({
	signer,
	issuer,
	websiteId,
	domain,
	productId,
	kind,
	caller,
	jti,
	now = Date.now,
	randomBytes = defaultRandomBytes,
}) => {
	requireString(issuer, 'issuer');
	if (!isClaimString(websiteId)) throw createProtocolError('invalid_argument', 'websiteId is required');
	if (!isProductId(productId)) throw createProtocolError('invalid_argument', 'productId is invalid');
	if (!(/** @type {readonly string[]} */ (TOKEN_KINDS).includes(kind)))
		throw createProtocolError('invalid_argument', 'kind must be browser, server or link');
	if (kind === 'link') {
		if (!isProductId(caller) || caller === productId)
			throw createProtocolError('invalid_argument', 'a link token names the calling product, other than the callee');
	} else if (caller !== undefined) throw createProtocolError('invalid_argument', 'only a link token names a caller');
	const id = jti ?? randomId(randomBytes);
	if (!isClaimString(id)) throw createProtocolError('invalid_argument', 'jti is invalid');
	/** @type {TokenClaims} */
	const claims = {
		iss: issuer,
		jti: id,
		websiteId,
		domain: normalizeDomain(domain),
		productId,
		kind,
		...(kind === 'link' ? { caller } : {}),
		iat: nowSeconds(now),
	};
	const token = await signCompact({ signer, typ: TOKEN_TYP, payload: claims });
	return { token, claims };
};

/**
 * Check the verified payload of a token; throws on the first problem.
 * @param {Record<string, unknown>} payload
 * @param {{ issuer: string, productId: string, kind: TokenKind | undefined, caller?: string | undefined, nowMs: number }} expected
 * @returns {TokenClaims}
 */
const checkTokenClaims = (payload, { issuer, productId, kind, caller, nowMs }) => {
	const { iss, jti, websiteId, domain, iat } = payload;
	if (iss !== issuer || payload.productId !== productId) throw createProtocolError('invalid_token', INVALID_TOKEN_MESSAGE);
	const tokenKind = /** @type {TokenKind} */ (payload.kind);
	if (!TOKEN_KINDS.includes(tokenKind) || (kind !== undefined && tokenKind !== kind))
		throw createProtocolError('invalid_token', INVALID_TOKEN_MESSAGE);
	// a verification that names no kind takes a browser or a server token, never a link
	if (kind === undefined && tokenKind === 'link') throw createProtocolError('invalid_token', INVALID_TOKEN_MESSAGE);
	// a link token names the calling product (and the one the callee expects, when it says); no other kind does
	if (tokenKind === 'link') {
		if (!isProductId(payload.caller) || payload.caller === productId || (caller !== undefined && payload.caller !== caller))
			throw createProtocolError('invalid_token', INVALID_TOKEN_MESSAGE);
	} else if (payload.caller !== undefined) throw createProtocolError('invalid_token', INVALID_TOKEN_MESSAGE);
	if (!isClaimString(jti) || !isClaimString(websiteId) || typeof domain !== 'string')
		throw createProtocolError('invalid_token', INVALID_TOKEN_MESSAGE);
	if (normalizeDomain(domain) !== domain) throw createProtocolError('invalid_token', INVALID_TOKEN_MESSAGE);
	if (!Number.isInteger(iat) || /** @type {number} */ (iat) < 0 || /** @type {number} */ (iat) > nowMs / 1000 + IAT_SKEW_SECONDS)
		throw createProtocolError('invalid_token', INVALID_TOKEN_MESSAGE);
	return {
		iss: issuer,
		jti: /** @type {string} */ (jti),
		websiteId: /** @type {string} */ (websiteId),
		domain,
		productId,
		kind: tokenKind,
		...(tokenKind === 'link' ? { caller: /** @type {string} */ (payload.caller) } : {}),
		iat: /** @type {number} */ (iat),
	};
};

/**
 * Verify a browser or server token offline (product side). Every failure — malformed, bad signature, unknown key,
 * wrong typ, issuer, product or kind, revoked — throws `invalid_token` with the same message. Errors thrown by
 * `isRevoked` itself (for example a database failure) are passed through unchanged.
 * @param {{
 *   token: unknown, keyResolver: KeyResolver, issuer: string, productId: string, kind?: TokenKind, caller?: string,
 *   isRevoked?: (jti: string) => boolean | Promise<boolean>, now?: () => number,
 * }} params `issuer` is the pinned Portal URL; `productId` is this product's id; `caller` (link tokens) is the product
 *   the callee expects to be calling, else any caller is returned in the claims for the callee to check.
 * @returns {Promise<TokenClaims>}
 */
export const verifyToken = async ({ token, keyResolver, issuer, productId, kind, caller, isRevoked, now = Date.now }) => {
	requireString(issuer, 'issuer');
	if (!isProductId(productId)) throw createProtocolError('invalid_argument', 'productId is invalid');
	if (kind !== undefined && !TOKEN_KINDS.includes(kind))
		throw createProtocolError('invalid_argument', 'kind must be browser, server or link');
	if (caller !== undefined && (kind !== 'link' || !isProductId(caller)))
		throw createProtocolError('invalid_argument', 'caller is a product id and goes with kind link');
	if (!keyResolver || typeof keyResolver.resolve !== 'function')
		throw createProtocolError('invalid_argument', 'keyResolver is required');
	/** @type {TokenClaims} */
	let claims;
	try {
		const { payload } = await verifyCompact({ token, keyResolver, typ: TOKEN_TYP, maxLength: 4096 });
		claims = checkTokenClaims(payload, { issuer, productId, kind, caller, nowMs: now() });
	} catch (error) {
		if (isProtocolError(error)) throw createProtocolError('invalid_token', INVALID_TOKEN_MESSAGE);
		throw error;
	}
	if (isRevoked && (await isRevoked(claims.jti)) === true) throw createProtocolError('invalid_token', INVALID_TOKEN_MESSAGE);
	return claims;
};
