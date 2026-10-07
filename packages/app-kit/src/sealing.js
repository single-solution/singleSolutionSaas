/**
 * Encryption of stored secrets (PLAN 0.4.8): AES-256-GCM with a key derived (HKDF-SHA256) from `ENCRYPTION_KEY`. The
 * derived key lives only in memory; `ENCRYPTION_KEY` is never stored, logged or sent. Each value is bound to where it
 * is stored (`aad`), so a sealed value copied to another website or connection does not open.
 * @module
 */
import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';

const VERSION = 'v1';

/**
 * @param {string} encryptionKey
 * @param {(length: number) => Uint8Array} randomBytes
 */
export const createSealer = (encryptionKey, randomBytes) => {
	if (typeof encryptionKey !== 'string' || encryptionKey.length < 32)
		throw new TypeError('ENCRYPTION_KEY must be at least 32 characters');
	const key = Buffer.from(hkdfSync('sha256', Buffer.from(encryptionKey, 'utf8'), Buffer.alloc(0), 'ss-app-kit.seal.v1', 32));
	return Object.freeze({
		/**
		 * @param {string} plaintext
		 * @param {string} aad
		 * @returns {string} `v1.<iv>.<tag>.<ciphertext>` (base64url)
		 */
		seal: (plaintext, aad) => {
			const iv = Buffer.from(randomBytes(12));
			const cipher = createCipheriv('aes-256-gcm', key, iv);
			cipher.setAAD(Buffer.from(aad, 'utf8'));
			const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
			return `${VERSION}.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
		},
		/**
		 * @param {unknown} sealed
		 * @param {string} aad
		 * @returns {string | null} null when the value cannot be opened (another key, tampered, malformed)
		 */
		open: (sealed, aad) => {
			if (typeof sealed !== 'string') return null;
			const [version, iv, tag, data, extra] = sealed.split('.');
			if (version !== VERSION || !iv || !tag || data === undefined || extra !== undefined) return null;
			try {
				const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
				decipher.setAAD(Buffer.from(aad, 'utf8'));
				decipher.setAuthTag(Buffer.from(tag, 'base64url'));
				return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
			} catch {
				return null;
			}
		},
	});
};

/** @typedef {ReturnType<typeof createSealer>} Sealer */
