/**
 * Connection-code onboarding (product ↔ Portal).
 *
 * Portal staff add a product and get a one-time **connection code** (`ssc_…`): an opaque string that carries the Portal
 * URL and a random one-time token. The Portal stores only the token's SHA-256. The owner pastes the code into the
 * product's `/setup` page; the product then
 *   1. generates its own Ed25519 key,
 *   2. calls `POST <portalUrl>/v1/apps/connect` with `Authorization: Bearer <token>` and a body
 *      `{ request, publicJwk, manifest }`, where `request` is a JWS (`typ: ss-connect+jws`) signed with the NEW key over
 *      `{ portalUrl, baseUrl, tth, manifestHash, jkt, nonce, iat }` — proof of possession of the key, bound to the token,
 *      the manifest and the base URL the product is set up on;
 *   3. the Portal (`verifyConnectRequest`) checks the token hash, the signature under the included key, the thumbprint,
 *      its own URL, the manifest hash and freshness, burns the token atomically, pins `baseUrl` and the key, and answers
 *      `createConnectResponse`: `{ appId, jwks, response }`, `response` being a JWS (`typ: ss-connected+jws`) signed with
 *      the Portal key over `{ appId, portalUrl, jkt, nonce, iat }`;
 *   4. the product (`verifyConnectResponse`) verifies that answer against the returned JWKS (fetched over TLS from the
 *      URL in the code: the pinned Portal), then stores the Portal URL, its appId and the pinned Portal keys.
 * From then on each side trusts only the other's keys. Every failure on the Portal side answers the same generic 401.
 */
import { createProtocolError } from './errors.js';
import {
	b64url,
	canonicalJson,
	constantTimeEqual,
	defaultRandomBytes,
	fromB64url,
	fromUtf8,
	getHeader,
	randomId,
	sha256Hex,
	utf8,
} from './encoding.js';
import { createKeyResolver, importPublicKey, thumbprint, toPublicJwk } from './keys.js';
import { isObject, nowSeconds, requireString, signCompact, verifyCompact } from './jws.js';

/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').PublicJwk} PublicJwk */
/**
 * @typedef {{ portalUrl: string, baseUrl: string, tth: string, manifestHash: string, jkt: string, nonce: string, iat: number }} ConnectClaims
 */

/** Prefix of connection codes. */
export const CONNECTION_CODE_PREFIX = 'ssc_';
/** Path of the Portal's connect endpoint. */
export const CONNECT_PATH = '/v1/apps/connect';
/** JOSE `typ` of the product's connect request. */
export const CONNECT_TYP = 'ss-connect+jws';
/** JOSE `typ` of the Portal's answer. */
export const CONNECTED_TYP = 'ss-connected+jws';
const TOLERANCE_SECONDS = 300;
const TOKEN = /^sct_[A-Za-z0-9_-]{32,128}$/;

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

/**
 * Hash a connection token for storage at rest (tokens are 256-bit random, so plain SHA-256 suffices).
 * @param {string} token
 * @returns {string} hex
 */
export const hashConnectionToken = (token) => sha256Hex(requireString(token, 'token'));

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
 * Portal side: a fresh connection code. Store `tokenHash` only; show `code` once.
 * @param {{ portalUrl: string, randomBytes?: (length: number) => Uint8Array }} params
 * @returns {{ code: string, token: string, tokenHash: string }}
 */
export const createConnectionCode = ({ portalUrl, randomBytes = defaultRandomBytes }) => {
	const token = `sct_${b64url(randomBytes(32))}`;
	const code = `${CONNECTION_CODE_PREFIX}${b64url(utf8(`${canonicalUrl(portalUrl)} ${token}`))}`;
	return { code, token, tokenHash: hashConnectionToken(token) };
};

/**
 * Product side: read a connection code.
 * @param {unknown} code
 * @returns {{ portalUrl: string, token: string }}
 */
export const parseConnectionCode = (code) => {
	const text = typeof code === 'string' ? code.trim() : '';
	if (!text.startsWith(CONNECTION_CODE_PREFIX) || text.length > 1024)
		throw createProtocolError('invalid_argument', 'not a connection code');
	/** @type {string} */
	let decoded;
	try {
		decoded = fromUtf8(fromB64url(text.slice(CONNECTION_CODE_PREFIX.length)));
	} catch {
		throw createProtocolError('invalid_argument', 'not a connection code');
	}
	const [url, token, ...rest] = decoded.split(' ');
	if (rest.length > 0 || !token || !TOKEN.test(token)) throw createProtocolError('invalid_argument', 'not a connection code');
	return { portalUrl: canonicalUrl(url), token };
};

/**
 * Product side: the connect request (proof of possession of the new key, bound to token, manifest and base URL).
 * @param {{ code: string, baseUrl: string, manifest: unknown, signer: Signer, publicJwk: PublicJwk, nonce?: string,
 *   now?: () => number, randomBytes?: (length: number) => Uint8Array }} params
 * @returns {Promise<{ url: string, portalUrl: string, headers: Record<string, string>, body: string, nonce: string, jkt: string }>}
 */
export const createConnectRequest = async ({
	code,
	baseUrl,
	manifest,
	signer,
	publicJwk,
	nonce,
	now = Date.now,
	randomBytes = defaultRandomBytes,
}) => {
	const { portalUrl, token } = parseConnectionCode(code);
	const pub = toPublicJwk(publicJwk);
	if (!signer || signer.kid !== pub.kid) throw createProtocolError('invalid_argument', 'signer must sign with publicJwk');
	const jkt = await thumbprint(pub);
	/** @type {ConnectClaims} */
	const claims = {
		portalUrl,
		baseUrl: canonicalUrl(baseUrl),
		tth: hashConnectionToken(token),
		manifestHash: hashManifest(manifest),
		jkt,
		nonce: nonce ?? randomId(randomBytes),
		iat: nowSeconds(now),
	};
	const request = await signCompact({ signer, typ: CONNECT_TYP, payload: claims });
	return {
		url: `${portalUrl}${CONNECT_PATH}`,
		portalUrl,
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ request, publicJwk: pub, manifest }),
		nonce: claims.nonce,
		jkt,
	};
};

/**
 * Portal side: verify a connect request. Look the app up by `tokenHash`, then burn the token atomically and check the
 * nonce against a replay store before binding anything.
 * @param {{ headers: Headers | Record<string, string | string[] | undefined>, body: unknown, portalUrl: string,
 *   now?: () => number }} params
 * @returns {Promise<{ tokenHash: string, publicJwk: PublicJwk, thumbprint: string, manifest: unknown, baseUrl: string,
 *   nonce: string, iat: number }>}
 */
export const verifyConnectRequest = async ({ headers, body, portalUrl, now = Date.now }) => {
	const ours = canonicalUrl(portalUrl);
	const match = /^Bearer (\S{16,256})$/.exec(getHeader(headers, 'authorization') ?? '');
	if (!match?.[1] || !TOKEN.test(match[1])) throw createProtocolError('malformed', 'connection token missing');
	const tokenHash = hashConnectionToken(match[1]);
	/** @type {unknown} */
	let parsed = body;
	if (typeof body === 'string') {
		try {
			parsed = JSON.parse(body);
		} catch {
			throw createProtocolError('malformed', 'body is not JSON');
		}
	}
	if (!isObject(parsed) || typeof parsed.request !== 'string' || !('manifest' in parsed))
		throw createProtocolError('malformed', 'connect body must carry request, publicJwk and manifest');
	/** @type {PublicJwk} */
	let publicJwk;
	try {
		publicJwk = toPublicJwk(parsed.publicJwk);
	} catch {
		throw createProtocolError('malformed', 'publicJwk is invalid');
	}
	const key = await importPublicKey(publicJwk);
	const { payload } = await verifyCompact({
		token: parsed.request,
		typ: CONNECT_TYP,
		keyResolver: {
			resolve: async (kid) => {
				if (kid !== publicJwk.kid) throw createProtocolError('unknown_kid', 'request is not signed by the included key');
				return key;
			},
		},
	});
	const jkt = await thumbprint(publicJwk);
	if (payload.jkt !== jkt) throw createProtocolError('signature', 'thumbprint does not match publicJwk');
	if (typeof payload.tth !== 'string' || !constantTimeEqual(payload.tth, tokenHash))
		throw createProtocolError('signature', 'request is not bound to this token');
	if (payload.portalUrl !== ours) throw createProtocolError('audience', 'request is for another Portal');
	let baseUrl = '';
	try {
		baseUrl = canonicalUrl(payload.baseUrl);
	} catch {
		throw createProtocolError('malformed', 'baseUrl is invalid');
	}
	if (payload.manifestHash !== hashManifest(parsed.manifest))
		throw createProtocolError('signature', 'manifest does not match the signed hash');
	const iat = payload.iat;
	if (typeof iat !== 'number' || Math.abs(now() / 1000 - iat) > TOLERANCE_SECONDS)
		throw createProtocolError('expired', 'request is stale');
	const nonce = payload.nonce;
	if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 256) throw createProtocolError('malformed', 'nonce');
	return { tokenHash, publicJwk, thumbprint: jkt, manifest: parsed.manifest, baseUrl, nonce, iat };
};

/**
 * Portal side: the signed answer to a successful connect.
 * @param {{ signer: Signer, appId: string, portalUrl: string, jkt: string, nonce: string, jwks: unknown, now?: () => number }} params
 * @returns {Promise<{ appId: string, jwks: unknown, response: string }>}
 */
export const createConnectResponse = async ({ signer, appId, portalUrl, jkt, nonce, jwks, now = Date.now }) => {
	const response = await signCompact({
		signer,
		typ: CONNECTED_TYP,
		payload: { appId, portalUrl: canonicalUrl(portalUrl), jkt, nonce, iat: nowSeconds(now) },
	});
	return { appId, jwks, response };
};

/**
 * Product side: verify the Portal's answer against the JWKS it returned (received over TLS from the pinned URL).
 * @param {{ body: unknown, portalUrl: string, nonce: string, jkt: string, now?: () => number }} params
 * @returns {Promise<{ appId: string, jwks: { keys: PublicJwk[] }, portalKid: string }>}
 */
export const verifyConnectResponse = async ({ body, portalUrl, nonce, jkt, now = Date.now }) => {
	if (!isObject(body) || typeof body.response !== 'string' || !isObject(body.jwks) || !Array.isArray(body.jwks.keys))
		throw createProtocolError('malformed', 'connect answer must carry appId, jwks and response');
	const jwks = { keys: body.jwks.keys.map((key) => toPublicJwk(key)) };
	const resolver = createKeyResolver({ fetchJwks: async () => jwks, now });
	const { payload, kid } = await verifyCompact({ token: body.response, keyResolver: resolver, typ: CONNECTED_TYP });
	if (payload.portalUrl !== canonicalUrl(portalUrl)) throw createProtocolError('audience', 'answer is from another Portal');
	if (payload.jkt !== jkt) throw createProtocolError('subject', 'answer is for another key');
	if (typeof payload.nonce !== 'string' || !constantTimeEqual(payload.nonce, nonce))
		throw createProtocolError('replay', 'answer does not echo the request nonce');
	const iat = payload.iat;
	if (typeof iat !== 'number' || Math.abs(now() / 1000 - iat) > TOLERANCE_SECONDS)
		throw createProtocolError('expired', 'answer is stale');
	if (typeof payload.appId !== 'string' || payload.appId !== body.appId)
		throw createProtocolError('malformed', 'appId is invalid');
	return { appId: payload.appId, jwks, portalKid: kid };
};
