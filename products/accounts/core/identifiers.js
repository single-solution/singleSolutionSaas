/**
 * E-mail addresses and phone numbers (pure):
 *
 * - an e-mail address has one canonical form per mailbox: trimmed and lower-cased; provider tricks (dots, `+tags`) are
 *   not rewritten, because they are not universal;
 * - a phone number is stored as E.164, normalised by the one normaliser every product shares (`normalisePhone` of
 *   `@ss/contracts/phone`) with the website's default calling code (`phone.defaultCallingCode`, else the business.json
 *   country's) and trunk prefix (`phone.trunkPrefix`, else the country's usual one).
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
