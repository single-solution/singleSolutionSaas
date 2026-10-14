/**
 * Email addresses (pure): one canonical form per mailbox, trimmed and lower-cased; provider tricks (dots, `+tags`) are
 * not rewritten, because they are not universal. Phone numbers use the normalizer every product shares
 * (`normalisePhone` of `@ss/contracts/phone`).
 * @module
 */

/** RFC 5321 limits. */
const EMAIL_MAX = 254;
const LOCAL_MAX = 64;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const LOCAL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;

/**
 * Canonical email address, or null when it is not a plausible mailbox address.
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
