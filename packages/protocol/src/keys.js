/**
 * Ed25519 signing keys, JWK/JWKS helpers and a rotating, caching key resolver.
 *
 * All signatures in the App Protocol are EdDSA over Ed25519 (RFC 8037). Keys are identified by `kid`. Private keys are
 * wrapped in a `Signer` whose only capability is `sign(bytes)`, so a KMS/HSM-backed signer can be dropped in.
 */
import { createPrivateKey } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK } from 'jose';
import { createProtocolError } from './errors.js';

/**
 * Public Ed25519 JWK as published in a JWKS. `nbf`/`exp` (seconds since epoch) are optional App Protocol extensions
 * that bound when a key may verify signatures (rotation overlap windows).
 * @typedef {{ kty: 'OKP', crv: 'Ed25519', x: string, kid: string, alg: 'EdDSA', use: 'sig', nbf?: number, exp?: number }} PublicJwk
 */

/** @typedef {PublicJwk & { d: string }} PrivateJwk */

/** @typedef {{ keys: PublicJwk[] }} Jwks */

/**
 * Something that can produce EdDSA signatures under a known `kid`.
 * @typedef {{ kid: string, alg: 'EdDSA', sign: (data: Uint8Array) => Promise<Uint8Array> }} Signer
 */

/**
 * Resolves a `kid` to a verification key, throwing a `ProtocolError` (`unknown_kid`, `revoked_key`, `key_not_active`,
 * `key_retired`, `jwks_unavailable`) when the key must not be used.
 * @typedef {{ resolve: (kid: string) => Promise<CryptoKey> }} KeyResolver
 */

const KID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const X_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const isOptionalSeconds = (value) => value === undefined || (Number.isInteger(value) && /** @type {number} */ (value) >= 0);

/**
 * Validate and normalise a public Ed25519 JWK (drops any private or unknown members).
 * @param {unknown} jwk
 * @returns {PublicJwk}
 */
export const toPublicJwk = (jwk) => {
	if (!isObject(jwk)) throw createProtocolError('invalid_argument', 'JWK must be an object');
	if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') throw createProtocolError('invalid_argument', 'JWK must be OKP/Ed25519');
	if (typeof jwk.x !== 'string' || !X_PATTERN.test(jwk.x)) throw createProtocolError('invalid_argument', 'JWK x is invalid');
	if (typeof jwk.kid !== 'string' || !KID_PATTERN.test(jwk.kid))
		throw createProtocolError('invalid_argument', 'JWK kid is invalid');
	if (jwk.alg !== undefined && jwk.alg !== 'EdDSA') throw createProtocolError('invalid_argument', 'JWK alg must be EdDSA');
	if (jwk.use !== undefined && jwk.use !== 'sig') throw createProtocolError('invalid_argument', 'JWK use must be sig');
	if (!isOptionalSeconds(jwk.nbf) || !isOptionalSeconds(jwk.exp)) {
		throw createProtocolError('invalid_argument', 'JWK nbf/exp must be integer seconds');
	}
	/** @type {PublicJwk} */
	const out = { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: jwk.kid, alg: 'EdDSA', use: 'sig' };
	if (jwk.nbf !== undefined) out.nbf = /** @type {number} */ (jwk.nbf);
	if (jwk.exp !== undefined) out.exp = /** @type {number} */ (jwk.exp);
	return out;
};

/**
 * RFC 7638 SHA-256 thumbprint of an Ed25519 JWK (only `kty`, `crv`, `x` are hashed).
 * @param {{ kty: string, crv: string, x: string }} jwk
 * @returns {Promise<string>}
 */
export const thumbprint = (jwk) => calculateJwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, 'sha256');

/**
 * Generate a fresh Ed25519 key pair. `kid` defaults to the key's RFC 7638 thumbprint.
 * @param {{ kid?: string }} [options]
 * @returns {Promise<{ privateJwk: PrivateJwk, publicJwk: PublicJwk }>}
 */
export const generateSigningKey = async ({ kid } = {}) => {
	const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
	const exportedPrivate = await exportJWK(privateKey);
	const exportedPublic = await exportJWK(publicKey);
	const finalKid = kid ?? (await thumbprint(/** @type {{ kty: string, crv: string, x: string }} */ (exportedPublic)));
	const publicJwk = toPublicJwk({ ...exportedPublic, kid: finalKid });
	return { privateJwk: { ...publicJwk, d: /** @type {string} */ (exportedPrivate.d) }, publicJwk };
};

/** PKCS#8 DER prefix of an Ed25519 private key (RFC 8410); the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SEED_TEXT = /^[A-Za-z0-9+/_-]{43}=?$/;

/**
 * Private Ed25519 JWK from its 32-byte seed (the RFC 8032 private key; the JWK `d`). This is the form keys take in
 * environment variables, so no JSON is ever needed there.
 * @param {string} kid
 * @param {Uint8Array | string} seed 32 bytes, or their base64url (base64 accepted)
 * @returns {PrivateJwk}
 */
export const signingKeyFromSeed = (kid, seed) => {
	const bytes =
		typeof seed === 'string'
			? SEED_TEXT.test(seed.trim())
				? Buffer.from(seed.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=$/, ''), 'base64url')
				: null
			: Buffer.from(seed);
	if (!bytes || bytes.length !== 32) throw createProtocolError('invalid_argument', 'Ed25519 seed must be 32 bytes (base64url)');
	const jwk = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, bytes]), format: 'der', type: 'pkcs8' }).export({
		format: 'jwk',
	});
	return { ...toPublicJwk({ ...jwk, kid }), d: /** @type {string} */ (jwk.d) };
};

/**
 * Parse a key list `kid:seed[,kid:seed…]` (seed = base64url of 32 bytes). Order is kept (the first signs); kids must
 * be unique. Throws `invalid_argument` on any malformed entry.
 * @param {string} text
 * @returns {PrivateJwk[]}
 */
export const parseSigningKeys = (text) => {
	const entries = String(text)
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length === 0) throw createProtocolError('invalid_argument', 'no signing key given');
	/** @type {PrivateJwk[]} */
	const keys = [];
	for (const entry of entries) {
		const colon = entry.lastIndexOf(':');
		if (colon <= 0) throw createProtocolError('invalid_argument', 'signing key must be kid:seed');
		const key = signingKeyFromSeed(entry.slice(0, colon), entry.slice(colon + 1));
		if (keys.some((k) => k.kid === key.kid || k.x === key.x))
			throw createProtocolError('invalid_argument', 'signing keys must have unique kids and keys');
		keys.push(key);
	}
	return keys;
};

/**
 * The environment form of a private key: `kid:seed` (inverse of {@link signingKeyFromSeed}).
 * @param {{ kid?: unknown, d?: unknown }} privateJwk
 * @returns {string}
 */
export const formatSigningKey = (privateJwk) => {
	const { kid } = toPublicJwk(privateJwk);
	if (typeof privateJwk.d !== 'string' || !SEED_TEXT.test(privateJwk.d))
		throw createProtocolError('invalid_argument', 'JWK d is invalid');
	return `${kid}:${privateJwk.d}`;
};

/**
 * Import a public Ed25519 JWK as a WebCrypto verification key.
 * @param {unknown} jwk
 * @returns {Promise<CryptoKey>}
 */
export const importPublicKey = async (jwk) => {
	const pub = toPublicJwk(jwk);
	return /** @type {CryptoKey} */ (await importJWK({ kty: pub.kty, crv: pub.crv, x: pub.x }, 'EdDSA'));
};

/**
 * Import a private Ed25519 JWK as a non-extractable WebCrypto signing key.
 * @param {unknown} jwk
 * @returns {Promise<CryptoKey>}
 */
export const importPrivateKey = async (jwk) => {
	const pub = toPublicJwk(jwk);
	const d = /** @type {Record<string, unknown>} */ (jwk).d;
	if (typeof d !== 'string' || !X_PATTERN.test(d)) throw createProtocolError('invalid_argument', 'private JWK d is invalid');
	return /** @type {CryptoKey} */ (
		await importJWK({ kty: pub.kty, crv: pub.crv, x: pub.x, d }, 'EdDSA', { extractable: false })
	);
};

/**
 * Export a WebCrypto Ed25519 public key (or the public half of a private JWK) as a normalised public JWK.
 * @param {CryptoKey | PrivateJwk | PublicJwk} key
 * @param {{ kid?: string }} [options] required when `key` is a CryptoKey unless the thumbprint should be used
 * @returns {Promise<PublicJwk>}
 */
export const exportPublicJwk = async (key, { kid } = {}) => {
	if (!(key instanceof CryptoKey)) return toPublicJwk(kid ? { ...key, kid } : key);
	if (key.type !== 'public') throw createProtocolError('invalid_argument', 'expected a public CryptoKey');
	const jwk = /** @type {{ kty: string, crv: string, x: string }} */ (await exportJWK(key));
	return toPublicJwk({ ...jwk, kid: kid ?? (await thumbprint(jwk)) });
};

/**
 * Wrap a private JWK in a `Signer`. The private key is imported once, non-extractable, and never exposed.
 * @param {PrivateJwk} privateJwk
 * @returns {Signer}
 */
export const createSigner = (privateJwk) => {
	const { kid } = toPublicJwk(privateJwk);
	/** @type {Promise<CryptoKey> | undefined} */
	let keyPromise;
	return Object.freeze({
		kid,
		alg: /** @type {const} */ ('EdDSA'),
		sign: async (data) => {
			keyPromise ??= importPrivateKey(privateJwk);
			const key = await keyPromise;
			return new Uint8Array(await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, key, /** @type {BufferSource} */ (data)));
		},
	});
};

/**
 * Build a JWKS document from public keys (private members are stripped; duplicate kids are rejected).
 * @param {ReadonlyArray<PublicJwk | PrivateJwk>} publicKeys
 * @returns {Jwks}
 */
export const createJwks = (publicKeys) => {
	if (!Array.isArray(publicKeys)) throw createProtocolError('invalid_argument', 'publicKeys must be an array');
	const keys = publicKeys.map((key) => toPublicJwk(key));
	const kids = new Set(keys.map((key) => key.kid));
	if (kids.size !== keys.length) throw createProtocolError('invalid_argument', 'duplicate kid in JWKS');
	return { keys };
};

/**
 * Parse an untrusted JWKS document; entries that are not valid Ed25519 signing keys are ignored.
 * @param {unknown} jwks
 * @returns {Map<string, PublicJwk>}
 */
const parseJwks = (jwks) => {
	if (!isObject(jwks) || !Array.isArray(jwks.keys)) throw createProtocolError('jwks_unavailable', 'JWKS document is invalid');
	/** @type {Map<string, PublicJwk>} */
	const byKid = new Map();
	/** @type {Set<string>} */
	const duplicated = new Set();
	for (const entry of jwks.keys) {
		try {
			const jwk = toPublicJwk(entry);
			if (byKid.has(jwk.kid)) duplicated.add(jwk.kid);
			byKid.set(jwk.kid, jwk);
		} catch {
			// ignore non-Ed25519 or malformed members
		}
	}
	for (const kid of duplicated) byKid.delete(kid); // ambiguous kid: trust neither
	return byKid;
};

/**
 * Create a key resolver over a static JWKS or a fetched one.
 *
 * Rotation: publish old and new keys side by side; set `exp` on the old key to the end of the overlap window. The
 * resolver refetches when it meets an unknown `kid` (at most once per `minRefreshIntervalMs`, so forged kids cannot
 * turn it into a request amplifier) and when the cache is older than `cacheTtlMs`. If a refetch fails, the last known
 * keys keep working (the Portal may be unreachable) until `maxStaleMs` has passed since the last successful fetch.
 * Revocation (`revokedKids` / `isRevoked`) is checked on every resolve and wins over everything else.
 *
 * @param {{
 *   jwks?: Jwks | unknown,
 *   fetchJwks?: () => Promise<unknown>,
 *   cacheTtlMs?: number,
 *   minRefreshIntervalMs?: number,
 *   maxStaleMs?: number,
 *   revokedKids?: Iterable<string>,
 *   isRevoked?: (kid: string) => boolean,
 *   now?: () => number,
 * }} options
 * @returns {KeyResolver & { refresh: () => Promise<void>, kids: () => string[] }}
 */
export const createKeyResolver = ({
	jwks,
	fetchJwks,
	cacheTtlMs = 5 * 60_000,
	minRefreshIntervalMs = 30_000,
	maxStaleMs = 24 * 60 * 60_000,
	revokedKids = [],
	isRevoked = () => false,
	now = Date.now,
}) => {
	if (jwks === undefined && typeof fetchJwks !== 'function') {
		throw createProtocolError('invalid_argument', 'createKeyResolver needs jwks or fetchJwks');
	}
	const revoked = new Set(revokedKids);
	/** @type {Map<string, PublicJwk>} */
	let keys = jwks === undefined ? new Map() : parseJwks(jwks);
	let fetchedAt = jwks === undefined ? -Infinity : now();
	let lastAttemptAt = -Infinity;
	/** @type {Promise<void> | undefined} */
	let inflight;
	/** @type {Map<string, { x: string, key: Promise<CryptoKey> }>} */
	const imported = new Map();

	const doRefresh = async () => {
		if (!fetchJwks) return;
		lastAttemptAt = now();
		try {
			keys = parseJwks(await fetchJwks());
			fetchedAt = now();
		} catch {
			// keep last-known keys; staleness is enforced in resolve()
		}
	};

	const refresh = () => {
		inflight ??= doRefresh().finally(() => {
			inflight = undefined;
		});
		return inflight;
	};

	/** @param {string} kid */
	const resolve = async (kid) => {
		if (typeof kid !== 'string' || !KID_PATTERN.test(kid))
			throw createProtocolError('unknown_kid', 'kid is missing or invalid');
		if (revoked.has(kid) || isRevoked(kid)) throw createProtocolError('revoked_key', 'signing key is revoked', { kid });
		if (fetchJwks && now() - fetchedAt >= cacheTtlMs) await refresh();
		if (fetchJwks && !keys.has(kid) && now() - lastAttemptAt >= minRefreshIntervalMs) await refresh();
		if (fetchJwks && now() - fetchedAt >= maxStaleMs) {
			throw createProtocolError('jwks_unavailable', 'JWKS could not be refreshed', { kid });
		}
		const jwk = keys.get(kid);
		if (!jwk) throw createProtocolError('unknown_kid', 'no key for kid', { kid });
		const seconds = now() / 1000;
		if (jwk.nbf !== undefined && seconds < jwk.nbf)
			throw createProtocolError('key_not_active', 'key is not active yet', { kid });
		if (jwk.exp !== undefined && seconds >= jwk.exp) throw createProtocolError('key_retired', 'key is retired', { kid });
		const cached = imported.get(kid);
		if (cached && cached.x === jwk.x) return cached.key;
		const key = importPublicKey(jwk);
		imported.set(kid, { x: jwk.x, key });
		return key;
	};

	return Object.freeze({ resolve, refresh, kids: () => [...keys.keys()] });
};
