/**
 * Client assertions: product → Portal authentication (RFC 7523 style, EdDSA, `typ: ss-assertion+jwt`).
 *
 * `iss = sub = appId`, `aud` = the Portal endpoint/issuer, fresh `jti`, `iat`, `exp` with `exp - iat ≤ 300 s`. The
 * Portal picks the app's registered keys from the claimed `iss`, verifies, then records `iss|jti` in a shared replay
 * store until expiry so a captured assertion cannot be reused. See `replay.js` for the store interface.
 */
import { createProtocolError } from './errors.js';
import { defaultRandomBytes, randomId } from './encoding.js';
import { checkTimeClaims, nowSeconds, peekPayload, requireString, signCompact, verifyCompact } from './jws.js';

export { createMemoryReplayStore } from './replay.js';

/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').KeyResolver} KeyResolver */
/** @typedef {import('./replay.js').ReplayStore} ReplayStore */
/** @typedef {{ iss: string, sub: string, aud: string, jti: string, iat: number, exp: number }} AssertionClaims */

/** JOSE `typ` of client assertions. */
export const ASSERTION_TYP = 'ss-assertion+jwt';
/** Maximum assertion lifetime (seconds). */
export const MAX_ASSERTION_LIFETIME_SECONDS = 300;

/**
 * Sign a client assertion.
 * @param {{ signer: Signer, appId: string, audience: string, ttlSeconds?: number, jti?: string, now?: () => number,
 *   randomBytes?: (length: number) => Uint8Array }} params
 * @returns {Promise<string>}
 */
export const signAssertion = async ({
	signer,
	appId,
	audience,
	ttlSeconds = 60,
	jti,
	now = Date.now,
	randomBytes = defaultRandomBytes,
}) => {
	requireString(appId, 'appId');
	requireString(audience, 'audience');
	if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_ASSERTION_LIFETIME_SECONDS) {
		throw createProtocolError('invalid_argument', `ttlSeconds must be 1..${MAX_ASSERTION_LIFETIME_SECONDS}`);
	}
	const iat = nowSeconds(now);
	/** @type {AssertionClaims} */
	const claims = { iss: appId, sub: appId, aud: audience, jti: jti ?? randomId(randomBytes), iat, exp: iat + ttlSeconds };
	return signCompact({ signer, typ: ASSERTION_TYP, payload: claims });
};

/**
 * Verify a client assertion and record its jti.
 * @param {{
 *   token: unknown,
 *   keyResolverForApp: (appId: string) => KeyResolver | null | undefined | Promise<KeyResolver | null | undefined>,
 *   audience: string, replayStore: ReplayStore, now?: () => number, skewSeconds?: number,
 * }} params `keyResolverForApp` returns the resolver over the app's registered keys, or null for unknown apps.
 * @returns {Promise<{ appId: string, claims: AssertionClaims }>}
 */
export const verifyAssertion = async ({ token, keyResolverForApp, audience, replayStore, now = Date.now, skewSeconds = 30 }) => {
	requireString(audience, 'audience');
	if (!replayStore || typeof replayStore.seen !== 'function')
		throw createProtocolError('invalid_argument', 'replayStore is required');
	const claimed = peekPayload(token).iss;
	if (typeof claimed !== 'string' || claimed.length === 0) throw createProtocolError('issuer', 'iss is missing');
	const keyResolver = await keyResolverForApp(claimed);
	if (!keyResolver) throw createProtocolError('issuer', 'unknown app');
	const { payload } = await verifyCompact({ token, keyResolver, typ: ASSERTION_TYP });
	if (payload.iss !== claimed) throw createProtocolError('issuer', 'issuer mismatch');
	if (payload.sub !== claimed) throw createProtocolError('subject', 'sub must equal iss');
	if (payload.aud !== audience) throw createProtocolError('audience', 'assertion is not for this audience');
	if (typeof payload.jti !== 'string' || payload.jti.length < 16 || payload.jti.length > 256) {
		throw createProtocolError('malformed', 'jti must be 16..256 characters');
	}
	const { exp } = checkTimeClaims({
		claims: payload,
		nowMs: now(),
		skewSeconds,
		maxLifetimeSeconds: MAX_ASSERTION_LIFETIME_SECONDS,
	});
	if (await replayStore.seen(`assertion|${claimed}|${payload.jti}`, (exp + skewSeconds) * 1000)) {
		throw createProtocolError('replay', 'assertion was already used');
	}
	return { appId: claimed, claims: /** @type {AssertionClaims} */ (/** @type {unknown} */ (payload)) };
};
