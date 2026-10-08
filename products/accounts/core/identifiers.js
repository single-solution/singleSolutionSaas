/**
 * E-mail addresses and phone numbers (pure), ported from the old Signups product (which generalised the ibrahimMobiles
 * phone rules from one country to E.164 for any country):
 *
 * - an e-mail address has one canonical form per mailbox: trimmed and lower-cased; provider tricks (dots, `+tags`) are
 *   not rewritten, because they are not universal;
 * - a phone number is stored as E.164 (`+` and 7–15 digits). `+…` and `00…` numbers need nothing more; a national
 *   number is accepted only with the website's default calling code (`phone_code.defaultCallingCode`), after its trunk
 *   prefix is dropped. The product never guesses a country.
 * @module
 */

/** RFC 5321 limits. */
const EMAIL_MAX = 254;
const LOCAL_MAX = 64;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const LOCAL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;

/**
 * Canonical e-mail address, or null when it is not a plausible mailbox address.
 * @param {unknown} input
 * @returns {string | null}
 */
export const normaliseEmail = (input) => {
	if (typeof input !== 'string') return null;
	const value = input.trim().toLowerCase();
	if (value.length < 3 || value.length > EMAIL_MAX) return null;
	const at = value.lastIndexOf('@');
	if (at <= 0 || at !== value.indexOf('@')) return null;
	const local = value.slice(0, at);
	const domain = value.slice(at + 1);
	if (local.length > LOCAL_MAX || !LOCAL.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..'))
		return null;
	const labels = domain.split('.');
	if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || /^\d+$/.test(labels.at(-1) ?? '')) return null;
	return value;
};

/** @param {string} email a canonical address */
export const emailDomain = (email) => email.slice(email.lastIndexOf('@') + 1);

/** Canonical E.164 shape. */
const E164 = /^\+[1-9]\d{6,14}$/;
const CALLING_CODE = /^\+[1-9]\d{0,2}$/;
const PHONE_CHARACTERS = /^[\d\s()+./-]+$/;

/**
 * A phone number as E.164, or null.
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
 * An address masked for display (`a•••@example.com`, `+92•••••••403`).
 * @param {string} value a canonical e-mail address or E.164 number
 */
export const maskAddress = (value) => {
	if (value.includes('@')) {
		const at = value.lastIndexOf('@');
		const local = value.slice(0, at);
		return `${local.slice(0, 1)}${'•'.repeat(Math.max(3, local.length - 1))}${value.slice(at)}`;
	}
	return `${value.slice(0, 3)}${'•'.repeat(Math.max(3, value.length - 6))}${value.slice(-3)}`;
};
