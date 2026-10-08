/**
 * Cryptography (node:crypto):
 *
 * - **Sealing** (PLAN 0.4.8): the website's tool signing secret is kept in the product database encrypted with
 *   AES-256-GCM under a key derived (HKDF-SHA256) from `ENCRYPTION_KEY`, bound to the website. Lost or changed
 *   `ENCRYPTION_KEY`: the secret no longer opens and a new one is made (the merchant copies it again).
 * - **Guest keys**: random, kept only as SHA-256 hashes.
 * - **Tool signatures**: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` with the tool signing secret.
 * @module
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { signatureBase } from '../core/tools.js';

/** A URL-safe random secret of `bytes` bytes. @param {number} [bytes] */
export const randomSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** SHA-256 hex. @param {string} text */
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * @param {string} encryptionKey `ENCRYPTION_KEY` (at least 32 characters)
 */
export const createSealer = (encryptionKey) => {
	const key = Buffer.from(hkdfSync('sha256', Buffer.from(encryptionKey, 'utf8'), Buffer.alloc(0), 'ss-chat.seal.v1', 32));
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

/**
 * The signature header of a tool or booking call.
 * @param {string} secret
 * @param {string} body
 * @param {number} nowMs
 */
export const signTool = (secret, body, nowMs) => {
	const t = Math.floor(nowMs / 1000);
	return `t=${t},v1=${createHmac('sha256', secret).update(signatureBase(t, body)).digest('hex')}`;
};
