/**
 * Cryptography (node:crypto), kept out of `core/` (pure logic):
 *
 * - **Order keys** (PLAN 0.8.10 E21): a guest order's key — 32 random characters, shown once and kept only as its
 *   SHA-256 hash — that the guest sends as `SS-Order-Key` to read, pay, cancel and send proof for it; alert stop links
 *   use the same kind of key (E34).
 * - **Deal locks** (E18 `lockMinutes`): while a cart is open, each quote line with a per-unit deal carries a signed
 *   lock — the deal, the variant, the variant's price and what the deal took off each unit, and when the lock ends — so
 *   the order placed before then keeps that price even when the deal has ended or changed meanwhile (not when it was
 *   deleted or its limit is used up). Locks are HMAC-SHA256 with a secret of the website kept in the product database
 *   (`adapters/site-secret.js`); the shopper's browser only carries them back.
 * - **Media signatures** (SEO audit G1): the stable address of a catalog image on the merchant's website
 *   (`<mediaPath>/<signature>/<key>`) carries an HMAC-SHA256 of its storage key with the same secret, so the website's
 *   media route gets a file from storage only for keys Ecommerce named; it never changes for the same file.
 * @module
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ORDER_KEY_LENGTH } from '../core/guests.js';

/** An order key's characters. */
const KEY_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** A new order key. */
export const newOrderKey = () => {
	const bytes = randomBytes(ORDER_KEY_LENGTH);
	return [...bytes].map((byte) => KEY_CHARACTERS[byte % KEY_CHARACTERS.length]).join('');
};

/**
 * The hash an order keeps of its key.
 * @param {string} key
 */
export const orderKeyHash = (key) => createHash('sha256').update(key).digest('base64url');

/**
 * Whether a key sent opens an order.
 * @param {unknown} key
 * @param {string | null | undefined} hash
 */
export const keyOpens = (key, hash) => {
	if (typeof key !== 'string' || key.length !== ORDER_KEY_LENGTH || !hash) return false;
	const given = Buffer.from(orderKeyHash(key));
	const kept = Buffer.from(hash);
	return given.length === kept.length && timingSafeEqual(given, kept);
};

/** A lock as signed. @typedef {{ dealId: string, variantId: string, price: number, perUnit: number, exp: number }} Lock */

/** A lock text is at most this long. */
export const MAX_LOCK = 600;

/**
 * @param {string} secret
 * @param {string} websiteId
 * @param {string} body base64url of the lock's JSON
 */
const signatureOf = (secret, websiteId, body) => createHmac('sha256', secret).update(`${websiteId}.${body}`).digest('base64url');

/**
 * Sign a lock.
 * @param {Lock} lock
 * @param {{ secret: string, websiteId: string }} key
 */
export const signLock = (lock, { secret, websiteId }) => {
	const body = Buffer.from(
		JSON.stringify({ d: lock.dealId, v: lock.variantId, p: lock.price, u: lock.perUnit, e: lock.exp }),
	).toString('base64url');
	return `${body}.${signatureOf(secret, websiteId, body)}`;
};

/**
 * Read a lock the browser sent back: null when it is not one, its signature is wrong or it has ended.
 * @param {unknown} text
 * @param {{ secret: string, websiteId: string, now: number }} key
 * @returns {Lock | null}
 */
export const readLock = (text, { secret, websiteId, now }) => {
	if (typeof text !== 'string' || text.length === 0 || text.length > MAX_LOCK) return null;
	const [body, signature, ...rest] = text.split('.');
	if (!body || !signature || rest.length > 0) return null;
	const expected = Buffer.from(signatureOf(secret, websiteId, body));
	const given = Buffer.from(signature);
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
	try {
		const raw = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
		const lock = { dealId: raw.d, variantId: raw.v, price: raw.p, perUnit: raw.u, exp: raw.e };
		if (
			typeof lock.dealId !== 'string' ||
			typeof lock.variantId !== 'string' ||
			!Number.isSafeInteger(lock.price) ||
			!Number.isSafeInteger(lock.perUnit) ||
			!Number.isSafeInteger(lock.exp) ||
			lock.perUnit <= 0 ||
			lock.exp <= now
		)
			return null;
		return lock;
	} catch {
		return null;
	}
};

/** A media signature's length (base64url characters: 96 bits). */
const MEDIA_SIGNATURE_LENGTH = 16;

/**
 * The signature of a catalog file's stable address.
 * @param {string} secret the website's secret
 * @param {string} key the storage key
 */
export const mediaSignature = (secret, key) =>
	createHmac('sha256', secret).update(`media.${key}`).digest('base64url').slice(0, MEDIA_SIGNATURE_LENGTH);

/**
 * Whether a signature sent with a storage key is the one Ecommerce gave it.
 * @param {string} secret @param {string} key @param {unknown} signature
 */
export const mediaSignatureOk = (secret, key, signature) => {
	if (typeof signature !== 'string') return false;
	const expected = Buffer.from(mediaSignature(secret, key));
	const given = Buffer.from(signature);
	return expected.length === given.length && timingSafeEqual(expected, given);
};
