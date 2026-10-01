/**
 * Bring-your-own customer identity (PLAN §5.3, F.14): products accept the website's own login tokens as the
 * end-customer identity. The website's issuer, its public keys (≤ 5), the expected audience and the claim map arrive
 * inline in the signed entitlement document (`identity` section), so verification is offline.
 *
 * `verify(request, { doc, body })` reads `SS-Identity: <JWT>` (or, for `sendBeacon` bodies, `body.identity`) and
 * checks: compact JWS with `alg` ∈ EdDSA | ES256 | RS256 matching the key type (`none`, HMAC and header-borne keys
 * `jwk/jku/x5u/x5c` and `crit` refused), the key by `kid` (or the only compatible key), `iss` = issuer, `aud` contains
 * the audience when one is configured, `exp` (required) in the future, `nbf` reached, `iat` (required) not in the
 * future and at most 24 h old (60 s clock skew). The result maps the claims through `claimMap`:
 * `{ subject, email?, phone?, issuer, claims }`, where `claims` is the full verified payload (deep-frozen), so products
 * can read issuer-specific claims (e.g. a membership tier) without decoding the token again.
 * @module
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/** @typedef {import('@ss/contracts').EntitlementDocument} EntitlementDocument */
/** @typedef {import('@ss/contracts').IdentitySection} IdentitySection */

/** Request header carrying the customer token. */
export const IDENTITY_HEADER = 'ss-identity';
/** Tokens older than this (`now - iat`) are refused. */
export const IDENTITY_MAX_AGE_MS = 24 * 60 * 60_000;
/** Allowed clock skew for `exp`, `nbf` and `iat`. */
export const IDENTITY_SKEW_MS = 60_000;
/** Longest accepted token. */
export const IDENTITY_MAX_TOKEN_LENGTH = 8192;

/** `alg` → key type and node:crypto parameters. */
const ALGORITHMS = Object.freeze({
	EdDSA: { kty: 'OKP', hash: null, dsaEncoding: undefined },
	ES256: { kty: 'EC', hash: 'sha256', dsaEncoding: /** @type {const} */ ('ieee-p1363') },
	RS256: { kty: 'RSA', hash: 'sha256', dsaEncoding: undefined },
});
const REFUSED_HEADERS = Object.freeze(['jwk', 'jku', 'x5u', 'x5c', 'x5t', 'x5t#S256', 'crit']);
const SEGMENT = /^[A-Za-z0-9_-]*$/;

/**
 * @typedef {{ subject: string, email?: string, phone?: string, issuer: string, claims: Readonly<Record<string, unknown>> }} CustomerIdentity
 * @typedef {'identity_missing' | 'identity_not_configured' | 'malformed' | 'algorithm' | 'unknown_key' | 'signature'
 *   | 'issuer' | 'audience' | 'expired' | 'not_yet_valid' | 'too_old' | 'subject'} IdentityFailure
 * @typedef {{ ok: true, identity: CustomerIdentity } | { ok: false, code: IdentityFailure }} IdentityResult
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {string} segment
 * @returns {Record<string, any> | null}
 */
const decodeJson = (segment) => {
	try {
		const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
		return isObject(value) ? value : null;
	} catch {
		return null;
	}
};

/**
 * @template T
 * @param {T} value
 * @returns {T} the value, recursively frozen
 */
const deepFreeze = (value) => {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
};

/**
 * A claim as a string (numbers are stringified), or undefined.
 * @param {Record<string, any>} claims
 * @param {string | undefined} name
 * @returns {string | undefined}
 */
const claimOf = (claims, name) => {
	if (name === undefined || !Object.hasOwn(claims, name)) return undefined;
	const value = claims[name];
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return typeof value === 'string' && value.length > 0 && value.length <= 320 ? value : undefined;
};

/**
 * Verify one customer token against a document's identity section (pure apart from `now`).
 * @param {unknown} token
 * @param {IdentitySection | null | undefined} section
 * @param {{ now?: () => number }} [options]
 * @returns {IdentityResult}
 */
export const verifyIdentityToken = (token, section, { now = Date.now } = {}) => {
	if (!section) return { ok: false, code: 'identity_not_configured' };
	if (typeof token !== 'string' || token.length === 0) return { ok: false, code: 'identity_missing' };
	if (token.length > IDENTITY_MAX_TOKEN_LENGTH) return { ok: false, code: 'malformed' };
	const parts = token.split('.');
	if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part)) || !parts[0] || !parts[1] || !parts[2])
		return { ok: false, code: 'malformed' };
	const [encodedHeader, encodedPayload, encodedSignature] = /** @type {[string, string, string]} */ (parts);
	const header = decodeJson(encodedHeader);
	const claims = decodeJson(encodedPayload);
	if (!header || !claims) return { ok: false, code: 'malformed' };
	if (REFUSED_HEADERS.some((name) => Object.hasOwn(header, name))) return { ok: false, code: 'malformed' };
	const alg = header.alg;
	if (typeof alg !== 'string' || !Object.hasOwn(ALGORITHMS, alg)) return { ok: false, code: 'algorithm' };
	const spec = ALGORITHMS[/** @type {keyof typeof ALGORITHMS} */ (alg)];
	const compatible = section.jwks.filter((key) => key.kty === spec.kty && (key.alg === undefined || key.alg === alg));
	const kid = header.kid;
	const key =
		typeof kid === 'string'
			? compatible.find((candidate) => candidate.kid === kid)
			: compatible.length === 1
				? compatible[0]
				: undefined;
	if (!key) return { ok: false, code: 'unknown_key' };
	let valid = false;
	try {
		const publicKey = createPublicKey({ key: /** @type {import('node:crypto').JsonWebKey} */ ({ ...key }), format: 'jwk' });
		valid = cryptoVerify(
			spec.hash,
			Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'),
			spec.dsaEncoding ? { key: publicKey, dsaEncoding: spec.dsaEncoding } : publicKey,
			Buffer.from(encodedSignature, 'base64url'),
		);
	} catch {
		valid = false;
	}
	if (!valid) return { ok: false, code: 'signature' };
	if (claims.iss !== section.issuer) return { ok: false, code: 'issuer' };
	if (section.audience !== undefined) {
		const aud = claims.aud;
		const audiences = Array.isArray(aud) ? aud : [aud];
		if (!audiences.includes(section.audience)) return { ok: false, code: 'audience' };
	}
	const at = now();
	const seconds = (/** @type {unknown} */ value) => (typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null);
	const exp = seconds(claims.exp);
	const iat = seconds(claims.iat);
	const nbf = seconds(claims.nbf);
	if (exp === null || at >= exp + IDENTITY_SKEW_MS) return { ok: false, code: 'expired' };
	if (claims.nbf !== undefined && (nbf === null || at + IDENTITY_SKEW_MS < nbf)) return { ok: false, code: 'not_yet_valid' };
	if (iat === null || at + IDENTITY_SKEW_MS < iat) return { ok: false, code: 'not_yet_valid' };
	if (at - iat > IDENTITY_MAX_AGE_MS) return { ok: false, code: 'too_old' };
	const subject = claimOf(claims, section.claimMap.subject);
	if (subject === undefined || subject.length > 255) return { ok: false, code: 'subject' };
	const email = claimOf(claims, section.claimMap.email);
	const phone = claimOf(claims, section.claimMap.phone);
	return {
		ok: true,
		identity: {
			subject,
			...(email === undefined ? {} : { email }),
			...(phone === undefined ? {} : { phone }),
			issuer: section.issuer,
			claims: deepFreeze(claims),
		},
	};
};

/**
 * The customer token of a request: the `SS-Identity` header, else `body.identity` (`sendBeacon` body auth).
 * @param {Request | { headers: Headers }} request
 * @param {unknown} [body]
 * @returns {string | null}
 */
export const identityTokenOf = (request, body) => {
	const header = request.headers.get(IDENTITY_HEADER);
	if (header !== null && header.trim().length > 0) return header.trim();
	if (isObject(body) && typeof body.identity === 'string' && body.identity.length > 0) return body.identity;
	return null;
};

/**
 * @param {{ now?: () => number }} [options]
 */
export const createIdentity = ({ now = Date.now } = {}) =>
	Object.freeze({
		/**
		 * Verify the customer identity of a request against the website's entitlement document.
		 * @param {Request | { headers: Headers }} request
		 * @param {{ doc: EntitlementDocument | null | undefined, body?: unknown }} context
		 * @returns {IdentityResult}
		 */
		verify: (request, { doc, body } = { doc: null }) => {
			const token = identityTokenOf(request, body);
			if (!doc?.identity) return { ok: false, code: token ? 'identity_not_configured' : 'identity_missing' };
			return verifyIdentityToken(token, doc.identity, { now });
		},
		verifyToken: (/** @type {unknown} */ token, /** @type {IdentitySection | null | undefined} */ section) =>
			verifyIdentityToken(token, section, { now }),
	});
/** @typedef {ReturnType<typeof createIdentity>} Identity */
