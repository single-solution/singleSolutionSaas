/**
 * Text, id and contact helpers (pure). Nothing assumes a country or a format beyond the standards the platform uses:
 * E.164 phone numbers and plain e-mail addresses, as in the order events' customer references.
 * @module
 */

/** Opaque ids as the events and the API carry them. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Machine keys (types, reasons, statuses, methods). */
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const PHONE = /^\+[1-9][0-9]{6,14}$/;
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** @param {unknown} value */
export const isId = (value) => typeof value === 'string' && ID.test(value);

/** @param {unknown} value */
export const isKey = (value) => typeof value === 'string' && KEY.test(value);

/** @param {unknown} value */
export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Free text as stored: CRLF → LF, control characters removed, trimmed. Length is checked by the validators.
 * @param {unknown} value
 * @returns {string}
 */
export const cleanText = (value) => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim() : '');

/**
 * A lower-cased e-mail address, else null.
 * @param {unknown} value
 * @returns {string | null}
 */
export const normalEmail = (value) => {
	if (typeof value !== 'string') return null;
	const email = value.trim().toLowerCase();
	return email.length <= 320 && EMAIL.test(email) ? email : null;
};

/**
 * An E.164 phone number (spaces, dashes, dots and brackets removed), else null.
 * @param {unknown} value
 * @returns {string | null}
 */
export const normalPhone = (value) => {
	if (typeof value !== 'string') return null;
	const phone = value.replace(/[\s().-]/g, '');
	return PHONE.test(phone) ? phone : null;
};

/**
 * Fill `{name}` placeholders.
 * @param {string} template
 * @param {Readonly<Record<string, string | number>>} params
 */
export const fill = (template, params) =>
	template.replace(/\{([A-Za-z_]\w*)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));
