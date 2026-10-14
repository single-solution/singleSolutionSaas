/**
 * Portal calls: requests the Portal itself makes to a product for one website (the Setup sheet reads each product's
 * `GET /v1/blueprint`), signed with the Portal key the product pinned at connect, like notices.
 *
 * Headers:
 *   SS-Timestamp: <unix seconds>
 *   SS-Nonce:     <base64url of 16 random bytes>
 *   SS-Signature: v1;kid=<kid>;sig=<base64url Ed25519 signature>[, v1;kid=<kid2>;sig=<...>]
 *   SS-Key-Id:    <kid of the first signature>   (a hint only; never trusted for verification)
 *
 * Signed message (UTF-8, lines joined by `\n`): `ss-call.v1`, the timestamp, the nonce, the product id the call is for
 * (its audience), the method in upper case, the target (path and query exactly as sent) and the hex SHA-256 of the raw
 * body (the empty body for a GET). The prefix separates call signatures from notice signatures and JWS signing inputs
 * made with the same Portal key; the audience keeps a call to one product from being replayed to another; a newline
 * cannot appear in any field, so no two calls share a message.
 *
 * Verification: timestamp within ±toleranceSec, signature over the request's own method, target and body, then the
 * replay check on the nonce (recorded until the tolerance window closes).
 * @module
 */
import { createProtocolError } from './errors.js';
import { defaultRandomBytes, getHeader, randomId, sha256Hex, utf8 } from './encoding.js';
import { assertBody, checkSigningInputs, readTimestamp, signDetached, verifyDetached } from './detached.js';
import { isProductId } from './tokens.js';

/** @import { KeyResolver, Signer } from './keys.js' */
/** @typedef {import('./assertion.js').ReplayStore} ReplayStore */
/** @typedef {import('./detached.js').HeaderBag} HeaderBag */
/** @typedef {{ 'SS-Timestamp': string, 'SS-Nonce': string, 'SS-Signature': string, 'SS-Key-Id': string }} CallHeaders */

/** Default accepted clock difference, seconds. */
const CALL_TOLERANCE_SECONDS = 300;
const METHOD = /^[A-Z]{3,7}$/;
/** A path starting with `/`, with an optional query; no spaces, control characters or fragment. */
const TARGET = /^\/[\x21-\x7e]*$/;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const MAX_TARGET_LENGTH = 4096;

/**
 * @param {{ timestamp: number, nonce: string, audience: string, method: string, target: string, body: string | Uint8Array }} parts
 * @returns {Uint8Array}
 */
const signedMessage = ({ timestamp, nonce, audience, method, target, body }) =>
	utf8(['ss-call.v1', String(timestamp), nonce, audience, method, target, sha256Hex(body)].join('\n'));

/**
 * Check the parts both sides sign.
 * @param {{ audience: unknown, method: unknown, target: unknown }} parts
 * @returns {{ audience: string, method: string, target: string }}
 */
const checkCall = ({ audience, method, target }) => {
	if (!isProductId(audience)) throw createProtocolError('invalid_argument', 'audience must be a product id');
	if (typeof method !== 'string' || !METHOD.test(method))
		throw createProtocolError('invalid_argument', 'method must be an upper-case HTTP method');
	if (typeof target !== 'string' || target.length > MAX_TARGET_LENGTH || !TARGET.test(target) || target.includes('#'))
		throw createProtocolError('invalid_argument', 'target must be a path with an optional query');
	return { audience, method, target };
};

/**
 * Sign a call to a product (Portal side).
 * @param {{ signer?: Signer, signers?: Signer[], audience: string, method: string, target: string,
 *   body?: string | Uint8Array, timestamp: number, randomBytes?: (length: number) => Uint8Array }} params `audience`:
 *   the product id; `target`: the path and query exactly as sent; `timestamp` in unix seconds (from the injected clock).
 *   Pass `signers` to dual-sign while rotating keys.
 * @returns {Promise<CallHeaders>}
 */
export const signPortalCall = async ({
	signer,
	signers,
	audience,
	method,
	target,
	body = '',
	timestamp,
	randomBytes = defaultRandomBytes,
}) => {
	const all = checkSigningInputs({ signer, signers, timestamp });
	assertBody(body);
	const call = checkCall({ audience, method, target });
	const nonce = randomId(randomBytes);
	const headers = await signDetached(all, timestamp, signedMessage({ ...call, timestamp, nonce, body }));
	return {
		'SS-Timestamp': headers['SS-Timestamp'],
		'SS-Nonce': nonce,
		'SS-Signature': headers['SS-Signature'],
		'SS-Key-Id': headers['SS-Key-Id'],
	};
};

/**
 * Verify a call from the Portal (product side). Throws a `ProtocolError` unless it is fresh, signed by a pinned Portal
 * key for this product, method, target and body, and not seen before.
 * @param {{ headers: HeaderBag, audience: string, method: string, target: string, rawBody?: string | Uint8Array,
 *   keyResolver: KeyResolver, replayStore: ReplayStore, now?: () => number, toleranceSec?: number }} params `audience`:
 *   this product's id; `target`: the request's path and query as received; `keyResolver` over the pinned Portal keys
 * @returns {Promise<{ kid: string, timestamp: number }>}
 */
export const verifyPortalCall = async ({
	headers,
	audience,
	method,
	target,
	rawBody = '',
	keyResolver,
	replayStore,
	now = Date.now,
	toleranceSec = CALL_TOLERANCE_SECONDS,
}) => {
	if (!replayStore || typeof replayStore.seen !== 'function')
		throw createProtocolError('invalid_argument', 'replayStore is required');
	assertBody(rawBody);
	const call = checkCall({ audience, method, target });
	const timestamp = readTimestamp(headers, now, toleranceSec);
	const nonce = getHeader(headers, 'SS-Nonce');
	if (!nonce || !NONCE.test(nonce)) throw createProtocolError('malformed', 'SS-Nonce is missing or invalid');
	const kid = await verifyDetached(headers, signedMessage({ ...call, timestamp, nonce, body: rawBody }), keyResolver);
	if (await replayStore.seen(`call|${nonce}`, (timestamp + toleranceSec) * 1000))
		throw createProtocolError('replay', 'call was already made');
	return { kid, timestamp };
};
