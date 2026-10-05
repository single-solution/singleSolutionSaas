/**
 * One-time-token registration handshake (Portal ↔ product).
 *
 * The product is deployed with the SHA-256 hash of a one-time registration token and a pinned Portal URL. The
 * developer pastes the plain token into the Portal once. The Portal then calls the product's register endpoint with
 * `Authorization: Bearer <token>` and a body that is a JWS signed with the Portal's key. The product accepts only if:
 *   1. the token has not been burned,
 *   2. the bearer token hashes to the stored hash (constant-time),
 *   3. the Portal's signature verifies against the JWKS fetched from the PINNED Portal URL (never a URL from the body),
 *   4. the signed `portalUrl` equals the pinned URL,
 *   5. `iat` is within ±5 min, 6. the signed token hash (`tth`) matches the bearer token, 7. `aud` matches (if set),
 *   8. the nonce is unused, and 9. the token is burned atomically (a concurrent second request loses).
 * Then it calls `onRegistered` and answers with its manifest, its public key and a proof-of-possession JWS
 * (`typ: ss-registration-response+jws`) signed with the matching private key over
 * `{ appId?, manifestHash, jkt, nonce, portalUrl, iat }`. Every failure returns the same generic
 * `401 { error: 'unauthorized' }`; the precise cause is in `reason` for server-side logs only.
 *
 * The Portal checks the response with `verifyRegistrationResponse`: signature under the included public key, RFC 7638
 * thumbprint, nonce echo, portal URL, manifest hash (SHA-256 of canonical JSON) and freshness. This proves the product
 * holds the private key for the key it registers and that the manifest was not swapped in transit or by a proxy.
 */
import { createProtocolError, isProtocolError } from './errors.js';
import { canonicalJson, constantTimeEqual, defaultRandomBytes, getHeader, randomId, sha256Hex } from './encoding.js';
import { createKeyResolver, importPublicKey, thumbprint, toPublicJwk } from './keys.js';
import { isObject, nowSeconds, requireString, signCompact, verifyCompact } from './jws.js';

/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').PublicJwk} PublicJwk */
/** @typedef {import('./replay.js').ReplayStore} ReplayStore */
/**
 * @typedef {{ portalUrl: string, portalJwksUrl?: string, nonce: string, iat: number, exp: number, tth: string, aud?: string,
 *   appId?: string }} RegistrationClaims
 */
/** @typedef {{ status: number, body: Record<string, unknown>, reason?: string }} RegistrationResult */
/**
 * @typedef {{ appId?: string, manifestHash: string, jkt: string, nonce: string, portalUrl: string, iat: number }} RegistrationProofClaims
 */

/** JOSE `typ` of the product's proof-of-possession response. */
export const REGISTRATION_RESPONSE_TYP = 'ss-registration-response+jws';

/**
 * SHA-256 (hex) of the canonical JSON of a manifest.
 * @param {unknown} manifest
 * @returns {string}
 */
export const hashManifest = (manifest) => {
	try {
		return sha256Hex(canonicalJson(manifest));
	} catch {
		throw createProtocolError('invalid_argument', 'manifest must be JSON-serialisable');
	}
};

/** JOSE `typ` of registration requests. */
export const REGISTRATION_TYP = 'ss-registration+jws';
const TOLERANCE_SECONDS = 300;

/**
 * Hash a registration token for storage at rest (tokens are ≥ 128-bit random, so plain SHA-256 suffices).
 * @param {string} token
 * @returns {string} hex
 */
export const hashRegistrationToken = (token) => sha256Hex(requireString(token, 'token'));

/**
 * Canonicalise a URL for pinning comparisons (lower-case scheme/host, default port dropped, no trailing slash, no
 * query/fragment/userinfo allowed).
 * @param {unknown} value
 * @returns {string}
 */
export const canonicalUrl = (value) => {
	if (typeof value !== 'string') throw createProtocolError('invalid_argument', 'URL must be a string');
	/** @type {URL} */
	let url;
	try {
		url = new URL(value);
	} catch {
		throw createProtocolError('invalid_argument', 'URL is invalid');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		throw createProtocolError('invalid_argument', 'URL must be http(s)');
	if (url.username || url.password || url.search || url.hash) throw createProtocolError('invalid_argument', 'URL must be plain');
	return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
};

/**
 * Portal side: build the registration request. The registration token is used for the header only and not retained.
 * @param {{ portalUrl: string, portalJwksUrl?: string, signer: Signer, registrationToken: string, nonce?: string,
 *   audience?: string, appId?: string, now?: () => number, randomBytes?: (length: number) => Uint8Array }} params
 *   `audience` is the product's register endpoint or base URL; `portalJwksUrl` is informational only.
 * @returns {Promise<{ headers: Record<string, string>, body: string, nonce: string }>} keep `nonce` to pass as
 *   `expectedNonce` to `verifyRegistrationResponse`.
 */
export const createRegistrationRequest = async ({
	portalUrl,
	portalJwksUrl,
	signer,
	registrationToken,
	nonce,
	audience,
	appId,
	now = Date.now,
	randomBytes = defaultRandomBytes,
}) => {
	requireString(registrationToken, 'registrationToken');
	const iat = nowSeconds(now);
	/** @type {RegistrationClaims} */
	const claims = {
		portalUrl: canonicalUrl(portalUrl),
		nonce: nonce ?? randomId(randomBytes),
		iat,
		exp: iat + TOLERANCE_SECONDS,
		tth: hashRegistrationToken(registrationToken),
	};
	if (portalJwksUrl !== undefined) claims.portalJwksUrl = canonicalUrl(portalJwksUrl);
	if (audience !== undefined) claims.aud = audience;
	if (appId !== undefined) claims.appId = appId;
	const request = await signCompact({ signer, typ: REGISTRATION_TYP, payload: claims });
	return {
		headers: { Authorization: `Bearer ${registrationToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ request }),
		nonce: claims.nonce,
	};
};

/**
 * @param {string} reason
 * @returns {RegistrationResult}
 */
const deny = (reason) => ({ status: 401, body: { error: 'unauthorized' }, reason });

/**
 * Product side: create the registration endpoint handler.
 * @param {{
 *   registrationTokenHash: string,
 *   allowedPortalUrl: string,
 *   allowedPortalJwksUrl?: string,
 *   fetchJwks: (url: string) => Promise<unknown>,
 *   manifest: unknown,
 *   productPublicJwk: PublicJwk,
 *   productSigner: Signer,
 *   onRegistered: (registration: { portalUrl: string, appId?: string, portalKid: string, nonce: string, registeredAt: number }) => unknown,
 *   burnToken: () => boolean | Promise<boolean>,
 *   isTokenBurned?: () => boolean | Promise<boolean>,
 *   nonceStore: ReplayStore,
 *   expectedAudience?: string,
 *   now?: () => number,
 * }} options `registrationTokenHash` = `hashRegistrationToken(token)`; `burnToken` must atomically mark the token used
 *   and return `false` if it already was; `allowedPortalJwksUrl` defaults to `<allowedPortalUrl>/.well-known/jwks.json`
 *   and must share the pinned origin; `productSigner` holds the private key of `productPublicJwk` (same `kid`) and
 *   signs the proof-of-possession response.
 * @returns {{ handle: (request: { headers: Record<string, string | string[] | undefined> | Headers, body: unknown }) => Promise<RegistrationResult> }}
 */
export const createRegistrationHandler = ({
	registrationTokenHash,
	allowedPortalUrl,
	allowedPortalJwksUrl,
	fetchJwks,
	manifest,
	productPublicJwk,
	productSigner,
	onRegistered,
	burnToken,
	isTokenBurned = () => false,
	nonceStore,
	expectedAudience,
	now = Date.now,
}) => {
	if (typeof registrationTokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(registrationTokenHash)) {
		throw createProtocolError('invalid_argument', 'registrationTokenHash must be a SHA-256 hex digest');
	}
	for (const [name, fn] of Object.entries({ fetchJwks, onRegistered, burnToken })) {
		if (typeof fn !== 'function') throw createProtocolError('invalid_argument', `${name} is required`);
	}
	if (!nonceStore || typeof nonceStore.seen !== 'function')
		throw createProtocolError('invalid_argument', 'nonceStore is required');
	const publicJwk = toPublicJwk(productPublicJwk); // strips any private member, so `d` can never be sent
	if (!productSigner || typeof productSigner.sign !== 'function' || productSigner.kid !== publicJwk.kid) {
		throw createProtocolError('invalid_argument', 'productSigner must sign with the kid of productPublicJwk');
	}
	const manifestHash = hashManifest(manifest);
	const jktPromise = thumbprint(publicJwk);
	const pinnedPortal = canonicalUrl(allowedPortalUrl);
	const pinnedJwks = canonicalUrl(allowedPortalJwksUrl ?? `${pinnedPortal}/.well-known/jwks.json`);
	if (new URL(pinnedJwks).origin !== new URL(pinnedPortal).origin) {
		throw createProtocolError('invalid_argument', 'allowedPortalJwksUrl must be on the pinned Portal origin');
	}

	/** @param {{ headers: Record<string, string | string[] | undefined> | Headers, body: unknown }} request */
	const handle = async ({ headers, body }) => {
		try {
			if (await isTokenBurned()) return deny('token_burned');
			const match = /^Bearer ([\x21-\x7e]{16,512})$/.exec(getHeader(headers, 'authorization') ?? '');
			const presented = match?.[1];
			if (!presented || !constantTimeEqual(hashRegistrationToken(presented), registrationTokenHash))
				return deny('token_invalid');

			/** @type {unknown} */
			let parsed = body;
			if (typeof body === 'string') {
				try {
					parsed = JSON.parse(body);
				} catch {
					return deny('body_malformed');
				}
			}
			if (!isObject(parsed) || typeof parsed.request !== 'string') return deny('body_malformed');

			// Keys come ONLY from the pinned Portal JWKS URL; any URL in the body is ignored.
			const keyResolver = createKeyResolver({ fetchJwks: () => fetchJwks(pinnedJwks), now });
			/** @type {{ payload: Record<string, unknown>, kid: string }} */
			let verified;
			try {
				verified = await verifyCompact({ token: parsed.request, keyResolver, typ: REGISTRATION_TYP });
			} catch (error) {
				return deny(`signature:${isProtocolError(error) ? error.code : 'error'}`);
			}
			const { payload, kid } = verified;

			/** @type {string | null} */
			let claimedPortal = null;
			try {
				claimedPortal = canonicalUrl(payload.portalUrl);
			} catch {
				// handled below
			}
			if (claimedPortal !== pinnedPortal) return deny('portal_url');
			const iat = payload.iat;
			if (typeof iat !== 'number' || Math.abs(now() / 1000 - iat) > TOLERANCE_SECONDS) return deny('timestamp');
			if (typeof payload.tth !== 'string' || !constantTimeEqual(payload.tth, registrationTokenHash))
				return deny('token_binding');
			if (expectedAudience !== undefined && payload.aud !== expectedAudience) return deny('audience');
			const nonce = payload.nonce;
			if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 256) return deny('nonce_invalid');
			if (await nonceStore.seen(`registration|${nonce}`, (iat + 2 * TOLERANCE_SECONDS) * 1000)) return deny('nonce_reused');
			/** @type {RegistrationProofClaims} */
			const proofClaims = { manifestHash, jkt: await jktPromise, nonce, portalUrl: pinnedPortal, iat: nowSeconds(now) };
			if (typeof payload.appId === 'string') proofClaims.appId = payload.appId;
			const proof = await signCompact({ signer: productSigner, typ: REGISTRATION_RESPONSE_TYP, payload: proofClaims });
			if (!(await burnToken())) return deny('token_burned');

			try {
				await onRegistered({
					portalUrl: pinnedPortal,
					...(typeof payload.appId === 'string' ? { appId: payload.appId } : {}),
					portalKid: kid,
					nonce,
					registeredAt: now(),
				});
			} catch {
				// the token stays burned: a fresh token must be issued for a retry
				return { status: 500, body: { error: 'registration_failed' }, reason: 'on_registered_failed' };
			}
			return { status: 200, body: { manifest, publicJwk, proof } };
		} catch {
			return deny('internal_error');
		}
	};

	return Object.freeze({ handle });
};

/**
 * Portal side: verify the product's registration response (proof of possession).
 *
 * Checks, in order: shape; the included `publicJwk` is a valid Ed25519 public key; `proof` verifies under exactly that
 * key (header `kid` must equal the JWK's kid, `typ: ss-registration-response+jws`); `jkt` equals the JWK thumbprint;
 * `nonce` echoes the request nonce; `portalUrl` equals ours; `manifestHash` equals SHA-256 of the canonical manifest;
 * `iat` within ±5 min; `appId` matches when `expectedAppId` is given.
 * @param {{ response: unknown, expectedNonce: string, expectedPortalUrl: string, expectedAppId?: string, now?: () => number }} params
 *   `response` is the parsed JSON body returned by the product.
 * @returns {Promise<{ manifest: unknown, publicJwk: PublicJwk, thumbprint: string, appId?: string }>}
 */
export const verifyRegistrationResponse = async ({
	response,
	expectedNonce,
	expectedPortalUrl,
	expectedAppId,
	now = Date.now,
}) => {
	requireString(expectedNonce, 'expectedNonce');
	const portalUrl = canonicalUrl(expectedPortalUrl);
	if (!isObject(response) || typeof response.proof !== 'string' || !('manifest' in response)) {
		throw createProtocolError('malformed', 'registration response must carry manifest, publicJwk and proof');
	}
	/** @type {PublicJwk} */
	let publicJwk;
	try {
		publicJwk = toPublicJwk(response.publicJwk);
	} catch {
		throw createProtocolError('malformed', 'registration response publicJwk is invalid');
	}
	const key = await importPublicKey(publicJwk);
	const keyResolver = {
		/** @param {string} kid */
		resolve: async (kid) => {
			if (kid !== publicJwk.kid) throw createProtocolError('unknown_kid', 'proof is not signed by the registered key');
			return key;
		},
	};
	const { payload } = await verifyCompact({ token: response.proof, keyResolver, typ: REGISTRATION_RESPONSE_TYP });
	const jkt = await thumbprint(publicJwk);
	if (payload.jkt !== jkt) throw createProtocolError('signature', 'proof thumbprint does not match publicJwk');
	if (typeof payload.nonce !== 'string' || !constantTimeEqual(payload.nonce, expectedNonce)) {
		throw createProtocolError('replay', 'proof does not echo the request nonce');
	}
	if (payload.portalUrl !== portalUrl) throw createProtocolError('audience', 'proof is for another Portal');
	/** @type {string} */
	let manifestHash;
	try {
		manifestHash = hashManifest(response.manifest);
	} catch {
		throw createProtocolError('malformed', 'manifest is not JSON-serialisable');
	}
	if (payload.manifestHash !== manifestHash) throw createProtocolError('signature', 'manifest does not match the signed hash');
	const iat = payload.iat;
	if (typeof iat !== 'number' || !Number.isFinite(iat)) throw createProtocolError('malformed', 'iat is missing');
	const age = now() / 1000 - iat;
	if (age > TOLERANCE_SECONDS) throw createProtocolError('expired', 'proof is stale');
	if (age < -TOLERANCE_SECONDS) throw createProtocolError('not_yet_valid', 'proof is from the future');
	if (payload.appId !== undefined && typeof payload.appId !== 'string')
		throw createProtocolError('malformed', 'appId is invalid');
	if (expectedAppId !== undefined && payload.appId !== expectedAppId)
		throw createProtocolError('subject', 'proof is for another app');
	return {
		manifest: response.manifest,
		publicJwk,
		thumbprint: jkt,
		...(typeof payload.appId === 'string' ? { appId: payload.appId } : {}),
	};
};
