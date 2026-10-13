/**
 * Sealing (PLAN 0.4.8, 0.8.10 D11): the real words of a sensitive message (its codes and links) are kept, only while
 * the message still has attempts to make, encrypted with AES-256-GCM under a key derived (HKDF-SHA256) from
 * `ENCRYPTION_KEY` and bound to the website and the recipient. Lost or changed `ENCRYPTION_KEY`: a waiting sensitive
 * message no longer opens and fails.
 * @module
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * @param {string} encryptionKey `ENCRYPTION_KEY` (at least 32 characters)
 */
export const createSealer = (encryptionKey) => {
	const key = Buffer.from(
		hkdfSync('sha256', Buffer.from(encryptionKey, 'utf8'), Buffer.alloc(0), 'ss-notifications.seal.v1', 32),
	);
	return Object.freeze({
		/** @param {string} plaintext @param {string} aad */
		seal: (plaintext, aad) => {
			const iv = randomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', key, iv);
			cipher.setAAD(Buffer.from(aad, 'utf8'));
			const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
			return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
		},
		/**
		 * @param {unknown} sealed
		 * @param {string} aad
		 * @returns {string | null} null when it cannot be opened (another key, tampered)
		 */
		open: (sealed, aad) => {
			if (typeof sealed !== 'string') return null;
			const [version, iv, tag, data, extra] = sealed.split('.');
			if (version !== 'v1' || !iv || !tag || data === undefined || extra !== undefined) return null;
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
