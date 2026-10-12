/**
 * Guest checkout (PLAN 0.8.10 E21): a guest orders with a name and phone (and an e-mail address when they like); the
 * phone is normalised to E.164 as Accounts does (`defaultCallingCode` and `trunkPrefix` of `checkout`), so one person
 * has one customer record. A guest order gets a key — 32 random characters, shown once and kept only as its hash —
 * that the guest sends as `SS-Order-Key` to read, pay, cancel and send proof for it. Orders and customers also keep
 * the phone's last 10 digits for search (E31). Pure (Node.js crypto only).
 * @module
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const E164 = /^\+[1-9]\d{6,14}$/;
const CALLING_CODE = /^\+[1-9]\d{0,2}$/;
const PHONE_CHARACTERS = /^[\d\s()+./-]+$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
/** An order key's characters. */
const KEY_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/** An order key's length. */
export const ORDER_KEY_LENGTH = 32;

/**
 * A phone number as E.164, or null (Accounts' rules: `+…` and `00…` as they are; a national number only with the
 * default calling code, after its trunk prefix).
 * @param {unknown} input
 * @param {{ defaultCallingCode?: string, trunkPrefix?: string }} [options]
 * @returns {string | null}
 */
export const normalisePhone = (input, { defaultCallingCode = '', trunkPrefix = '' } = {}) => {
	if (typeof input !== 'string') return null;
	const raw = input.trim();
	if (raw.length === 0 || raw.length > 40 || !PHONE_CHARACTERS.test(raw)) return null;
	const plus = raw.indexOf('+');
	if (plus > 0 || raw.lastIndexOf('+') !== plus) return null;
	const digits = raw.replace(/\D/g, '');
	/** @param {string} value */
	const canonical = (value) => (E164.test(`+${value}`) ? `+${value}` : null);
	if (plus === 0) return canonical(digits);
	if (digits.startsWith('00')) return canonical(digits.slice(2));
	if (!CALLING_CODE.test(defaultCallingCode)) return null;
	const national = /^\d{1,2}$/.test(trunkPrefix) && digits.startsWith(trunkPrefix) ? digits.slice(trunkPrefix.length) : digits;
	return national.length < 4 ? null : canonical(`${defaultCallingCode.slice(1)}${national}`);
};

/**
 * The last 10 digits of a phone (search, E31).
 * @param {unknown} phone
 */
export const phoneDigitsOf = (phone) => (typeof phone === 'string' ? phone.replace(/\D/g, '').slice(-10) : '');

/**
 * Check a guest's details (`customer { name, phone, email? }`).
 * @param {unknown} body
 * @param {{ defaultCallingCode?: string, trunkPrefix?: string }} settings the `checkout` settings
 * @returns {{ ok: true, value: { name: string, phone: string, email: string } } | { ok: false, field: string, message: string }}
 */
export const checkGuest = (body, settings) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : null;
	if (!input) return { ok: false, field: 'customer', message: 'Give your name and phone number.' };
	const name = typeof input.name === 'string' ? input.name.trim() : '';
	if (!name || name.length > 120)
		return { ok: false, field: 'customer/name', message: 'Give your name (at most 120 characters).' };
	const phone = normalisePhone(input.phone, {
		defaultCallingCode: String(settings.defaultCallingCode ?? ''),
		trunkPrefix: String(settings.trunkPrefix ?? ''),
	});
	if (!phone) return { ok: false, field: 'customer/phone', message: 'Give your phone number with its country code.' };
	const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
	if (input.email !== undefined && input.email !== null && input.email !== '' && !EMAIL.test(email))
		return { ok: false, field: 'customer/email', message: 'Give a valid e-mail address or none.' };
	return { ok: true, value: { name, phone, email } };
};

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
