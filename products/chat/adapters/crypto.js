/**
 * Cryptography (node:crypto; the shared helpers of `@ss/protocol`):
 *
 * - **Sealing** (PLAN 0.4.8): the website's tool signing secret is kept in the product database sealed with the kit's
 *   sealer (`ss2.<keyId>.…`, AES-256-GCM under a key derived from `ENCRYPTION_KEY`, label `chat`), bound to the
 *   website. While the owner changes the key, `ENCRYPTION_KEY_PREVIOUS` still opens it and the Owner's Re-seal moves it
 *   to the new key. Lost `ENCRYPTION_KEY`: the secret no longer opens and a new one is made (the merchant copies it
 *   again).
 * - **Guest keys**: random (`randomToken`), kept only as SHA-256 hashes (`sha256Hex`).
 * - **Tool signatures**: `signWebhook`, `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` with the tool signing
 *   secret.
 * - **Attachment links** (CH-8): `<payload>.<signature>`, the payload the website, object key, name and type of a file
 *   (base64url JSON), the signature HMAC-SHA256 under a key derived from `ENCRYPTION_KEY`; links signed with
 *   `ENCRYPTION_KEY_PREVIOUS` keep opening while it is set, and a lost key ends old links (the views make new ones).
 * @module
 */
import { createSealer as createKitSealer } from '@ss/app-kit';
import { constantTimeEqual } from '@ss/protocol';
import { createHmac, hkdfSync } from 'node:crypto';

/**
 * @param {string} encryptionKey `ENCRYPTION_KEY` (at least 32 characters)
 * @param {string | null} [previousKey] `ENCRYPTION_KEY_PREVIOUS`, set only while the key changes
 */
export const createSealer = (encryptionKey, previousKey = null) => createKitSealer({ encryptionKey, previousKey, label: 'chat' });

/** @typedef {import('@ss/app-kit').Sealer} Sealer */

/** @typedef {{ w: string, k: string, n: string, t: string }} SignedFile the website, object key, name and type */

/** The longest attachment link token taken. */
const FILE_TOKEN_MAX = 4096;

/**
 * @param {string} encryptionKey `ENCRYPTION_KEY` (at least 32 characters)
 * @param {string | null} [previousKey] `ENCRYPTION_KEY_PREVIOUS`: links it signed keep opening while it is set
 */
export const createFileSigner = (encryptionKey, previousKey = null) => {
	const keys = [encryptionKey, ...(previousKey ? [previousKey] : [])].map((secret) =>
		Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), 'ss-chat.files.v1', 32)),
	);
	/** @param {string} payload @param {Buffer} [key] */
	const mac = (payload, key = /** @type {Buffer} */ (keys[0])) => createHmac('sha256', key).update(payload).digest();
	return Object.freeze({
		/** @param {SignedFile} file */
		sign: (file) => {
			const payload = Buffer.from(JSON.stringify({ w: file.w, k: file.k, n: file.n, t: file.t })).toString('base64url');
			return `${payload}.${mac(payload).toString('base64url')}`;
		},
		/**
		 * @param {unknown} token
		 * @returns {SignedFile | null} null when it is not a link this key signed
		 */
		open: (token) => {
			if (typeof token !== 'string' || token.length > FILE_TOKEN_MAX) return null;
			const [payload, signature, extra] = token.split('.');
			if (!payload || !signature || extra !== undefined) return null;
			const given = Buffer.from(signature, 'base64url');
			const signed = keys.some((key) => constantTimeEqual(given, mac(payload, key)));
			if (!signed) return null;
			try {
				const file = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
				return ['w', 'k', 'n', 't'].every((field) => typeof file?.[field] === 'string') ? file : null;
			} catch {
				return null;
			}
		},
	});
};

/** @typedef {ReturnType<typeof createFileSigner>} FileSigner */
