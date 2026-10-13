/**
 * Guest checkout (PLAN 0.8.10 E21): a guest orders with a name and phone (and an e-mail address when they like); the
 * phone is read as E.164 by the normaliser every product shares (`@ss/contracts/phone`, K12) with the website's phone
 * rules (`phoneRules`: the `checkout` settings `defaultCallingCode`, else the business.json country's, and
 * `trunkPrefix`), so one person has one customer record. A guest order gets a key — 32 random characters, shown once
 * and kept only as its hash — that the guest sends as `SS-Order-Key` to read, pay, cancel and send proof for it (made
 * and checked in `adapters/crypto.js`). Orders and customers also keep the phone's last 10 digits for search (E31). No
 * I/O.
 * @module
 */
import { normalisePhone, phoneInCountries, websiteCallingCode } from '@ss/contracts/phone';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
/** An order key's length. */
export const ORDER_KEY_LENGTH = 32;
/** A phone of a country the website does not serve (SE-5). */
export const COUNTRY_REFUSED = Object.freeze({
	message: 'Give a phone number of a country this shop serves.',
	code: 'country_not_allowed',
});

/**
 * How a website reads the phones shoppers type (K12): its default calling code (`+92`, or '' when it has none: a
 * number must then start with + or 00), its trunk prefix ('' = the country's usual one) and the countries whose phones
 * guests and alerts may use (`countries`, ISO codes; [] = any, SE-5).
 * @typedef {{ defaultCallingCode: string, trunkPrefix: string, countries: string[] }} PhoneRules
 */

/**
 * A website's phone rules from its `checkout` settings and its business.json country.
 * @param {Record<string, unknown>} checkout the `checkout` settings
 * @param {unknown} country business.json `country`
 * @returns {PhoneRules}
 */
export const phoneRules = (checkout, country) => ({
	defaultCallingCode: websiteCallingCode(checkout.defaultCallingCode, country),
	trunkPrefix: typeof checkout.trunkPrefix === 'string' ? checkout.trunkPrefix : '',
	countries: Array.isArray(checkout.countries) ? checkout.countries.filter((code) => typeof code === 'string') : [],
});

/**
 * Whether a phone (E.164) is one guests and alerts may use: of a country the website serves (SE-5).
 * @param {string} phone @param {PhoneRules} rules
 */
export const phoneAllowed = (phone, rules) => phoneInCountries(phone, rules.countries);

/**
 * The last 10 digits of a phone (search, E31).
 * @param {unknown} phone
 */
export const phoneDigitsOf = (phone) => (typeof phone === 'string' ? phone.replace(/\D/g, '').slice(-10) : '');

/**
 * Check a guest's details (`customer { name, phone, email? }`); the phone must be of a country the website serves.
 * @param {unknown} body
 * @param {PhoneRules} rules the website's phone rules
 * @returns {{ ok: true, value: { name: string, phone: string, email: string } }
 *   | { ok: false, field: string, message: string, code?: string }}
 */
export const checkGuest = (body, rules) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : null;
	if (!input) return { ok: false, field: 'customer', message: 'Give your name and phone number.' };
	const name = typeof input.name === 'string' ? input.name.trim() : '';
	if (!name || name.length > 120)
		return { ok: false, field: 'customer/name', message: 'Give your name (at most 120 characters).' };
	const phone = normalisePhone(input.phone, rules);
	if (!phone) return { ok: false, field: 'customer/phone', message: 'Give your phone number with its country code.' };
	if (!phoneAllowed(phone, rules)) return { ok: false, field: 'customer/phone', ...COUNTRY_REFUSED };
	const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
	if (input.email !== undefined && input.email !== null && input.email !== '' && !EMAIL.test(email))
		return { ok: false, field: 'customer/email', message: 'Give a valid e-mail address or none.' };
	return { ok: true, value: { name, phone, email } };
};
