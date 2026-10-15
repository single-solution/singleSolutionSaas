/**
 * business.json version 1 (PLAN 0.4.9): `https://<domain>/.well-known/business.json` gives
 * `{ name, logo, email, phone, address, country, timeZone, currency, currencies, language }`. Only `name` is required.
 * Every value is plain text but `currencies`, a list. `currency` is the store currency (ISO 4217), `currencies` the
 * ones the business takes (the store currency first; at most {@link MAX_CURRENCIES}), `language` its default language
 * (BCP 47; fixed-choices audit K5).
 * @module
 */
import { isObject } from './util.js';

/** @typedef {import('./types.js').BusinessInfo} BusinessInfo */
/**
 * @template T
 * @typedef {import('./types.js').ValidationResult<T>} ValidationResult
 */

/** The template every product's docs ship (example values only). */
export const BUSINESS_JSON_TEMPLATE = Object.freeze({
	name: 'Example Business',
	logo: 'https://www.example.com/logo.png',
	email: 'hello@example.com',
	phone: '+1 555 0100',
	address: '1 Example Street, Example City',
	country: 'US',
	timeZone: 'America/New_York',
	currency: 'USD',
	currencies: Object.freeze(['USD']),
	language: 'en-US',
});

/** The most currencies a business lists. */
export const MAX_CURRENCIES = 20;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ().-]{3,40}$/;
const COUNTRY = /^[A-Za-z]{2}$/;
const CURRENCY = /^[A-Za-z]{3}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/;

/**
 * True when the text has a control character other than tab, line feed and carriage return.
 * @param {string} value
 * @returns {boolean}
 */
const hasControl = (value) => {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
	}
	return false;
};

/**
 * Trimmed plain text, or `null` when not a string, empty, too long or containing control characters (line breaks are
 * allowed only when `multiline`).
 * @param {unknown} value
 * @param {number} max
 * @param {boolean} [multiline]
 * @returns {string | null}
 */
const text = (value, max, multiline = false) => {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed === '' || trimmed.length > max || hasControl(trimmed)) return null;
	if (!multiline && /[\r\n\t]/.test(trimmed)) return null;
	return trimmed;
};

/**
 * Canonical IANA time zone name, or `null` when the runtime does not know it.
 * @param {unknown} value
 * @returns {string | null}
 */
const timeZoneOf = (value) => {
	const name = text(value, 64);
	if (name === null) return null;
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
	} catch {
		return null;
	}
};

/**
 * @param {unknown} value
 * @returns {string | null}
 */
const httpsUrl = (value) => {
	const raw = text(value, 2048);
	if (raw === null) return null;
	try {
		const url = new URL(raw);
		return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : null;
	} catch {
		return null;
	}
};

/**
 * @param {string | null} value
 * @param {RegExp} pattern
 * @returns {string | null}
 */
const matching = (value, pattern) => (value !== null && pattern.test(value) ? value : null);

/** @param {unknown} value an ISO 4217 code in capitals, or null */
const currencyOf = (value) => matching(text(value, 3), CURRENCY)?.toUpperCase() ?? null;

/**
 * The currencies a business takes: its store currency first, each once, at most {@link MAX_CURRENCIES}; values that
 * are no currency code are dropped.
 * @param {unknown} value
 * @param {string | null} currency
 * @returns {string[]}
 */
const currenciesOf = (value, currency) => {
	const listed = Array.isArray(value) ? value.map(currencyOf).filter((code) => code !== null) : [];
	return [...new Set([...(currency === null ? [] : [currency]), ...listed])].slice(0, MAX_CURRENCIES);
};

/** @param {unknown} value a canonical BCP 47 language tag, or null */
const languageOf = (value) => {
	const tag = matching(text(value, 35), LANGUAGE);
	if (tag === null) return null;
	try {
		return Intl.getCanonicalLocales(tag)[0] ?? null;
	} catch {
		return null;
	}
};

/**
 * Validate and normalize a business.json document. Fails only when it is not an object or `name` is missing or
 * invalid; any other invalid field is dropped (`null`). Normalizes: trimmed text, `logo` an https URL, `country`
 * upper-case ISO 3166-1 alpha-2, `timeZone` the canonical IANA name. Unknown members are ignored.
 * @param {unknown} value
 * @returns {ValidationResult<BusinessInfo>}
 */
export const validateBusinessJson = (value) => {
	if (!isObject(value))
		return Object.freeze({ ok: false, problems: Object.freeze([{ path: '', keyword: 'type', message: 'must be an object' }]) });
	const name = text(value.name, 200);
	if (name === null)
		return Object.freeze({
			ok: false,
			problems: Object.freeze([
				{ path: '/name', keyword: 'required', message: 'is required (plain text, at most 200 characters)' },
			]),
		});
	const country = matching(text(value.country, 2), COUNTRY);
	const currency = currencyOf(value.currency);
	return Object.freeze({
		ok: true,
		value: Object.freeze({
			name,
			logo: httpsUrl(value.logo),
			email: matching(text(value.email, 320), EMAIL),
			phone: matching(text(value.phone, 40), PHONE),
			address: text(value.address, 500, true),
			country: country === null ? null : country.toUpperCase(),
			timeZone: timeZoneOf(value.timeZone),
			currency,
			currencies: Object.freeze(currenciesOf(value.currencies, currency)),
			language: languageOf(value.language),
		}),
	});
};
