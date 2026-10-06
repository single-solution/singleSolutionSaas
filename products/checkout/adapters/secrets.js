/**
 * Sealing of the one secret Checkout keeps for a website: the merchant's `sk_` server key it uses to call the merchant's
 * other products (Coupons, Deals, Loyalty, Catalog) server to server. It is stored in the merchant's own database,
 * sealed with AES-256-GCM (AAD = website id) under a key derived with HKDF from `CHECKOUT_SEAL_KEY`, or — when that
 * is not set — from the product signing key. It is never returned by any API (only a masked preview).
 *
 * GAP: the Portal has no product-to-product credential (a short-lived token for "Checkout calls Coupons for website W"),
 * so the merchant pastes a server key once in the dashboard.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * @param {string} secret key material (base64 32 bytes, or the signing JWK JSON)
 * @returns {Buffer}
 */
export const sealingKey = (secret) =>
	Buffer.from(
		hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('ss-checkout'), Buffer.from('integration-key.v1'), 32),
	);

/**
 * @param {Buffer} key
 * @param {string} websiteId
 * @param {string} plain
 * @param {(n: number) => Uint8Array} [random]
 */
export const seal = (key, websiteId, plain, random = randomBytes) => {
	const iv = Buffer.from(random(12));
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(Buffer.from(websiteId));
	const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') };
};

/**
 * @param {Buffer} key
 * @param {string} websiteId
 * @param {unknown} sealed
 * @returns {string | null} null when it cannot be opened (other key, other website, tampered)
 */
export const unseal = (key, websiteId, sealed) => {
	const box = /** @type {{ v?: number, iv?: string, tag?: string, body?: string }} */ (sealed);
	if (box?.v !== 1 || typeof box.iv !== 'string' || typeof box.tag !== 'string' || typeof box.body !== 'string') return null;
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
		decipher.setAAD(Buffer.from(websiteId));
		decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
		return Buffer.concat([decipher.update(Buffer.from(box.body, 'base64')), decipher.final()]).toString('utf8');
	} catch {
		return null;
	}
};

/** Masked preview of a key (`sk_live_…abcd`). @param {string} key */
export const maskKey = (key) => `${key.slice(0, key.indexOf('_', 3) + 1 || 3)}…${key.slice(-4)}`;
