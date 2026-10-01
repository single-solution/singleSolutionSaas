/**
 * Portal cryptography. Signatures, JWKS and secret-key hashing come from `@ss/protocol` (never re-implemented);
 * this module only adds envelope encryption for stored client credentials (PLAN §1a "credentials custody").
 *
 * Signing keys (`PORTAL_SIGNING_KEYS`): the first key signs; every configured key is published in the JWKS so
 * tokens signed by the previous key keep verifying during the overlap. Rotation: prepend the new key (optionally
 * with `nbf`), keep the old one (with `exp` = end of overlap), then remove it. Website keys are signed by the
 * Portal key, so retiring a key requires re-issuing website keys (F.5).
 *
 * Envelope encryption: each record gets a fresh 256-bit data key; the plaintext is sealed with AES-256-GCM under
 * that data key with the caller's AAD (e.g. `{ merchantId, connectorId }`), and the data key is wrapped with
 * AES-256-GCM under the active KEK (`SECRETS_KEK`, first entry). The sealed string names the KEK id, so old records
 * open with older KEKs and `rewrap` moves a record to the active KEK without touching its ciphertext.
 *
 * Format: `ssenc1.<kekId>.<b64url(wrapIv ‖ wrappedKey ‖ wrapTag)>.<b64url(iv ‖ ciphertext ‖ tag)>`.
 * @module
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { compareSecretKey, createJwks, createKeyResolver, createSigner, hashSecretKey, toPublicJwk } from '@ss/protocol';
import { platformError } from './errors.js';
import { defaultRandomBytes, isObject, stableJson } from './util.js';

/** @typedef {import('@ss/protocol').PrivateJwk} PrivateJwk */
/** @typedef {import('@ss/protocol').Signer} Signer */
/** @typedef {import('@ss/protocol').Jwks} Jwks */

const VERSION = 'ssenc1';
const IV = 12;
const TAG = 16;
const KEY = 32;

/**
 * Portal signing keys: active signer, all signers (for dual-signing events during rotation), the published JWKS
 * and a resolver over our own public keys (to verify tokens the Portal issued, such as website keys).
 * @param {ReadonlyArray<PrivateJwk>} signingKeys
 */
export const createPortalKeys = (signingKeys) => {
	if (!Array.isArray(signingKeys) || signingKeys.length === 0)
		throw platformError('config_invalid', 'at least one signing key is required');
	const signers = signingKeys.map((jwk) => createSigner(jwk));
	const jwks = createJwks(signingKeys.map((jwk) => toPublicJwk(jwk)));
	const keyResolver = createKeyResolver({ jwks });
	return Object.freeze({
		/** @type {Signer} */
		signer: /** @type {Signer} */ (signers[0]),
		/** @type {ReadonlyArray<Signer>} */
		signers: Object.freeze(signers),
		activeKid: /** @type {Signer} */ (signers[0]).kid,
		/** @returns {Jwks} */
		jwks: () => jwks,
		keyResolver,
	});
};
/** @typedef {ReturnType<typeof createPortalKeys>} PortalKeys */

/**
 * @param {unknown} aad
 * @returns {Buffer}
 */
const aadBytes = (aad) => {
	if (!isObject(aad) || Object.keys(aad).length === 0) throw platformError('invalid_argument', 'aad must be a non-empty object');
	for (const [key, value] of Object.entries(aad)) {
		if (typeof value !== 'string' || value.length === 0)
			throw platformError('invalid_argument', `aad.${key} must be a non-empty string`);
	}
	return Buffer.from(`ss-data.v1|${stableJson(aad)}`, 'utf8');
};

/** @param {string} kekId */
const wrapAad = (kekId) => Buffer.from(`ss-dek.v1|${kekId}`, 'utf8');

/**
 * @param {Buffer} key
 * @param {Buffer} iv
 * @param {Buffer} plaintext
 * @param {Buffer} aad
 */
const gcmSeal = (key, iv, plaintext, aad) => {
	const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG });
	cipher.setAAD(aad);
	return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
};

/**
 * @param {Buffer} key
 * @param {Buffer} blob iv ‖ ciphertext ‖ tag
 * @param {Buffer} aad
 */
const gcmOpen = (key, blob, aad) => {
	if (blob.length < IV + TAG) throw platformError('decrypt_failed', 'sealed value is malformed');
	const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV), { authTagLength: TAG });
	decipher.setAAD(aad);
	decipher.setAuthTag(blob.subarray(blob.length - TAG));
	try {
		return Buffer.concat([decipher.update(blob.subarray(IV, blob.length - TAG)), decipher.final()]);
	} catch {
		throw platformError('decrypt_failed', 'sealed value could not be opened');
	}
};

/**
 * Envelope encryption with rotating KEKs.
 * @param {{ keks: ReadonlyArray<{ id: string, key: Uint8Array }>, randomBytes?: (n: number) => Uint8Array }} options
 */
export const createEnvelope = ({ keks, randomBytes = defaultRandomBytes }) => {
	if (!Array.isArray(keks) || keks.length === 0) throw platformError('config_invalid', 'at least one KEK is required');
	/** @type {Map<string, Buffer>} */
	const byId = new Map();
	for (const { id, key } of keks) {
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || key.length !== KEY || byId.has(id))
			throw platformError('config_invalid', 'KEKs need unique ids and 32-byte keys');
		byId.set(id, Buffer.from(key));
	}
	const active = /** @type {{ id: string }} */ (keks[0]).id;
	/** @param {number} n */
	const random = (n) => Buffer.from(randomBytes(n));

	/**
	 * @param {unknown} sealed
	 * @returns {{ kekId: string, wrapped: Buffer, body: Buffer }}
	 */
	const parse = (sealed) => {
		const parts = typeof sealed === 'string' ? sealed.split('.') : [];
		if (parts.length !== 4 || parts[0] !== VERSION) throw platformError('decrypt_failed', 'sealed value is malformed');
		const [, kekId, wrapped, body] = /** @type {[string, string, string, string]} */ (parts);
		if (!byId.has(kekId)) throw platformError('decrypt_failed', 'sealed value uses an unknown KEK');
		return { kekId, wrapped: Buffer.from(wrapped, 'base64url'), body: Buffer.from(body, 'base64url') };
	};

	/**
	 * @param {string} kekId
	 * @param {Buffer} wrapped
	 */
	const unwrap = (kekId, wrapped) => {
		const dek = gcmOpen(/** @type {Buffer} */ (byId.get(kekId)), wrapped, wrapAad(kekId));
		if (dek.length !== KEY) throw platformError('decrypt_failed', 'data key is malformed');
		return dek;
	};

	/** @param {Buffer} dek */
	const wrap = (dek) => gcmSeal(/** @type {Buffer} */ (byId.get(active)), random(IV), dek, wrapAad(active));

	/**
	 * @param {string} sealed
	 * @param {{ aad: Record<string, string> }} options
	 * @returns {Buffer}
	 */
	const open = (sealed, { aad }) => {
		const ad = aadBytes(aad);
		const { kekId, wrapped, body } = parse(sealed);
		const dek = unwrap(kekId, wrapped);
		try {
			return gcmOpen(dek, body, ad);
		} finally {
			dek.fill(0);
		}
	};

	return Object.freeze({
		activeKekId: active,
		/**
		 * @param {string | Uint8Array} plaintext
		 * @param {{ aad: Record<string, string> }} options
		 * @returns {string}
		 */
		seal: (plaintext, { aad }) => {
			const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
			const ad = aadBytes(aad);
			const dek = random(KEY);
			try {
				const body = gcmSeal(dek, random(IV), data, ad);
				return [VERSION, active, wrap(dek).toString('base64url'), body.toString('base64url')].join('.');
			} finally {
				dek.fill(0);
			}
		},
		open,
		/**
		 * @param {string} sealed
		 * @param {{ aad: Record<string, string> }} options
		 * @returns {string}
		 */
		openText: (sealed, options) => open(sealed, options).toString('utf8'),
		/**
		 * Re-wrap the data key under the active KEK (KEK rotation). The ciphertext is unchanged.
		 * @param {string} sealed
		 * @returns {string}
		 */
		rewrap: (sealed) => {
			const { kekId, wrapped, body } = parse(sealed);
			if (kekId === active) return sealed;
			const dek = unwrap(kekId, wrapped);
			try {
				return [VERSION, active, wrap(dek).toString('base64url'), body.toString('base64url')].join('.');
			} finally {
				dek.fill(0);
			}
		},
		/**
		 * @param {string} sealed
		 * @returns {string}
		 */
		kekIdOf: (sealed) => parse(sealed).kekId,
	});
};
/** @typedef {ReturnType<typeof createEnvelope>} Envelope */

/**
 * Website secret keys at rest: HMAC-SHA-256 with the pepper (`WEBSITE_KEY_PEPPER`), compared in constant time.
 * @param {Uint8Array} pepper
 */
export const createSecretHasher = (pepper) => {
	if (!pepper || pepper.length < 32) throw platformError('config_invalid', 'the pepper must be at least 32 bytes');
	return Object.freeze({
		/** @param {string} key */
		hash: (key) => hashSecretKey({ key, pepper }),
		/**
		 * @param {unknown} key
		 * @param {unknown} hash
		 */
		verify: (key, hash) => compareSecretKey({ key, hash, pepper }),
	});
};
