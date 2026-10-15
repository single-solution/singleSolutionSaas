/**
 * Email addresses (PLAN 0.8.10, like phone numbers): one check and one stored form for every product and the Portal, so
 * an address one unit accepts is never refused by another (a user Accounts signs up always gets codes and resets from
 * Notifications). Pure and browser-safe: products' `core/` and widgets use it through `@ss/contracts/email`.
 *
 * An address is a mailbox `local@domain` that every sending path can deliver to:
 *
 * - the local part is a dot-atom of ASCII letters, digits and ``! # $ % & ' * + / = ? ^ _ ` { | } ~ -``, with single
 *   dots between them (none first or last); at most 64 characters. Plus-addressing (`ana+news@…`) is kept as typed.
 *   Quoted local parts (`"a b"@…`) and non-ASCII ones are refused: they need SMTPUTF8, which not every sender has;
 * - the domain has at least two labels of ASCII letters, digits and hyphens (1–63 each, no hyphen first or last) and a
 *   top-level label of 2 or more characters that is not all digits (so `xn--p1ai` yes, IP addresses and single-label
 *   names no; domain literals `[…]` are refused). A domain typed in Unicode (`bücher.de`, `пример.рф`) is accepted and
 *   stored as punycode (`xn--bcher-kva.de`), the form every sender takes and DNS uses, so one mailbox has one stored
 *   form however it was typed;
 * - the whole stored address is at most 254 characters (RFC 5321).
 *
 * The stored form is trimmed and entirely in lower case. RFC 5321 lets a mail server treat the local part's case as
 * significant, but no usual one does, and one person must have one record: `Ana@Example.com` is `ana@example.com`.
 * Provider tricks (dots in Gmail addresses, `+tags`) are not rewritten: they are not universal.
 * @module
 */

/** RFC 5321 limits: the whole address and its local part. */
const EMAIL_MAX = 254;
const LOCAL_MAX = 64;

/** A dot-atom local part (RFC 5322 `atext`, ASCII), already in lower case. */
const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
/** One domain label (letters, digits and hyphens, no hyphen first or last). */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** A domain typed in Unicode: letters, marks and digits of any script, hyphens and full stops (`.`, `。`, `．`, `｡`). */
const UNICODE_DOMAIN = /^[\p{L}\p{M}\p{N}.。．｡-]+$/u;
/** Printable ASCII only. */
const ASCII = /^[ -~]*$/;

/**
 * A domain in lower-case ASCII (Unicode domains as punycode, by the WHATWG URL rules every browser and Node.js share),
 * or null.
 * @param {string} domain
 * @returns {string | null}
 */
const asciiDomain = (domain) => {
	if (ASCII.test(domain)) return domain.toLowerCase();
	if (!UNICODE_DOMAIN.test(domain)) return null;
	try {
		return new URL(`http://${domain}/`).hostname;
	} catch {
		return null;
	}
};

/**
 * An email address in its stored form (trimmed, lower case, the domain in punycode), or null when it is not an address
 * every sending path can deliver to (see the module rules).
 * @param {unknown} input
 * @returns {string | null}
 */
export const normalizeEmail = (input) => {
	if (typeof input !== 'string') return null;
	const value = input.trim();
	const at = value.indexOf('@');
	if (value.length > EMAIL_MAX || at <= 0 || at !== value.lastIndexOf('@')) return null;
	const local = value.slice(0, at).toLowerCase();
	if (local.length > LOCAL_MAX || !LOCAL.test(local)) return null;
	const domain = asciiDomain(value.slice(at + 1));
	if (domain === null) return null;
	const labels = domain.split('.');
	const top = /** @type {string} */ (labels.at(-1));
	if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || top.length < 2 || /^\d+$/.test(top)) return null;
	const email = `${local}@${domain}`;
	return email.length <= EMAIL_MAX ? email : null;
};

/**
 * True for an email address already in its stored form ({@link normalizeEmail} gives it back unchanged): for checking
 * stored and received values before sending. Check what people type with {@link normalizeEmail}.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isEmailAddress = (value) => typeof value === 'string' && normalizeEmail(value) === value;
