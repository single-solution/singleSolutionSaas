/**
 * Portal cryptography. Signatures and JWKS come from `@ss/protocol` (never re-implemented); this module adds the
 * sealing of the Portal's stored secrets with `ENCRYPTION_KEY` (PLAN 0.4.8), in the one format of `@ss/protocol`.
 *
 * Signing keys (generated on first start, `infra/system.js`): the first key signs; every configured key is published
 * in the JWKS so tokens signed by the previous key keep verifying during the overlap. Browser and server tokens are
 * signed by a **dedicated token signer** (PLAN 0.4.4), so rotating the Portal key (launches, notices) never touches
 * them.
 *
 * Sealing: `ss2.<keyId>.<iv>.<tag>.<data>` (AES-256-GCM; the key id names the `ENCRYPTION_KEY` that sealed the value,
 * never the key itself), bound to the caller's AAD (e.g. `{ websiteId, productId }`). Values sealed before
 * (`ssenc1.ek1.<wrapped data key>.<data>`) are still read.
 * @module
 */
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { createJwks, createKeyResolver, createSealer, createSigner, toPublicJwk } from '@ss/protocol';
import { platformError } from './errors.js';
import { defaultRandomBytes, isObject, stableJson } from './util.js';

/** @typedef {import('@ss/protocol').PrivateJwk} PrivateJwk */
/** @typedef {import('@ss/protocol').Signer} Signer */
/** @typedef {import('@ss/protocol').Jwks} Jwks */

const IV = 12;
const TAG = 16;
const KEY = 32;

/**
 * Portal signing keys: active signer, all signers (for dual-signing notices during rotation), the Portal JWKS and a
 * resolver over our own public keys (to verify what the Portal issued, such as launches). Browser and server tokens
 * have a **dedicated** signer with its own resolver: a launch is never accepted as a token, and the other way round.
 * Both key sets are published together (`publishedJwks()`, served at `/.well-known/jwks.json` and pinned by products
 * at connect) with distinct kids. `publishedOnly` keys (stored keys whose seed no longer opens, K-21) are published
 * and verify, but never sign, so tokens they signed keep working.
 * @param {ReadonlyArray<PrivateJwk>} signingKeys
 * @param {ReadonlyArray<PrivateJwk>} tokenSigningKeys
 * @param {{ signing?: ReadonlyArray<import('@ss/protocol').PublicJwk>, token?: ReadonlyArray<import('@ss/protocol').PublicJwk> }} [publishedOnly]
 */
export const createPortalKeys = (signingKeys, tokenSigningKeys, publishedOnly = {}) => {
	if (!Array.isArray(signingKeys) || signingKeys.length === 0)
		throw platformError('config_invalid', 'at least one signing key is required');
	if (!Array.isArray(tokenSigningKeys) || tokenSigningKeys.length === 0)
		throw platformError('config_invalid', 'at least one token signing key is required');
	const portalPublic = [...signingKeys.map((jwk) => toPublicJwk(jwk)), ...(publishedOnly.signing ?? [])];
	const tokenPublic = [...tokenSigningKeys.map((jwk) => toPublicJwk(jwk)), ...(publishedOnly.token ?? [])];
	const portalKids = new Set(portalPublic.map((jwk) => jwk.kid));
	if (tokenPublic.some((jwk) => portalKids.has(jwk.kid)))
		throw platformError('config_invalid', 'token signing kids must differ from the Portal signing kids');
	const signers = signingKeys.map((jwk) => createSigner(jwk));
	const tokenSigners = tokenSigningKeys.map((jwk) => createSigner(jwk));
	const jwks = createJwks(portalPublic);
	const tokenJwks = createJwks(tokenPublic);
	const published = createJwks([...portalPublic, ...tokenPublic]);
	return Object.freeze({
		/** @type {Signer} */
		signer: /** @type {Signer} */ (signers[0]),
		/** @type {ReadonlyArray<Signer>} */
		signers: Object.freeze(signers),
		activeKid: /** @type {Signer} */ (signers[0]).kid,
		/** Portal keys only. @returns {Jwks} */
		jwks: () => jwks,
		keyResolver: createKeyResolver({ jwks }),
		/** Signs browser and server tokens — nothing else. @type {Signer} */
		tokenSigner: /** @type {Signer} */ (tokenSigners[0]),
		/** Resolver over the token signing keys only. */
		tokenKeyResolver: createKeyResolver({ jwks: tokenJwks }),
		/** Token public keys only. @returns {Jwks} */
		tokenJwks: () => tokenJwks,
		/** Everything the Portal publishes: Portal keys followed by token keys. @returns {Jwks} */
		publishedJwks: () => published,
	});
};
/** @typedef {ReturnType<typeof createPortalKeys>} PortalKeys */

/**
 * The text a sealed value is bound to: the caller's AAD object (non-empty strings) as stable JSON.
 * @param {unknown} aad
 * @returns {string}
 */
const aadText = (aad) => {
	if (!isObject(aad) || Object.keys(aad).length === 0) throw platformError('invalid_argument', 'aad must be a non-empty object');
	for (const [key, value] of Object.entries(aad)) {
		if (typeof value !== 'string' || value.length === 0)
			throw platformError('invalid_argument', `aad.${key} must be a non-empty string`);
	}
	return `ss-data.v1|${stableJson(aad)}`;
};

/**
 * @param {Buffer} key
 * @param {Buffer} blob iv ‖ ciphertext ‖ tag
 * @param {Buffer} aad
 */
const gcmOpen = (key, blob, aad) => {
	const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV), { authTagLength: TAG });
	decipher.setAAD(aad);
	decipher.setAuthTag(blob.subarray(blob.length - TAG));
	return Buffer.concat([decipher.update(blob.subarray(IV, blob.length - TAG)), decipher.final()]);
};

/**
 * The reader of values the Portal sealed before the one format (`ssenc1.ek1.<wrapped data key>.<data>`: a fresh data
 * key per value, wrapped under a key derived from `ENCRYPTION_KEY`), for one key.
 * @param {string} encryptionKey
 * @returns {import('@ss/protocol').LegacyReader}
 */
const legacyEnvelope = (encryptionKey) => {
	const kek = Buffer.from(hkdfSync('sha256', Buffer.from(encryptionKey, 'utf8'), Buffer.alloc(0), 'ss-portal-secrets.v1', KEY));
	return (sealed, aad) => {
		const [version, kekId, wrapped, body, extra] = sealed.split('.');
		if (version !== 'ssenc1' || kekId !== 'ek1' || !wrapped || !body || extra !== undefined) return null;
		try {
			const dek = gcmOpen(kek, Buffer.from(wrapped, 'base64url'), Buffer.from('ss-dek.v1|ek1', 'utf8'));
			if (dek.length !== KEY) return null;
			return gcmOpen(dek, Buffer.from(body, 'base64url'), Buffer.from(aad, 'utf8')).toString('utf8');
		} catch {
			return null;
		}
	};
};

/**
 * Encryption of the Portal's stored secrets that must be read back (PLAN 0.4.8: server tokens, the SMTP password,
 * two-step secrets and the private signing keys) with `ENCRYPTION_KEY`, which is used for nothing else and never
 * stored: the one sealing format of `@ss/protocol` (`ss2.<keyId>.<iv>.<tag>.<data>`, label `portal`, bound to the
 * caller's AAD object). While the owner changes the key, `ENCRYPTION_KEY_PREVIOUS` opens what the old key sealed and
 * Settings → Encryption key → Re-seal (`reseal`) moves it to the new key. Values sealed before (`ssenc1.ek1.…`) open
 * with either key. A value no key opens fails with `decrypt_failed`: callers treat it as not set (a server token then
 * cannot be shown).
 * @param {{ encryptionKey: string, previousKey?: string | null, randomBytes?: (n: number) => Uint8Array }} options
 */
export const createSecretBox = ({ encryptionKey, previousKey = null, randomBytes = defaultRandomBytes }) => {
	if (typeof encryptionKey !== 'string' || encryptionKey.length < 32)
		throw platformError('config_invalid', 'ENCRYPTION_KEY must be at least 32 characters');
	if (previousKey && previousKey.length < 32)
		throw platformError('config_invalid', 'ENCRYPTION_KEY_PREVIOUS must be at least 32 characters');
	const sealer = createSealer({ key: encryptionKey, previousKey, label: 'portal', legacy: legacyEnvelope, randomBytes });
	return Object.freeze({
		/** The id of `ENCRYPTION_KEY` that sealed values record. */
		keyId: sealer.keyId,
		/** The id of `ENCRYPTION_KEY_PREVIOUS`, or null when it is not set. */
		previousKeyId: sealer.previousKeyId,
		/**
		 * @param {string} plaintext
		 * @param {{ aad: Record<string, string> }} options
		 * @returns {string}
		 */
		seal: (plaintext, { aad }) => sealer.seal(plaintext, aadText(aad)),
		/**
		 * @param {unknown} sealed
		 * @param {{ aad: Record<string, string> }} options
		 * @returns {string} throws `decrypt_failed` when no key opens it
		 */
		openText: (sealed, { aad }) => {
			const opened = sealer.open(sealed, aadText(aad));
			if (opened === null) throw platformError('decrypt_failed', 'sealed value could not be opened');
			return opened;
		},
		/**
		 * The value sealed with the current key: itself when it already is, null when no key opens it.
		 * @param {unknown} sealed
		 * @param {{ aad: Record<string, string> }} options
		 * @returns {string | null}
		 */
		reseal: (sealed, { aad }) => sealer.reseal(sealed, aadText(aad)),
	});
};
/** @typedef {ReturnType<typeof createSecretBox>} SecretBox */

/** @typedef {{ resealed: number, current: number, unreadable: number }} ResealCounts */

/**
 * Re-seal stored values and count them (Settings → Encryption key → Re-seal): `save` gets each value sealed with the
 * current key; values already on it and values no key opens are left alone.
 * @param {SecretBox} box
 * @param {Iterable<{ sealed: unknown, aad: Record<string, string>, save: (next: string) => Promise<unknown> }>} items
 * @returns {Promise<ResealCounts>}
 */
export const resealEach = async (box, items) => {
	let resealed = 0;
	let current = 0;
	let unreadable = 0;
	for (const { sealed, aad, save } of items) {
		const next = box.reseal(sealed, { aad });
		if (next === null) unreadable += 1;
		else if (next === sealed) current += 1;
		else {
			resealed += 1;
			await save(next);
		}
	}
	return { resealed, current, unreadable };
};

/**
 * @param {ResealCounts[]} parts
 * @returns {ResealCounts}
 */
export const sumCounts = (parts) => ({
	resealed: parts.reduce((sum, part) => sum + part.resealed, 0),
	current: parts.reduce((sum, part) => sum + part.current, 0),
	unreadable: parts.reduce((sum, part) => sum + part.unreadable, 0),
});
