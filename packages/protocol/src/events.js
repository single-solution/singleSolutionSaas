/**
 * Signed event / webhook delivery (Portal → product, product → merchant).
 *
 * Headers:
 *   SS-Timestamp: <unix seconds>
 *   SS-Signature: v1;kid=<kid>;sig=<base64url Ed25519 signature>[, v1;kid=<kid2>;sig=<...>]
 *   SS-Key-Id:    <kid of the first signature>   (informational routing/log hint — never trusted for verification)
 *
 * Signed message (UTF-8): `ss-event.v1.${timestamp}.${hex(sha256(rawBody))}`. The `ss-event.v1.` prefix gives domain
 * separation from JWS signing inputs made with the same key. Hashing the body keeps the signed message small and lets
 * verifiers stream large bodies. Several signatures (comma-separated) let the sender dual-sign during key rotation;
 * the verifier accepts the delivery if any signature verifies under a key it trusts.
 *
 * Verification: timestamp within ±toleranceSec, signature, then replay check on `timestamp + body hash` recorded
 * until the tolerance window closes (a replay after that fails the timestamp check anyway).
 *
 * Event signatures cover the body only, so they are for deliveries to ONE fixed endpoint (the product's declared
 * events endpoint). For Portal→product API calls use `signRequest` / `verifyRequest` (`requests.js`), which also bind
 * method and path.
 */
import { createProtocolError } from './errors.js';
import { sha256Hex, utf8 } from './encoding.js';
import { SIGNATURE_HEADERS, assertBody, checkSigningInputs, readTimestamp, signDetached, verifyDetached } from './detached.js';

/** @import { KeyResolver, Signer } from './keys.js' */
/** @typedef {import('./replay.js').ReplayStore} ReplayStore */
/** @typedef {{ 'SS-Timestamp': string, 'SS-Signature': string, 'SS-Key-Id': string }} EventHeaders */

/** Header names. */
export const EVENT_HEADERS = SIGNATURE_HEADERS;

/**
 * @param {number} timestamp
 * @param {string | Uint8Array} body
 * @returns {Uint8Array}
 */
const signedMessage = (timestamp, body) => utf8(`ss-event.v1.${timestamp}.${sha256Hex(body)}`);

/**
 * Sign an event body.
 * @param {{ signer?: Signer, signers?: Signer[], body: string | Uint8Array, timestamp: number }} params `timestamp` in
 *   unix seconds (take it from your injected clock). Pass `signers` to dual-sign during rotation.
 * @returns {Promise<EventHeaders>}
 */
export const signEvent = async ({ signer, signers, body, timestamp }) => {
	const all = checkSigningInputs({ signer, signers, timestamp });
	assertBody(body);
	return signDetached(all, timestamp, signedMessage(timestamp, body));
};

/**
 * Verify a signed event delivery.
 * @param {{
 *   headers: Record<string, string | string[] | undefined> | Headers, rawBody: string | Uint8Array, keyResolver: KeyResolver,
 *   replayStore: ReplayStore, now?: () => number, toleranceSec?: number,
 * }} params `rawBody` must be the exact bytes received (verify before JSON parsing).
 * @returns {Promise<{ timestamp: number, kid: string, bodySha256: string }>}
 */
export const verifyEvent = async ({ headers, rawBody, keyResolver, replayStore, now = Date.now, toleranceSec = 300 }) => {
	if (!replayStore || typeof replayStore.seen !== 'function') {
		throw createProtocolError('invalid_argument', 'replayStore is required');
	}
	if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
		throw createProtocolError('invalid_argument', 'rawBody is required');
	}
	const timestamp = readTimestamp(headers, now, toleranceSec);
	const kid = await verifyDetached(headers, signedMessage(timestamp, rawBody), keyResolver);
	const bodySha256 = sha256Hex(rawBody);
	if (await replayStore.seen(`event|${timestamp}|${bodySha256}`, (timestamp + toleranceSec) * 1000)) {
		throw createProtocolError('replay', 'event was already delivered');
	}
	return { timestamp, kid, bodySha256 };
};
