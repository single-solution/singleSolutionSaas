/**
 * Guest checkout (PLAN 0.8.10 E21; dynamic model §5): a guest orders with a name and the contact the `checkout` setting
 * `guestIdentity` asks for — a phone (the default), an email address, or either — and a phone while
 * `checkout.phoneRequired` is on. The phone is read as E.164 by the normalizer every product shares
 * (`@ss/contracts/phone`, K12) with the website's phone rules (`phoneRules`: the `checkout` settings
 * `defaultCallingCode`, else the business.json country's, and `trunkPrefix`); the email address is kept in lower case.
 * One guest has one customer record, found by its key (`guestKey`): `p:<E.164>` or `e:<email>` (under `either` the phone
 * when given). A guest order gets a key — 32 random characters, shown once and kept only as its hash — that the guest
 * sends as `SS-Order-Key` to read, pay, cancel and send proof for it (made and checked in `adapters/crypto.js`). Orders
 * and customers also keep the phone's digits for search (E31). No I/O.
 * @module
 */
import { normalizeEmail } from '@ss/contracts/email';
import { normalisePhone, phoneInCountries, websiteCallingCode } from '@ss/contracts/phone';
import { postcodeKey } from './address.js';

/** An order key's length. */
export const ORDER_KEY_LENGTH = 32;
/** A phone of a country the website does not serve (SE-5). */
export const COUNTRY_REFUSED = Object.freeze({
	message: 'Give a phone number of a country this shop serves.',
	code: 'country_not_allowed',
});

/**
 * How a website reads the phones shoppers type (K12): its default calling code (`+44`, or '' when it has none: a
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
 * A phone's digits, its whole number (search, E31).
 * @param {unknown} phone
 */
export const phoneDigitsOf = (phone) => (typeof phone === 'string' ? phone.replace(/\D/g, '') : '');

/**
 * The digit runs a staff search looks for anywhere in phones (E31), none for fewer than 4 digits: the digits typed,
 * without their leading zeros too (a trunk or international prefix), and the whole number when the website's phone
 * rules read it (a national number typed with its trunk prefix, `06 12 34 56 78`, finds `+33612345678`).
 * @param {string} q @param {Pick<PhoneRules, 'defaultCallingCode' | 'trunkPrefix'> | null} rules
 * @returns {string[]}
 */
export const phoneSearchOf = (q, rules) => {
	const digits = q.replace(/\D/g, '');
	if (digits.length < 4) return [];
	const phone = rules ? normalisePhone(q, rules) : null;
	return [...new Set([digits, digits.replace(/^0+/, ''), phone ? phone.slice(1) : ''])].filter((run) => run.length >= 4);
};

/** What guests check out by (`checkout.guestIdentity`). */
export const GUEST_IDENTITIES = Object.freeze(/** @type {const} */ (['phone', 'email', 'either']));
/** @typedef {typeof GUEST_IDENTITIES[number]} GuestIdentity */

/**
 * A guest's customer-record key: `p:<E.164>` or `e:<email>` (under `either` the phone when given); '' when the
 * contact it needs is missing.
 * @param {{ phone: string, email: string }} who @param {GuestIdentity} identity
 */
export const guestKeyOf = ({ phone, email }, identity) => {
	if (identity === 'email') return email ? `e:${email}` : '';
	if (phone) return `p:${phone}`;
	return identity === 'either' && email ? `e:${email}` : '';
};

/**
 * How a website takes guests (`checkout` settings `guestIdentity` and `phoneRequired`).
 * @param {Record<string, unknown>} checkout
 * @returns {{ identity: GuestIdentity, phoneRequired: boolean }}
 */
export const guestRules = (checkout) => ({
	identity: GUEST_IDENTITIES.includes(/** @type {GuestIdentity} */ (checkout.guestIdentity))
		? /** @type {GuestIdentity} */ (checkout.guestIdentity)
		: 'phone',
	phoneRequired: checkout.phoneRequired !== false,
});

/**
 * Check a guest's details (`customer { name, phone?, email? }`): the phone when guests check out by phone or a phone is
 * needed, the email address when they check out by email, one of them at least under `either`; a phone must be of a
 * country the website serves.
 * @param {unknown} body
 * @param {PhoneRules} rules the website's phone rules
 * @param {{ identity: GuestIdentity, phoneRequired: boolean }} [guests] the website's guest rules
 * @returns {{ ok: true, value: { name: string, phone: string, email: string, guestKey: string } }
 *   | { ok: false, field: string, message: string, code?: string }}
 */
export const checkGuest = (body, rules, guests = { identity: 'phone', phoneRequired: true }) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : null;
	if (!input) return { ok: false, field: 'customer', message: 'Give your name and contact details.' };
	const name = typeof input.name === 'string' ? input.name.trim() : '';
	if (!name || name.length > 120)
		return { ok: false, field: 'customer/name', message: 'Give your name (at most 120 characters).' };
	const contact = checkGuestContact(input, rules, guests);
	if (!contact.ok) return { ...contact, field: `customer/${contact.field}` };
	return { ok: true, value: { name, ...contact.value } };
};

/**
 * Check the contact a guest is known by everywhere guests are known — checkout, alerts, customers staff add (E15):
 * `{ phone?, email? }` as {@link checkGuest} reads them, by the website's one setting `checkout.guestIdentity`.
 * @param {Record<string, unknown>} input
 * @param {PhoneRules} rules the website's phone rules
 * @param {{ identity: GuestIdentity, phoneRequired: boolean }} guests the website's guest rules
 * @returns {{ ok: true, value: { phone: string, email: string, guestKey: string } }
 *   | { ok: false, field: 'phone' | 'email', message: string, code?: string }}
 */
export const checkGuestContact = (input, rules, guests) => {
	const typedPhone = input.phone !== undefined && input.phone !== null && input.phone !== '';
	const phone = typedPhone ? normalisePhone(input.phone, rules) : null;
	if (typedPhone && !phone) return { ok: false, field: 'phone', message: 'Give your phone number with its country code.' };
	if (phone && !phoneAllowed(phone, rules)) return { ok: false, field: 'phone', ...COUNTRY_REFUSED };
	const email = normalizeEmail(input.email) ?? '';
	if (input.email !== undefined && input.email !== null && input.email !== '' && !email)
		return { ok: false, field: 'email', message: 'Give a valid email address or none.' };
	if (!phone && (guests.identity === 'phone' || guests.phoneRequired))
		return { ok: false, field: 'phone', message: 'Give your phone number with its country code.' };
	if (!email && guests.identity === 'email') return { ok: false, field: 'email', message: 'Give your email address.' };
	const value = { phone: phone ?? '', email };
	const guestKey = guestKeyOf(value, guests.identity);
	if (!guestKey) return { ok: false, field: 'phone', message: 'Give your phone number or email address.' };
	return { ok: true, value: { ...value, guestKey } };
};

/** The most addresses a customer record keeps (E46), the newest first. */
export const MAX_ADDRESSES = 6;
/** The most opening points staff give a customer they add. */
const MAX_OPENING_POINTS = 1_000_000_000;

/**
 * Check a customer staff add without an account (E46): a guest record by the contact guests are known by (E15,
 * `checkout.guestIdentity`), `{ name, phone?, email?, city?, note?, points?, loyaltyMember? }` — `points`: the opening
 * loyalty points; `loyaltyMember`: the loyalty member flag (E47).
 * @param {unknown} body
 * @param {PhoneRules} rules the website's phone rules
 * @param {{ identity: GuestIdentity, phoneRequired: boolean }} guests the website's guest rules
 * @returns {{ ok: true, value: { name: string, phone: string, email: string, guestKey: string, city: string,
 *   note: string, points: number, loyaltyMember: boolean } } | { ok: false, field: string, message: string, code?: string }}
 */
export const checkNewCustomer = (body, rules, guests) => {
	const input = typeof body === 'object' && body !== null ? /** @type {Record<string, unknown>} */ (body) : {};
	const who = checkGuest(input, rules, guests);
	if (!who.ok)
		return {
			...who,
			field: who.field.replace(/^customer\/?/, '') || 'name',
			message: who.message.replace(/\byour (name|phone|email)\b/, 'the $1'),
		};
	const city = typeof input.city === 'string' ? input.city.trim() : input.city === undefined ? '' : null;
	if (city === null || city.length > 80) return { ok: false, field: 'city', message: 'city is at most 80 characters.' };
	const note = typeof input.note === 'string' ? input.note.trim() : input.note === undefined ? '' : null;
	if (note === null || note.length > 5000) return { ok: false, field: 'note', message: 'note is at most 5,000 characters.' };
	const points = input.points ?? 0;
	if (!Number.isSafeInteger(points) || Number(points) < 0 || Number(points) > MAX_OPENING_POINTS)
		return { ok: false, field: 'points', message: 'points is a whole number of opening points from 0.' };
	if (input.loyaltyMember !== undefined && typeof input.loyaltyMember !== 'boolean')
		return { ok: false, field: 'loyaltyMember', message: 'loyaltyMember is true or false.' };
	return {
		ok: true,
		value: { ...who.value, city, note, points: Number(points), loyaltyMember: input.loyaltyMember === true },
	};
};

/**
 * The same address, whatever the letter case and spaces.
 * @param {Record<string, unknown>} address
 */
const addressKey = (address) =>
	['name', 'phone', 'line1', 'line2', 'city', 'area', 'region', 'postalCode', 'country']
		.map((field) =>
			field === 'postalCode'
				? postcodeKey(address[field])
				: String(address[field] ?? '')
						.trim()
						.replace(/\s+/g, ' ')
						.toLowerCase(),
		)
		.join('|');

/**
 * A customer's addresses with one more (E46): the new one first, the same address once, at most {@link MAX_ADDRESSES}.
 * @template {Record<string, unknown>} A
 * @param {ReadonlyArray<A>} addresses @param {A} address
 * @returns {A[]}
 */
export const savedAddresses = (addresses, address) => {
	const key = addressKey(address);
	return [address, ...addresses.filter((entry) => addressKey(entry) !== key)].slice(0, MAX_ADDRESSES);
};
