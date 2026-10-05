/**
 * E-mail addresses (pure): one canonical form per mailbox and domain checks for the disposable-address block list.
 * The canonical form is trimmed and lower-cased (local part included — virtually every provider treats it
 * case-insensitively, and one customer must not end up with two accounts). Provider-specific rewriting (dots, `+tags`)
 * is deliberately not applied: it is not universal and would merge distinct mailboxes.
 * @module
 */

/** RFC 5321 limits. */
export const EMAIL_MAX = 254;
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

/**
 * Domain of a canonical address.
 * @param {string} email
 */
export const emailDomain = (email) => email.slice(email.lastIndexOf('@') + 1);

/**
 * True when the address's domain (or a parent domain) is in a block list (entries are domains, case-insensitive).
 * @param {string} email canonical address
 * @param {readonly string[]} blocked
 */
export const isBlockedDomain = (email, blocked) => {
	const domain = emailDomain(email);
	return blocked.some((entry) => {
		const d = String(entry).trim().toLowerCase().replace(/^\.+/, '');
		return d.length > 0 && (domain === d || domain.endsWith(`.${d}`));
	});
};

/**
 * Address masked for display (`a•••@example.com`).
 * @param {string} email
 */
export const maskEmail = (email) => {
	const at = email.lastIndexOf('@');
	const local = email.slice(0, at);
	return `${local.slice(0, 1)}${'•'.repeat(Math.max(3, local.length - 1))}${email.slice(at)}`;
};
