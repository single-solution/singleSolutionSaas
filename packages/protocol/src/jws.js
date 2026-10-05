/**
 * Internal compact-JWS helpers (EdDSA only) and claim checks shared by every token type.
 *
 * Signing is done by hand over `base64url(header).base64url(payload)` so any `Signer` (including KMS-backed ones) works.
 * Verification goes through `jose.compactVerify` with an `algorithms: ['EdDSA']` allow-list, after a strict pre-parse of
 * the protected header that rejects key-carrying or extension headers (`jwk`, `jku`, `x5u`, `x5c`, `crit`, `b64`).
 */
import { compactVerify } from 'jose';
import { createProtocolError, isProtocolError } from './errors.js';
import { b64url, fromB64url, fromUtf8, utf8 } from './encoding.js';

/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').KeyResolver} KeyResolver */

const FORBIDDEN_HEADERS = ['jwk', 'jku', 'x5u', 'x5c', 'x5t', 'x5t#S256', 'crit', 'b64', 'zip'];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {string} segment
 * @returns {Record<string, unknown>}
 */
const parseSegment = (segment) => {
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(fromUtf8(fromB64url(segment)));
	} catch {
		throw createProtocolError('malformed', 'token segment is not base64url JSON');
	}
	if (!isObject(parsed)) throw createProtocolError('malformed', 'token segment is not a JSON object');
	return parsed;
};

/**
 * Split a compact JWS into its three segments, enforcing a length cap.
 * @param {unknown} token
 * @param {number} maxLength
 * @returns {[string, string, string]}
 */
const split = (token, maxLength) => {
	if (typeof token !== 'string' || token.length === 0) throw createProtocolError('malformed', 'token is missing');
	if (token.length > maxLength) throw createProtocolError('malformed', 'token is too long');
	const parts = token.split('.');
	if (parts.length !== 3 || parts.some((part) => part.length === 0))
		throw createProtocolError('malformed', 'token is not a compact JWS');
	return /** @type {[string, string, string]} */ (parts);
};

/**
 * Sign a JSON payload as a compact JWS with header `{ alg: 'EdDSA', kid, typ }`.
 * @param {{ signer: Signer, typ: string, payload: Record<string, unknown> }} params
 * @returns {Promise<string>}
 */
export const signCompact = async ({ signer, typ, payload }) => {
	if (!signer || typeof signer.sign !== 'function' || typeof signer.kid !== 'string') {
		throw createProtocolError('invalid_argument', 'signer must be { kid, sign }');
	}
	const header = b64url(JSON.stringify({ alg: 'EdDSA', kid: signer.kid, typ }));
	const body = b64url(JSON.stringify(payload));
	const input = `${header}.${body}`;
	const signature = await signer.sign(utf8(input));
	return `${input}.${b64url(signature)}`;
};

/**
 * Read a compact JWS payload WITHOUT verifying it. Only for routing (e.g. picking the key resolver of the claimed
 * issuer); never trust the result before `verifyCompact` succeeds.
 * @param {unknown} token
 * @param {number} [maxLength]
 * @returns {Record<string, unknown>}
 */
export const peekPayload = (token, maxLength = 16_384) => parseSegment(split(token, maxLength)[1]);

/**
 * Verify a compact JWS: strict header, expected `typ`, `kid` resolved through the resolver, EdDSA signature.
 * @param {{ token: unknown, keyResolver: KeyResolver, typ: string, maxLength?: number }} params
 * @returns {Promise<{ payload: Record<string, unknown>, kid: string }>}
 */
export const verifyCompact = async ({ token, keyResolver, typ, maxLength = 16_384 }) => {
	if (!keyResolver || typeof keyResolver.resolve !== 'function') {
		throw createProtocolError('invalid_argument', 'keyResolver is required');
	}
	const [headerSegment, payloadSegment] = split(token, maxLength);
	const header = parseSegment(headerSegment);
	if (header.alg !== 'EdDSA') throw createProtocolError('unsupported_alg', 'only EdDSA is accepted');
	if (header.typ !== typ) throw createProtocolError('wrong_type', 'unexpected token type', { expected: typ });
	if (FORBIDDEN_HEADERS.some((name) => name in header)) throw createProtocolError('malformed', 'forbidden JWS header member');
	if (typeof header.kid !== 'string' || header.kid.length === 0) throw createProtocolError('unknown_kid', 'kid is missing');
	const kid = header.kid;
	const key = await keyResolver.resolve(kid);
	try {
		await compactVerify(/** @type {string} */ (token), key, { algorithms: ['EdDSA'] });
	} catch (error) {
		if (isProtocolError(error)) throw error;
		throw createProtocolError('signature', 'signature verification failed', { kid });
	}
	return { payload: parseSegment(payloadSegment), kid };
};

/**
 * Check `iat`/`nbf`/`exp` (seconds) against `nowMs`, with symmetric skew. `exp` is required.
 * @param {{ claims: Record<string, unknown>, nowMs: number, skewSeconds: number, maxLifetimeSeconds?: number, requireIat?: boolean }} params
 * @returns {{ iat: number | undefined, exp: number }}
 */
export const checkTimeClaims = ({ claims, nowMs, skewSeconds, maxLifetimeSeconds, requireIat = true }) => {
	const { iat, nbf, exp } = claims;
	if (typeof exp !== 'number' || !Number.isFinite(exp)) throw createProtocolError('malformed', 'exp is missing');
	if (requireIat && (typeof iat !== 'number' || !Number.isFinite(iat))) throw createProtocolError('malformed', 'iat is missing');
	if (iat !== undefined && typeof iat !== 'number') throw createProtocolError('malformed', 'iat is invalid');
	if (nbf !== undefined && typeof nbf !== 'number') throw createProtocolError('malformed', 'nbf is invalid');
	const seconds = nowMs / 1000;
	if (seconds >= exp + skewSeconds) throw createProtocolError('expired', 'token has expired');
	if (typeof nbf === 'number' && seconds + skewSeconds < nbf)
		throw createProtocolError('not_yet_valid', 'token is not valid yet');
	if (typeof iat === 'number' && seconds + skewSeconds < iat)
		throw createProtocolError('not_yet_valid', 'token was issued in the future');
	if (typeof iat === 'number' && exp <= iat) throw createProtocolError('malformed', 'exp must be after iat');
	if (maxLifetimeSeconds !== undefined && typeof iat === 'number' && exp - iat > maxLifetimeSeconds) {
		throw createProtocolError('lifetime_too_long', 'token lifetime exceeds the maximum');
	}
	return { iat: typeof iat === 'number' ? iat : undefined, exp };
};

/**
 * Current time in whole seconds.
 * @param {() => number} now milliseconds clock
 * @returns {number}
 */
export const nowSeconds = (now) => Math.floor(now() / 1000);

/**
 * Require a non-empty string argument.
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
export const requireString = (value, name) => {
	if (typeof value !== 'string' || value.length === 0) throw createProtocolError('invalid_argument', `${name} is required`);
	return value;
};
