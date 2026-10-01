/**
 * Signed manifests: a product serves `GET /.well-known/ss-app.json` with `SS-Manifest-Signature: <compact JWS>`, signed
 * with its registered product key (`typ: ss-manifest+jws`), payload `{ appId, manifestHash, iat }` where `manifestHash`
 * is SHA-256 (hex) of the canonical JSON manifest (`hashManifest`). The Portal verifies it against the product's
 * registered JWKS before importing a refreshed manifest, so a compromised host or CDN cannot swap the manifest without
 * the product key.
 * @module
 */
import { createProtocolError } from './errors.js';
import { isObject, nowSeconds, requireString, signCompact, verifyCompact } from './jws.js';
import { hashManifest } from './registration.js';

/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').KeyResolver} KeyResolver */
/** @typedef {{ appId: string, manifestHash: string, iat: number }} ManifestSignatureClaims */

/** JOSE `typ` of manifest signatures. */
export const MANIFEST_TYP = 'ss-manifest+jws';
/** Response header carrying the manifest signature. */
export const MANIFEST_SIGNATURE_HEADER = 'SS-Manifest-Signature';
/** Default maximum signature age (seconds) accepted by `verifyManifest`. */
export const DEFAULT_MANIFEST_MAX_AGE_SECONDS = 86_400;

/**
 * Sign a manifest.
 * @param {{ signer: Signer, manifest: unknown, appId: string, iat?: number, now?: () => number }} params `iat` in
 *   seconds (default: now)
 * @returns {Promise<string>} compact JWS
 */
export const signManifest = async ({ signer, manifest, appId, iat, now = Date.now }) => {
	requireString(appId, 'appId');
	const issuedAt = iat ?? nowSeconds(now);
	if (!Number.isInteger(issuedAt) || issuedAt < 0) throw createProtocolError('invalid_argument', 'iat must be integer seconds');
	/** @type {ManifestSignatureClaims} */
	const payload = { appId, manifestHash: hashManifest(manifest), iat: issuedAt };
	return signCompact({ signer, typ: MANIFEST_TYP, payload });
};

/**
 * Verify a manifest signature: `typ`, EdDSA signature under a key of `keyResolver` (the product's registered JWKS),
 * `appId === expectedAppId`, `manifestHash` equals the served manifest, and `iat` not older than `maxAgeSec` (nor in the
 * future beyond `skewSeconds`).
 * @param {{ manifest: unknown, jws: unknown, keyResolver: KeyResolver, expectedAppId: string, now?: () => number,
 *   maxAgeSec?: number, skewSeconds?: number }} params
 * @returns {Promise<ManifestSignatureClaims & { kid: string }>}
 */
export const verifyManifest = async ({
	manifest,
	jws,
	keyResolver,
	expectedAppId,
	now = Date.now,
	maxAgeSec = DEFAULT_MANIFEST_MAX_AGE_SECONDS,
	skewSeconds = 300,
}) => {
	requireString(expectedAppId, 'expectedAppId');
	if (!Number.isFinite(maxAgeSec) || maxAgeSec <= 0) throw createProtocolError('invalid_argument', 'maxAgeSec must be > 0');
	const { payload, kid } = await verifyCompact({ token: jws, keyResolver, typ: MANIFEST_TYP, maxLength: 4096 });
	const { appId, manifestHash, iat } = payload;
	if (typeof appId !== 'string' || typeof manifestHash !== 'string' || typeof iat !== 'number' || !Number.isFinite(iat))
		throw createProtocolError('malformed', 'manifest signature claims are incomplete');
	if (appId !== expectedAppId) throw createProtocolError('issuer', 'manifest is signed for another app');
	/** @type {string} */
	let actual;
	try {
		actual = hashManifest(manifest);
	} catch {
		throw createProtocolError('malformed', 'manifest must be JSON');
	}
	if (!isObject(manifest) || manifestHash !== actual)
		throw createProtocolError('signature', 'manifest does not match the signed hash');
	const seconds = now() / 1000;
	if (iat > seconds + skewSeconds) throw createProtocolError('not_yet_valid', 'manifest signature was issued in the future');
	if (seconds - iat > maxAgeSec) throw createProtocolError('expired', 'manifest signature is too old');
	return { appId, manifestHash, iat, kid };
};
