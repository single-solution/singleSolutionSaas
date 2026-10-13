/**
 * Sealing of stored secrets (PLAN 0.4.8, 0.11): one format for the Portal and every product.
 *
 * `ss2.<keyId>.<iv>.<tag>.<data>` (base64url parts): AES-256-GCM under a key derived (HKDF-SHA256) from
 * `ENCRYPTION_KEY` and the sealer's label, with the caller's `aad` (where the value is stored, so a sealed value
 * copied elsewhere does not open). `keyId` names the key that sealed the value: 8 characters derived from
 * `ENCRYPTION_KEY` under another HKDF label, never the key itself.
 *
 * Changing the key (owner's job): the deployable gets the new `ENCRYPTION_KEY` and the old one as
 * `ENCRYPTION_KEY_PREVIOUS`. A value opens with the key its id names; values sealed before this format (no key id)
 * are read by the caller's `legacy` reader with either key. `reseal` moves a value to the current key; once every
 * value is re-sealed the previous key is removed.
 * @module
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes as nodeRandomBytes } from 'node:crypto';
import { createProtocolError } from './errors.js';

/** First part of every sealed value. */
export const SEAL_FORMAT = 'ss2';
/** Shortest accepted `ENCRYPTION_KEY` (and `ENCRYPTION_KEY_PREVIOUS`). */
export const MIN_ENCRYPTION_KEY_LENGTH = 32;

const LABEL = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * @param {string} encryptionKey
 * @param {string} info
 * @param {number} length
 */
const derive = (encryptionKey, info, length) =>
	Buffer.from(hkdfSync('sha256', Buffer.from(encryptionKey, 'utf8'), Buffer.alloc(0), info, length));

/**
 * The id a sealed value records for the key that sealed it (8 base64url characters).
 * @param {string} encryptionKey
 */
export const sealKeyId = (encryptionKey) => derive(encryptionKey, 'ss.seal.key-id.v2', 6).toString('base64url');

/**
 * A reader of values sealed before this format, for one key: the plaintext, or null.
 * @typedef {(sealed: string, aad: string) => string | null} LegacyReader
 */

/**
 * The reader of the first products' format `v1.<iv>.<tag>.<data>` (AES-256-GCM under HKDF-SHA256 of the key with
 * `info`, the caller's `aad`).
 * @param {string} info the HKDF label the unit used (for example `ss-app-kit.seal.v1`)
 * @returns {(encryptionKey: string) => LegacyReader}
 */
export const legacyV1 = (info) => (encryptionKey) => {
	const key = derive(encryptionKey, info, 32);
	return (sealed, aad) => {
		const [version, iv, tag, data, extra] = sealed.split('.');
		if (version !== 'v1' || !iv || !tag || data === undefined || extra !== undefined) return null;
		return gcmOpen(key, iv, tag, data, aad);
	};
};

/**
 * @param {Buffer} key
 * @param {string} iv
 * @param {string} tag
 * @param {string} data
 * @param {string} aad
 * @returns {string | null}
 */
const gcmOpen = (key, iv, tag, data, aad) => {
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
		decipher.setAAD(Buffer.from(aad, 'utf8'));
		decipher.setAuthTag(Buffer.from(tag, 'base64url'));
		return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
	} catch {
		return null;
	}
};

/**
 * @param {unknown} key
 * @param {string} name
 */
const checkKey = (key, name) => {
	if (typeof key !== 'string' || key.length < MIN_ENCRYPTION_KEY_LENGTH)
		throw createProtocolError('invalid_argument', `${name} must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters`);
	return key;
};

/**
 * @param {{ key: string, previousKey?: string | null, label: string,
 *   legacy?: (encryptionKey: string) => LegacyReader, randomBytes?: (length: number) => Uint8Array }} options
 *   `key`: `ENCRYPTION_KEY`; `previousKey`: `ENCRYPTION_KEY_PREVIOUS` (null or '' when not set); `label`: the unit
 *   (`app-kit`, `accounts`, `portal` …), so one unit's values never open in another's; `legacy`: reads values sealed
 *   before this format
 */
export const createSealer = ({ key, previousKey = null, label, legacy, randomBytes = (n) => nodeRandomBytes(n) }) => {
	checkKey(key, 'ENCRYPTION_KEY');
	if (previousKey) checkKey(previousKey, 'ENCRYPTION_KEY_PREVIOUS');
	if (typeof label !== 'string' || !LABEL.test(label)) throw createProtocolError('invalid_argument', 'invalid sealer label');
	const keyring = [key, ...(previousKey && previousKey !== key ? [previousKey] : [])].map((secret) => ({
		id: sealKeyId(secret),
		aes: derive(secret, `ss.seal.v2|${label}`, 32),
		legacy: legacy ? legacy(secret) : null,
	}));
	const current = /** @type {(typeof keyring)[number]} */ (keyring[0]);
	const prefix = `${SEAL_FORMAT}.${current.id}.`;

	/**
	 * @param {string} plaintext
	 * @param {string} aad
	 * @returns {string}
	 */
	const seal = (plaintext, aad) => {
		const iv = Buffer.from(randomBytes(12));
		const cipher = createCipheriv('aes-256-gcm', current.aes, iv);
		cipher.setAAD(Buffer.from(aad, 'utf8'));
		const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		return `${prefix}${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
	};

	/**
	 * @param {unknown} sealed
	 * @param {string} aad
	 * @returns {string | null} null when it cannot be opened (another key, tampered, malformed)
	 */
	const open = (sealed, aad) => {
		if (typeof sealed !== 'string') return null;
		if (sealed.startsWith(`${SEAL_FORMAT}.`)) {
			const [, id, iv, tag, data, extra] = sealed.split('.');
			const entry = keyring.find((k) => k.id === id);
			if (!entry || !iv || !tag || data === undefined || extra !== undefined) return null;
			return gcmOpen(entry.aes, iv, tag, data, aad);
		}
		for (const entry of keyring) {
			const opened = entry.legacy ? entry.legacy(sealed, aad) : null;
			if (opened !== null) return opened;
		}
		return null;
	};

	/** @param {unknown} sealed @returns {boolean} sealed in this format with the current key */
	const isCurrent = (sealed) => typeof sealed === 'string' && sealed.startsWith(prefix);

	return Object.freeze({
		/** The id of `ENCRYPTION_KEY`. */
		keyId: current.id,
		/** The id of `ENCRYPTION_KEY_PREVIOUS`, or null when it is not set. */
		previousKeyId: keyring[1]?.id ?? null,
		seal,
		open,
		isCurrent,
		/**
		 * The value sealed with the current key: itself when it already is, null when it cannot be opened.
		 * @param {unknown} sealed
		 * @param {string} aad
		 * @returns {string | null}
		 */
		reseal: (sealed, aad) => {
			if (isCurrent(sealed)) return /** @type {string} */ (sealed);
			const opened = open(sealed, aad);
			return opened === null ? null : seal(opened, aad);
		},
	});
};

/** @typedef {ReturnType<typeof createSealer>} Sealer */
