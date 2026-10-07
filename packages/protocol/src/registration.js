/**
 * The connect handshake (PLAN 0.4.12 row 1): Portal → product, once per product and again on Reconnect.
 *
 * The deployer gives the product a random `CONNECT_SECRET` (at least 32 characters) and an Owner types the product URL
 * and that secret into Portal → Products. The Portal then
 *   1. calls `POST <productUrl>/.well-known/ss-connect` with the JSON body
 *      `{ portalUrl, jwks, baseUrl, nonce, priceListVersion }` and the headers `SS-Connect-Timestamp: <unix seconds>`
 *      and `SS-Connect-Signature: <hex HMAC-SHA256(secret, "ss-connect.v1|<timestamp>|<exact body>")>`; the secret
 *      itself is never sent. `priceListVersion` is the Portal's last accepted price-list version for that product (0
 *      when none);
 *   2. the product (`verifyConnectRequest`) checks the HMAC in constant time and the timestamp (±5 min), refuses a
 *      reused nonce, generates its Ed25519 key if it has none, pins the Portal URL and keys, stores the base URL it was
 *      connected with as its own address, and answers (`createConnectResponse`)
 *      `{ productId, nonce, publicJwk, manifest, prices }`, HMAC-signed with the same secret under another label
 *      (`ss-connected.v1|…`), so a request cannot be reflected as an answer;
 *   3. the Portal (`verifyConnectResponse`) checks the answer (HMAC, timestamp, nonce echo, product id format, key) and
 *      stores the product with its base URL and public key pinned. Manifest and price-list shapes are checked by the
 *      caller with `@ss/contracts`. The Portal never stores the secret.
 * Whoever holds the secret is the authority: connecting again replaces the binding.
 */
import { createProtocolError } from './errors.js';
import { constantTimeEqual, defaultRandomBytes, getHeader, hmacSha256Hex, randomId } from './encoding.js';
import { toPublicJwk } from './keys.js';
import { isObject, nowSeconds } from './jws.js';
import { isProductId } from './tokens.js';

/** @typedef {import('./keys.js').PublicJwk} PublicJwk */

/** Path of the product's connect endpoint. */
export const CONNECT_PATH = '/.well-known/ss-connect';
/** Header carrying the HMAC timestamp (unix seconds). */
export const CONNECT_TIMESTAMP_HEADER = 'SS-Connect-Timestamp';
/** Header carrying the hex HMAC-SHA256. */
export const CONNECT_SIGNATURE_HEADER = 'SS-Connect-Signature';
/** Shortest accepted connect secret. */
export const MIN_CONNECT_SECRET_LENGTH = 32;
/** Accepted clock difference, seconds. */
export const CONNECT_TOLERANCE_SECONDS = 300;
const REQUEST_LABEL = 'ss-connect.v1';
const RESPONSE_LABEL = 'ss-connected.v1';
const SIGNATURE = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{1,12}$/;

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
 * True when `secret` is usable as a connect secret (a string of at least {@link MIN_CONNECT_SECRET_LENGTH} characters).
 * @param {unknown} secret
 * @returns {secret is string}
 */
export const isConnectSecret = (secret) => typeof secret === 'string' && secret.length >= MIN_CONNECT_SECRET_LENGTH;

/** @param {unknown} secret @returns {string} */
const requireSecret = (secret) => {
	if (!isConnectSecret(secret))
		throw createProtocolError(
			'invalid_argument',
			`the connect secret must be at least ${MIN_CONNECT_SECRET_LENGTH} characters`,
		);
	return secret;
};

/**
 * A fresh random connect secret (43 base64url characters, 256 bits).
 * @param {(length: number) => Uint8Array} [randomBytes]
 * @returns {string}
 */
export const generateConnectSecret = (randomBytes = defaultRandomBytes) => Buffer.from(randomBytes(32)).toString('base64url');

/**
 * @param {string} label
 * @param {string} secret
 * @param {string} timestamp
 * @param {string} body
 */
const mac = (label, secret, timestamp, body) => hmacSha256Hex(secret, `${label}|${timestamp}|${body}`);

/**
 * @param {string} label
 * @param {string} secret
 * @param {string} body
 * @param {() => number} now
 * @returns {Record<string, string>}
 */
const signedHeaders = (label, secret, body, now) => {
	const timestamp = String(nowSeconds(now));
	return {
		'Content-Type': 'application/json',
		accept: 'application/json',
		[CONNECT_TIMESTAMP_HEADER]: timestamp,
		[CONNECT_SIGNATURE_HEADER]: mac(label, secret, timestamp, body),
	};
};

/**
 * Check the HMAC headers over the exact body, then parse it.
 * @param {string} label
 * @param {{ secret: string, headers: Headers | Record<string, string | string[] | undefined>, body: string, now: () => number }} input
 * @returns {Record<string, any>}
 */
const verifySigned = (label, { secret, headers, body, now }) => {
	const timestamp = getHeader(headers, CONNECT_TIMESTAMP_HEADER) ?? '';
	const signature = (getHeader(headers, CONNECT_SIGNATURE_HEADER) ?? '').toLowerCase();
	if (!TIMESTAMP.test(timestamp) || !SIGNATURE.test(signature) || typeof body !== 'string')
		throw createProtocolError('malformed', 'connect signature headers missing');
	if (!constantTimeEqual(signature, mac(label, secret, timestamp, body)))
		throw createProtocolError('signature', 'connect signature does not verify');
	if (Math.abs(now() / 1000 - Number(timestamp)) > CONNECT_TOLERANCE_SECONDS)
		throw createProtocolError('expired', 'connect message is stale');
	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw createProtocolError('malformed', 'body is not JSON');
	}
	if (!isObject(parsed)) throw createProtocolError('malformed', 'body must be an object');
	return parsed;
};

/** @param {unknown} nonce @returns {string} */
const checkedNonce = (nonce) => {
	if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 256) throw createProtocolError('malformed', 'nonce');
	return nonce;
};

/**
 * @param {unknown} value
 * @returns {value is number}
 */
const isVersion = (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;

/**
 * Portal side: the connect request to a product.
 * @param {{ secret: string, productUrl: string, portalUrl: string, jwks: { keys: unknown[] }, priceListVersion: number,
 *   now?: () => number, randomBytes?: (length: number) => Uint8Array }} params `priceListVersion`: the last accepted
 *   price-list version for this product, 0 when none.
 * @returns {{ url: string, baseUrl: string, headers: Record<string, string>, body: string, nonce: string }}
 */
export const createConnectRequest = ({
	secret,
	productUrl,
	portalUrl,
	jwks,
	priceListVersion,
	now = Date.now,
	randomBytes = defaultRandomBytes,
}) => {
	const key = requireSecret(secret);
	const baseUrl = canonicalUrl(productUrl);
	if (!isVersion(priceListVersion)) throw createProtocolError('invalid_argument', 'priceListVersion must be an integer >= 0');
	const nonce = randomId(randomBytes);
	const body = JSON.stringify({ portalUrl: canonicalUrl(portalUrl), jwks, baseUrl, nonce, priceListVersion });
	return { url: `${baseUrl}${CONNECT_PATH}`, baseUrl, headers: signedHeaders(REQUEST_LABEL, key, body, now), body, nonce };
};

/**
 * Product side: verify a connect request (check the nonce against a replay store afterwards).
 * @param {{ secret: string, headers: Headers | Record<string, string | string[] | undefined>, body: string, now?: () => number }} params
 * @returns {{ portalUrl: string, jwks: { keys: PublicJwk[] }, baseUrl: string, nonce: string, priceListVersion: number }}
 */
export const verifyConnectRequest = ({ secret, headers, body, now = Date.now }) => {
	const parsed = verifySigned(REQUEST_LABEL, { secret: requireSecret(secret), headers, body, now });
	if (!isObject(parsed.jwks) || !Array.isArray(parsed.jwks.keys) || parsed.jwks.keys.length === 0)
		throw createProtocolError('malformed', 'jwks is invalid');
	if (!isVersion(parsed.priceListVersion)) throw createProtocolError('malformed', 'priceListVersion is invalid');
	/** @type {{ keys: PublicJwk[] }} */
	let jwks;
	/** @type {string} */
	let portalUrl;
	/** @type {string} */
	let baseUrl;
	try {
		jwks = { keys: parsed.jwks.keys.map((k) => toPublicJwk(k)) };
		portalUrl = canonicalUrl(parsed.portalUrl);
		baseUrl = canonicalUrl(parsed.baseUrl);
	} catch {
		throw createProtocolError('malformed', 'portalUrl, baseUrl or jwks is invalid');
	}
	return { portalUrl, jwks, baseUrl, nonce: checkedNonce(parsed.nonce), priceListVersion: parsed.priceListVersion };
};

/**
 * Product side: the signed answer.
 * @param {{ secret: string, productId: string, nonce: string, publicJwk: PublicJwk, manifest: unknown, prices: unknown,
 *   now?: () => number }} params `prices`: `{ version, features: [{ key, name, description, dependsOn,
 *   millicreditsPerHour }] }`, the product's current price list.
 * @returns {{ headers: Record<string, string>, body: string }}
 */
export const createConnectResponse = ({ secret, productId, nonce, publicJwk, manifest, prices, now = Date.now }) => {
	const key = requireSecret(secret);
	if (!isProductId(productId)) throw createProtocolError('invalid_argument', 'productId is invalid');
	if (!isObject(manifest) || !isObject(prices))
		throw createProtocolError('invalid_argument', 'manifest and prices are required');
	const body = JSON.stringify({ productId, nonce: checkedNonce(nonce), publicJwk: toPublicJwk(publicJwk), manifest, prices });
	return { headers: signedHeaders(RESPONSE_LABEL, key, body, now), body };
};

/**
 * Portal side: verify the product's answer.
 * @param {{ secret: string, headers: Headers | Record<string, string | string[] | undefined>, body: string, nonce: string,
 *   now?: () => number }} params
 * @returns {{ productId: string, publicJwk: PublicJwk, manifest: Record<string, unknown>, prices: Record<string, unknown> }}
 */
export const verifyConnectResponse = ({ secret, headers, body, nonce, now = Date.now }) => {
	const parsed = verifySigned(RESPONSE_LABEL, { secret: requireSecret(secret), headers, body, now });
	if (typeof parsed.nonce !== 'string' || typeof nonce !== 'string' || !constantTimeEqual(parsed.nonce, nonce))
		throw createProtocolError('replay', 'answer does not echo the request nonce');
	if (!isProductId(parsed.productId)) throw createProtocolError('malformed', 'productId is invalid');
	if (!isObject(parsed.manifest)) throw createProtocolError('malformed', 'manifest is missing');
	if (!isObject(parsed.prices)) throw createProtocolError('malformed', 'prices are missing');
	/** @type {PublicJwk} */
	let publicJwk;
	try {
		publicJwk = toPublicJwk(parsed.publicJwk);
	} catch {
		throw createProtocolError('malformed', 'publicJwk is invalid');
	}
	return { productId: parsed.productId, publicJwk, manifest: parsed.manifest, prices: parsed.prices };
};
