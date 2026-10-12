/**
 * Deal locks (PLAN 0.8.10 E18 `lockMinutes`): while a cart is open, each quote line with a per-unit deal carries a
 * signed lock — the deal, the variant, the variant's price and what the deal took off each unit, and when the lock
 * ends — so the order placed before then keeps that price even when the deal has ended or changed meanwhile (not when
 * it was deleted or its limit is used up). Locks are HMAC-SHA256 with a secret of the website kept in the product
 * database; the shopper's browser only carries them back. Pure (Node.js crypto only).
 * @module
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

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
