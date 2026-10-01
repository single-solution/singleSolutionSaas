/**
 * Signed Portal → product HTTP requests.
 *
 * Event signatures (`events.js`) cover only the body, so a captured signed body could be replayed to a different
 * endpoint (or with a different method) inside the tolerance window. Request signatures bind the whole request:
 *
 *   signed message (UTF-8) = `ss-request.v1.${timestamp}.${METHOD}.${audience}.${canonicalPath}.${hex(sha256(body))}`
 *
 * - `ss-request.v1.` differs from the event prefix `ss-event.v1.`, so neither signature verifies as the other.
 * - `audience` names the receiving product (its appId), so a product cannot replay a Portal request it received to
 *   another product that trusts the same Portal key. It may not contain `/`, which keeps the message unambiguous
 *   (`canonicalPath` always starts with `/`, the body hash is a fixed 64 hex characters).
 * - `canonicalPath`: see `canonicalRequestPath`.
 *
 * Headers are the same as for events: `SS-Timestamp`, `SS-Signature: v1;kid=…;sig=…[, …]`, `SS-Key-Id` (hint only).
 * Replay key: `timestamp | METHOD | audience | canonicalPath | body hash`, kept until the tolerance window closes.
 *
 * Verify with the path exactly as the product received it (`req.url`, path + query). If a proxy rewrites paths, verify
 * the path the Portal addressed, not the rewritten one.
 */
import { createProtocolError } from './errors.js';
import { sha256Hex, utf8 } from './encoding.js';
import { assertBody, checkSigningInputs, readTimestamp, signDetached, verifyDetached } from './detached.js';

/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').KeyResolver} KeyResolver */
/** @typedef {import('./replay.js').ReplayStore} ReplayStore */
/** @typedef {{ 'SS-Timestamp': string, 'SS-Signature': string, 'SS-Key-Id': string }} RequestHeaders */

const PARSE_BASE = 'http://canonical.invalid';
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Upper-case percent-escape hex digits and decode escapes of unreserved characters (RFC 3986 §6.2.2).
 * @param {string} value
 * @returns {string}
 */
const normalizeEscapes = (value) =>
	value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex) => {
		const char = String.fromCharCode(parseInt(hex, 16));
		return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
	});

/**
 * RFC 3986 strict component encoding (also escapes `!'()*`).
 * @param {string} value
 * @returns {string}
 */
const encodeComponent = (value) =>
	encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Canonicalise a request target (path + optional query).
 *  - must start with a single `/` (no scheme, no authority, no fragment, no whitespace/control characters/backslash);
 *  - dot segments are resolved and the path is percent-encoded per the WHATWG URL parser, then escape hex is
 *    upper-cased and unreserved escapes are decoded;
 *  - query parameters are decoded, sorted by name then value (UTF-16 code units, duplicates kept) and re-encoded with
 *    strict RFC 3986 encoding; `a=1&b=2`, `b=2&a=1` and `b=2&a=%31` are the same request; an empty query is dropped.
 * @param {unknown} path
 * @returns {string}
 */
export const canonicalRequestPath = (path) => {
	if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > 8192) {
		throw createProtocolError('invalid_argument', 'path must be an absolute path starting with a single /');
	}
	for (let i = 0; i < path.length; i += 1) {
		const code = path.charCodeAt(i);
		if (code <= 0x20 || code === 0x7f || code === 0x5c || code === 0x23) {
			throw createProtocolError('invalid_argument', 'path contains a forbidden character');
		}
	}
	const url = new URL(path, PARSE_BASE);
	if (url.origin !== PARSE_BASE) throw createProtocolError('invalid_argument', 'path must not carry an authority');
	const pairs = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
		ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
	);
	const query = pairs.map(([key, value]) => `${encodeComponent(key)}=${encodeComponent(value)}`).join('&');
	return `${normalizeEscapes(url.pathname)}${query ? `?${query}` : ''}`;
};

/**
 * @param {unknown} method
 * @returns {string}
 */
const canonicalMethod = (method) => {
	const upper = typeof method === 'string' ? method.toUpperCase() : '';
	if (!/^[A-Z]{1,16}$/.test(upper)) throw createProtocolError('invalid_argument', 'method is invalid');
	return upper;
};

/**
 * @param {unknown} audience
 * @returns {string}
 */
const checkAudience = (audience) => {
	if (typeof audience !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(audience)) {
		throw createProtocolError('invalid_argument', 'audience must be an appId-like identifier (no /)');
	}
	return audience;
};

/**
 * @param {number} timestamp
 * @param {string} method
 * @param {string} audience
 * @param {string} path canonical
 * @param {string} bodyHash
 * @returns {Uint8Array}
 */
const signedMessage = (timestamp, method, audience, path, bodyHash) =>
	utf8(`ss-request.v1.${timestamp}.${method}.${audience}.${path}.${bodyHash}`);

/**
 * Sign an outgoing Portal → product request.
 * @param {{ signer?: Signer, signers?: Signer[], method: string, path: string, audience: string,
 *   body?: string | Uint8Array, timestamp: number }} params `path` includes the query; `audience` is the receiving
 *   product's appId; `body` defaults to empty; `timestamp` in unix seconds from your injected clock.
 * @returns {Promise<RequestHeaders>}
 */
export const signRequest = async ({ signer, signers, method, path, audience, body = '', timestamp }) => {
	const all = checkSigningInputs({ signer, signers, timestamp });
	assertBody(body);
	const message = signedMessage(
		timestamp,
		canonicalMethod(method),
		checkAudience(audience),
		canonicalRequestPath(path),
		sha256Hex(body),
	);
	return signDetached(all, timestamp, message);
};

/**
 * Verify an incoming signed request.
 * @param {{
 *   method: string, path: string, audience: string, headers: Record<string, string | string[] | undefined> | Headers,
 *   rawBody?: string | Uint8Array, keyResolver: KeyResolver, replayStore: ReplayStore, now?: () => number,
 *   toleranceSec?: number,
 * }} params `path` is the received path + query; `audience` is this product's own appId; `rawBody` the exact bytes
 *   received (empty when absent).
 * @returns {Promise<{ timestamp: number, kid: string, method: string, path: string, bodySha256: string }>}
 */
export const verifyRequest = async ({
	method,
	path,
	audience,
	headers,
	rawBody = '',
	keyResolver,
	replayStore,
	now = Date.now,
	toleranceSec = 300,
}) => {
	if (!replayStore || typeof replayStore.seen !== 'function') {
		throw createProtocolError('invalid_argument', 'replayStore is required');
	}
	assertBody(rawBody);
	const canonicalMethodValue = canonicalMethod(method);
	const aud = checkAudience(audience);
	const canonicalPath = canonicalRequestPath(path);
	const timestamp = readTimestamp(headers, now, toleranceSec);
	const bodySha256 = sha256Hex(rawBody);
	const kid = await verifyDetached(
		headers,
		signedMessage(timestamp, canonicalMethodValue, aud, canonicalPath, bodySha256),
		keyResolver,
	);
	const replayId = `request|${timestamp}|${canonicalMethodValue}|${aud}|${canonicalPath}|${bodySha256}`;
	if (await replayStore.seen(replayId, (timestamp + toleranceSec) * 1000)) {
		throw createProtocolError('replay', 'request was already received');
	}
	return { timestamp, kid, method: canonicalMethodValue, path: canonicalPath, bodySha256 };
};
