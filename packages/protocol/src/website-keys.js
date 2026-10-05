/**
 * Website keys: `pk_<env>_<jws>` (publishable, browser, domain-locked) and `sk_<env>_<jws>` (secret, server).
 *
 * Both are compact JWS tokens signed by the Portal (`typ: ss-website-key+jws`), so any product can verify them offline
 * with the Portal JWKS and learn the website binding (websiteId, merchantId, domain, env, scopes) without a network
 * call. Revocation is by `keyId` against a revocation list the product caches (≤ 5 min freshness).
 *
 * sk_ trade-offs (decision: signed token + server-side revocation):
 *  - + offline verification keeps products working when the Portal is down (§6.4, §12) and costs no lookup per call.
 *  - − a leaked sk_ stays usable until the revocation list reaches every product (bounded by its cache TTL) or until
 *    `exp`, whereas an opaque random key checked online dies instantly. Mitigations: short revocation cache TTL,
 *    optional `exp`, least-privilege `scopes`, test/live separation, the recognisable `sk_` prefix for secret scanning,
 *    and the Portal stores only `hashSecretKey(key)` (HMAC with a pepper) and shows the key once.
 *  - The claims inside an sk_ are readable by whoever holds it; they contain no secrets (the holder is the owner).
 *
 * pk_ keys are public by design. `originAllowed` ties browser traffic to the bound domain, but Origin/Referer are
 * forgeable by non-browser clients, so pk_ must only unlock browser-safe, rate-limited operations.
 */
import { domainToASCII } from 'node:url';
import { createProtocolError } from './errors.js';
import { constantTimeEqual, hmacSha256Hex } from './encoding.js';
import { checkTimeClaims, nowSeconds, requireString, signCompact, verifyCompact } from './jws.js';

/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').KeyResolver} KeyResolver */
/** @typedef {'pk' | 'sk'} WebsiteKeyKind */
/** @typedef {'live' | 'test'} WebsiteKeyEnv */
/**
 * @typedef {{ v: 1, kind: WebsiteKeyKind, websiteId: string, merchantId: string, domain: string, allowSubdomains: boolean,
 *   env: WebsiteKeyEnv, scopes: string[], keyId: string, iat: number, exp?: number }} WebsiteKeyClaims
 */
/**
 * Revocation source: a set/array of revoked `keyId`s or an (async) predicate.
 * @typedef {Iterable<string> | { isRevoked: (keyId: string) => boolean | Promise<boolean> }} Revocations
 */

/** JOSE `typ` of website keys. */
export const WEBSITE_KEY_TYP = 'ss-website-key+jws';

const PREFIX = /^(pk|sk)_(live|test)_([A-Za-z0-9._-]+)$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * @param {string} value
 * @returns {boolean} true when the string has C0 control characters, DEL, whitespace or a backslash
 */
const hasUnsafeChars = (value) => {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
	}
	return /\s/.test(value);
};

/**
 * Normalise a bare domain to lower-case ASCII (punycode), without a trailing dot. Throws on anything that is not a
 * plain host name (scheme, port, path, userinfo, wildcard, whitespace).
 * @param {unknown} domain
 * @returns {string}
 */
export const normalizeDomain = (domain) => {
	if (typeof domain !== 'string' || domain.length === 0 || domain.length > 253) {
		throw createProtocolError('invalid_argument', 'domain is required');
	}
	if (/[/:@?#*%]/.test(domain) || hasUnsafeChars(domain)) {
		throw createProtocolError('invalid_argument', 'domain must be a bare host name');
	}
	const ascii = domainToASCII(domain.replace(/\.$/, '')).toLowerCase();
	if (!ascii || ascii.startsWith('.') || ascii.includes('..') || !/^[a-z0-9.-]+$/.test(ascii)) {
		throw createProtocolError('invalid_argument', 'domain is not a valid host name');
	}
	return ascii;
};

/**
 * Issue a website key.
 * @param {{
 *   signer: Signer, kind: WebsiteKeyKind, websiteId: string, merchantId: string, domain: string, allowSubdomains?: boolean,
 *   env: WebsiteKeyEnv, scopes: string[], keyId: string, expiresAt?: number, now?: () => number,
 * }} params `expiresAt` is optional, in seconds since epoch.
 * @returns {Promise<{ key: string, claims: WebsiteKeyClaims }>}
 */
export const issueWebsiteKey = async ({
	signer,
	kind,
	websiteId,
	merchantId,
	domain,
	allowSubdomains = false,
	env,
	scopes,
	keyId,
	expiresAt,
	now = Date.now,
}) => {
	if (kind !== 'pk' && kind !== 'sk') throw createProtocolError('invalid_argument', 'kind must be pk or sk');
	if (env !== 'live' && env !== 'test') throw createProtocolError('invalid_argument', 'env must be live or test');
	requireString(websiteId, 'websiteId');
	requireString(merchantId, 'merchantId');
	requireString(keyId, 'keyId');
	if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string' || scope.length === 0)) {
		throw createProtocolError('invalid_argument', 'scopes must be an array of strings');
	}
	const iat = nowSeconds(now);
	if (expiresAt !== undefined && (!Number.isInteger(expiresAt) || expiresAt <= iat)) {
		throw createProtocolError('invalid_argument', 'expiresAt must be integer seconds in the future');
	}
	/** @type {WebsiteKeyClaims} */
	const claims = {
		v: 1,
		kind,
		websiteId,
		merchantId,
		domain: normalizeDomain(domain),
		allowSubdomains: allowSubdomains === true,
		env,
		scopes: [...scopes],
		keyId,
		iat,
	};
	if (expiresAt !== undefined) claims.exp = expiresAt;
	const token = await signCompact({ signer, typ: WEBSITE_KEY_TYP, payload: claims });
	return { key: `${kind}_${env}_${token}`, claims };
};

/**
 * @param {Revocations} revocations
 * @param {string} keyId
 * @returns {Promise<boolean>}
 */
const isKeyRevoked = async (revocations, keyId) => {
	if (typeof (/** @type {{ isRevoked?: unknown }} */ (revocations).isRevoked) === 'function') {
		return (
			(await /** @type {{ isRevoked: (id: string) => boolean | Promise<boolean> }} */ (revocations).isRevoked(keyId)) === true
		);
	}
	if (revocations instanceof Set) return revocations.has(keyId);
	for (const id of /** @type {Iterable<string>} */ (revocations)) if (id === keyId) return true;
	return false;
};

/**
 * Verify a website key offline (signature, prefix ↔ claims consistency, time, revocation).
 * @param {{ key: unknown, keyResolver: KeyResolver, revocations: Revocations, now?: () => number, skewSeconds?: number,
 *   expectedKind?: WebsiteKeyKind, expectedEnv?: WebsiteKeyEnv }} params
 * @returns {Promise<WebsiteKeyClaims & { kid: string }>}
 */
export const verifyWebsiteKey = async ({
	key,
	keyResolver,
	revocations,
	now = Date.now,
	skewSeconds = 30,
	expectedKind,
	expectedEnv,
}) => {
	if (revocations === undefined || revocations === null)
		throw createProtocolError('invalid_argument', 'revocations is required');
	if (typeof key !== 'string' || key.length > 4096) throw createProtocolError('malformed', 'website key is missing or too long');
	const match = PREFIX.exec(key);
	if (!match) throw createProtocolError('malformed', 'website key has an invalid format');
	const [, kind, env, token] = /** @type {[string, WebsiteKeyKind, WebsiteKeyEnv, string]} */ (/** @type {unknown} */ (match));
	const { payload, kid } = await verifyCompact({ token, keyResolver, typ: WEBSITE_KEY_TYP });
	if (payload.v !== 1) throw createProtocolError('malformed', 'unsupported website key version');
	if (payload.kind !== kind) throw createProtocolError('malformed', 'prefix does not match key kind');
	if (payload.env !== env) throw createProtocolError('env_mismatch', 'prefix does not match key environment');
	if (expectedKind !== undefined && kind !== expectedKind)
		throw createProtocolError('wrong_type', `expected a ${expectedKind}_ key`);
	if (expectedEnv !== undefined && env !== expectedEnv)
		throw createProtocolError('env_mismatch', `expected a ${expectedEnv} key`);
	for (const name of ['websiteId', 'merchantId', 'domain', 'keyId']) {
		if (typeof payload[name] !== 'string' || payload[name] === '') throw createProtocolError('malformed', `${name} is missing`);
	}
	if (typeof payload.allowSubdomains !== 'boolean') throw createProtocolError('malformed', 'allowSubdomains is missing');
	if (!Array.isArray(payload.scopes) || payload.scopes.some((scope) => typeof scope !== 'string')) {
		throw createProtocolError('malformed', 'scopes are invalid');
	}
	if (payload.exp !== undefined) {
		checkTimeClaims({ claims: payload, nowMs: now(), skewSeconds });
	} else if (typeof payload.iat !== 'number' || now() / 1000 + skewSeconds < payload.iat) {
		throw createProtocolError(typeof payload.iat === 'number' ? 'not_yet_valid' : 'malformed', 'iat is invalid');
	}
	if (await isKeyRevoked(revocations, /** @type {string} */ (payload.keyId)))
		throw createProtocolError('revoked', 'website key is revoked');
	return { .../** @type {WebsiteKeyClaims} */ (/** @type {unknown} */ (payload)), kid };
};

/**
 * @param {string} host lower-case ASCII host from the WHATWG URL parser
 * @returns {boolean}
 */
const isLocalHost = (host) => LOCAL_HOSTS.has(host) || host.endsWith('.localhost');

/**
 * Parse an Origin/Referer value strictly; returns the normalised host and scheme, or null.
 * @param {string} value
 * @param {boolean} originOnly when true the value must be `scheme://host[:port]` (no path, query or fragment)
 * @returns {{ protocol: string, host: string } | null}
 */
const parseSource = (value, originOnly) => {
	if (value.length === 0 || value.length > 2048 || hasUnsafeChars(value)) return null;
	/** @type {URL} */
	let url;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.username !== '' || url.password !== '') return null;
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	if (originOnly && (url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[?#]/.test(value))) return null;
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	if (host.length === 0) return null;
	return { protocol: url.protocol, host };
};

/**
 * Decide whether a browser request comes from the website a pk_ key is bound to.
 *
 * Rules: the `Origin` header is authoritative when present (a mismatching Origin is never rescued by Referer);
 * `Referer` is used only when Origin is absent; `null`/opaque origins are rejected; scheme must be https, except that in
 * the `test` env http(s) localhost origins (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`) are always accepted;
 * userinfo is rejected; ports are ignored; hosts are compared as lower-case punycode, exactly or — only with
 * `allowSubdomains` — as a dot-separated suffix (`a.example.com` matches, `evil-example.com` and
 * `example.com.evil.com` never do).
 * @param {{ origin?: string | null, referer?: string | null, domain: string, allowSubdomains?: boolean, env?: WebsiteKeyEnv }} params
 * @returns {boolean}
 */
export const originAllowed = ({ origin, referer, domain, allowSubdomains = false, env = 'live' }) => {
	/** @type {string} */
	let bound;
	try {
		bound = normalizeDomain(domain);
	} catch {
		return false;
	}
	const hasOrigin = typeof origin === 'string' && origin.length > 0;
	const source = hasOrigin ? parseSource(origin, true) : typeof referer === 'string' ? parseSource(referer, false) : null;
	if (!source) return false;
	if (isLocalHost(source.host)) return env === 'test';
	if (source.protocol !== 'https:') return false;
	if (source.host === bound) return true;
	return allowSubdomains && source.host.endsWith(`.${bound}`);
};

/**
 * Hash a secret key for storage at rest: HMAC-SHA-256 keyed with a server-side pepper (kept outside the database), hex.
 * @param {{ key: string, pepper: string | Uint8Array }} params
 * @returns {string}
 */
export const hashSecretKey = ({ key, pepper }) => {
	requireString(key, 'key');
	if (!pepper || pepper.length < 16) throw createProtocolError('invalid_argument', 'pepper must be at least 16 bytes');
	return hmacSha256Hex(pepper, key);
};

/**
 * Compare a presented secret key with a stored hash in constant time.
 * @param {{ key: unknown, hash: unknown, pepper: string | Uint8Array }} params
 * @returns {boolean}
 */
export const compareSecretKey = ({ key, hash, pepper }) => {
	if (typeof key !== 'string' || key.length === 0 || typeof hash !== 'string') return false;
	return constantTimeEqual(hashSecretKey({ key, pepper }), hash);
};
