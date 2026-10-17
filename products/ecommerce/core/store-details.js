/**
 * Store details (the `store_details` list, one record per website): who the store is as its customers see it — its
 * name and tagline, its pictures (the logo and its dark-mode version, the icon, the favicon and its dark-mode version:
 * files in the merchant's own storage, like product media), contact email, phone, more phones with a name each (a
 * landline next to the mobile) and WhatsApp number, postal address (`@ss/contracts/address`), opening hours (the weekly windows and dated exceptions of
 * booking schedules: `{ day 1–7, start, end }` and `{ date, name, hours }`), social links the merchant names, and the time
 * zone and language its hours and texts follow. Every field is public: a website shows them in its header, footer and
 * contact page, and serves `/.well-known/business.json` from them (`businessJsonOf`). No I/O (the dashboard editor uses
 * it too).
 * @module
 */
import { buildBusinessJson } from '@ss/contracts';
import {
	PLACE_LIMITS,
	PLACE_PARTS,
	addressFormat,
	addressLines,
	countryCodeOf,
	countryName,
	tidyPostcode,
} from '@ss/contracts/address';
import { isObject } from '@ss/contracts/util';
import { checkHours } from './bookings.js';
import { IMAGE_TYPES } from './catalog-content.js';

/** @typedef {{ key: string, type: string, size: number, alt: string }} StoreFile a picture of the store in the merchant's storage */
/** @typedef {'logo' | 'logoDark' | 'icon' | 'favicon' | 'faviconDark'} StoreFileName */
/** @typedef {Record<'line1' | 'line2' | 'area' | 'city' | 'region' | 'postalCode', string> & { country: string }} StoreAddress */
/**
 * @typedef {object} StoreDetails
 * @property {string} name
 * @property {string} tagline
 * @property {StoreFile | null} logo the logo for light backgrounds
 * @property {StoreFile | null} logoDark the logo for dark mode
 * @property {StoreFile | null} icon the square mark of the store (apps, social cards)
 * @property {StoreFile | null} favicon the icon of the browser tab
 * @property {StoreFile | null} faviconDark the browser-tab icon for dark mode
 * @property {string} email
 * @property {string} phone the main phone number
 * @property {Array<{ label: string, number: string }>} phones more phone numbers, each with a name (Landline, Sales …)
 * @property {string} whatsapp
 * @property {StoreAddress} address
 * @property {import('./bookings.js').Hours} hours
 * @property {Array<{ label: string, url: string }>} social
 * @property {string} timeZone an IANA time zone name, '' when not set
 * @property {string} language a BCP 47 tag, '' when not set
 */

/** The longest text of each field. */
export const STORE_LIMITS = Object.freeze({
	name: 120,
	tagline: 200,
	email: 320,
	phone: 40,
	phones: 10,
	phoneLabel: 40,
	whatsapp: 40,
	social: 20,
	socialLabel: 40,
	url: 2048,
	alt: 200,
	file: 5 * 1024 * 1024,
});

/** Where the store's files are kept in the merchant's storage. */
export const STORE_FOLDER = 'ecommerce/store/';
/** The pictures a store has (each one an upload slot), and what a merchant calls each. */
export const STORE_FILES = Object.freeze(/** @type {StoreFileName[]} */ (['logo', 'logoDark', 'icon', 'favicon', 'faviconDark']));
/** @type {Readonly<Record<StoreFileName, string>>} */
export const STORE_FILE_LABELS = Object.freeze({
	logo: 'logo',
	logoDark: 'dark logo',
	icon: 'icon',
	favicon: 'favicon',
	faviconDark: 'dark favicon',
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ().-]{3,40}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/;

/** @param {unknown} value @returns {boolean} whether the text has a control character */
const hasControl = (value) => [...String(value)].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/** What a store has before the merchant saves its details: nothing. */
export const DEFAULT_STORE_DETAILS = Object.freeze({
	name: '',
	tagline: '',
	logo: null,
	logoDark: null,
	icon: null,
	favicon: null,
	faviconDark: null,
	email: '',
	phone: '',
	phones: Object.freeze([]),
	whatsapp: '',
	address: Object.freeze({ line1: '', line2: '', area: '', city: '', region: '', postalCode: '', country: '' }),
	hours: Object.freeze({ weekly: Object.freeze([]), exceptions: Object.freeze([]) }),
	social: Object.freeze([]),
	timeZone: '',
	language: '',
});

/** A fresh copy of the default details. @returns {StoreDetails} */
export const defaultStoreDetails = () =>
	/** @type {StoreDetails} */ (/** @type {unknown} */ (structuredClone(DEFAULT_STORE_DETAILS)));

/**
 * Plain text of at most `max` characters, trimmed; null when it is too long or has control characters.
 * @param {unknown} value @param {number} max
 */
const textOf = (value, max) => {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') return null;
	const text = value.trim();
	return text.length > max || hasControl(text) ? null : text;
};

/**
 * A stored file (one of the store's pictures), or null when there is none; errors for another shape or a key outside the
 * store's folder.
 * @param {unknown} value @param {string} path @param {Array<string>} errors
 * @returns {StoreFile | null}
 */
const fileOf = (value, path, errors) => {
	if (value === null || value === undefined) return null;
	const entry = isObject(value) ? /** @type {Record<string, unknown>} */ (value) : {};
	const key = typeof entry.key === 'string' ? entry.key : '';
	const type = typeof entry.type === 'string' ? entry.type : '';
	const alt = textOf(entry.alt, STORE_LIMITS.alt);
	if (
		!key.startsWith(STORE_FOLDER) ||
		key.length > 300 ||
		key.includes('..') ||
		hasControl(key) ||
		!Object.hasOwn(IMAGE_TYPES, type) ||
		!Number.isSafeInteger(entry.size) ||
		/** @type {number} */ (entry.size) < 1 ||
		alt === null
	) {
		errors.push(
			`${path}: a file uploaded for the store (key under ${STORE_FOLDER}, an image type, size and alternative text).`,
		);
		return null;
	}
	return { key, type, size: /** @type {number} */ (entry.size), alt };
};

/**
 * An https address, or null.
 * @param {unknown} value
 */
const httpsOf = (value) => {
	const text = textOf(value, STORE_LIMITS.url);
	if (!text) return null;
	try {
		const url = new URL(text);
		return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : null;
	} catch {
		return null;
	}
};

/**
 * Check the store details the merchant saves. Every field is optional (empty text = not set).
 * @param {unknown} value
 * @returns {{ ok: true, value: StoreDetails } | { ok: false, errors: string[] }}
 */
export const checkStoreDetails = (value) => {
	if (!isObject(value)) return { ok: false, errors: ['The store details are an object.'] };
	const given = /** @type {Record<string, unknown>} */ (value);
	/** @type {string[]} */
	const errors = [];
	/** @param {string} field @param {number} max @param {string} what */
	const text = (field, max, what) => {
		const found = textOf(given[field], max);
		if (found === null) errors.push(`${what} is plain text of at most ${max} characters.`);
		return found ?? '';
	};
	const name = text('name', STORE_LIMITS.name, 'The name');
	const tagline = text('tagline', STORE_LIMITS.tagline, 'The tagline');

	const email = text('email', STORE_LIMITS.email, 'The email address');
	if (email && !EMAIL.test(email)) errors.push('The email address is not an email address.');
	const phone = text('phone', STORE_LIMITS.phone, 'The phone number');
	if (phone && !PHONE.test(phone)) errors.push('The phone number has digits, spaces and + ( ) . - only.');
	const whatsapp = text('whatsapp', STORE_LIMITS.whatsapp, 'The WhatsApp number');
	if (whatsapp && !PHONE.test(whatsapp)) errors.push('The WhatsApp number has digits, spaces and + ( ) . - only.');

	// more phones, each with an optional name
	/** @type {StoreDetails['phones']} */
	const phones = [];
	const phonesGiven = given.phones ?? [];
	if (!Array.isArray(phonesGiven) || phonesGiven.length > STORE_LIMITS.phones)
		errors.push(`The phones are a list of at most ${STORE_LIMITS.phones}.`);
	else
		phonesGiven.forEach((item, index) => {
			const entry = isObject(item) ? /** @type {Record<string, unknown>} */ (item) : {};
			const label = textOf(entry.label, STORE_LIMITS.phoneLabel);
			const number = textOf(entry.number, STORE_LIMITS.phone);
			if (label === null || !number || !PHONE.test(number))
				return void errors.push(
					`Phone ${index + 1}: an optional name (at most ${STORE_LIMITS.phoneLabel} characters) and a number with digits, spaces and + ( ) . - only.`,
				);
			phones.push({ label, number });
		});

	// the address: place parts as they are (nothing is required), a country as its code or English name
	const rawAddress = isObject(given.address) ? /** @type {Record<string, unknown>} */ (given.address) : {};
	if (given.address !== undefined && !isObject(given.address)) errors.push('The address is an object of place parts.');
	/** @type {StoreAddress} */
	const address = { line1: '', line2: '', area: '', city: '', region: '', postalCode: '', country: '' };
	for (const part of PLACE_PARTS) {
		const found = textOf(rawAddress[part], PLACE_LIMITS[part]);
		if (found === null) errors.push(`The address ${part} is plain text of at most ${PLACE_LIMITS[part]} characters.`);
		else address[part] = found;
	}
	const countryText = textOf(rawAddress.country, 60);
	if (countryText === null) errors.push('The address country is a country code or name.');
	else if (countryText) {
		const code = countryCodeOf(countryText);
		if (code) address.country = code;
		else errors.push('The address country is not a country the store can be in (use its ISO 3166-1 alpha-2 code).');
	}
	// a postal code in the shape the country uses (nothing is required)
	const shape = address.country ? addressFormat(address.country).postcode : null;
	if (shape && address.postalCode && !shape.test(tidyPostcode(address.postalCode)))
		errors.push(`The postal code is not in the form ${address.country} uses.`);

	const hoursGiven = isObject(given.hours) ? /** @type {Record<string, unknown>} */ (given.hours) : {};
	if (given.hours !== undefined && !isObject(given.hours))
		errors.push('The opening hours are an object: { weekly, exceptions }.');
	const hours = checkHours(hoursGiven, 'The opening hours', errors);

	/** @type {StoreDetails['social']} */
	const social = [];
	const socialGiven = given.social ?? [];
	if (!Array.isArray(socialGiven) || socialGiven.length > STORE_LIMITS.social)
		errors.push(`The social links are a list of at most ${STORE_LIMITS.social}.`);
	else
		socialGiven.forEach((item, index) => {
			const entry = isObject(item) ? /** @type {Record<string, unknown>} */ (item) : {};
			const label = textOf(entry.label, STORE_LIMITS.socialLabel);
			const url = httpsOf(entry.url);
			if (!label || !url)
				return void errors.push(
					`Social link ${index + 1}: a name (at most ${STORE_LIMITS.socialLabel} characters) and an https address.`,
				);
			social.push({ label, url });
		});

	const timeZone = text('timeZone', 64, 'The time zone');
	if (timeZone) {
		try {
			new Intl.DateTimeFormat('en-US', { timeZone });
		} catch {
			errors.push('The time zone is an IANA time zone name such as America/New_York.');
		}
	}
	const language = text('language', 35, 'The language');
	if (language && !LANGUAGE.test(language)) errors.push('The language is a BCP 47 tag such as en-US.');

	const logo = fileOf(given.logo, 'The logo', errors);
	const logoDark = fileOf(given.logoDark, 'The dark logo', errors);
	const icon = fileOf(given.icon, 'The icon', errors);
	const favicon = fileOf(given.favicon, 'The favicon', errors);
	const faviconDark = fileOf(given.faviconDark, 'The dark favicon', errors);

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			name,
			tagline,
			logo,
			logoDark,
			icon,
			favicon,
			faviconDark,
			email,
			phone,
			phones,
			whatsapp,
			address,
			hours,
			social,
			timeZone,
			language,
		},
	};
};

/**
 * The address of the details as the country writes it (`addressLines`), joined by `separator`.
 * @param {StoreAddress} address @param {string} [separator]
 */
export const addressText = (address, separator = ', ') => addressLines(address, address.country).join(separator);

/**
 * A link that opens a WhatsApp chat with the number (`https://wa.me/<digits>`), or '' without a usable number.
 * @param {string} number
 */
export const whatsappLink = (number) => {
	const digits = number.replace(/\D/g, '');
	return digits.length >= 6 && digits.length <= 15 ? `https://wa.me/${digits}` : '';
};

/**
 * A picture as a website reads it: its public address, alternative text and type; null when it is not set.
 * @param {StoreFile | null} file @param {string | null} url
 */
const publicFile = (file, url) => (file && url ? { url, alt: file.alt, type: file.type } : null);

/**
 * The store details as shoppers and websites read them (public; never a storage key): the name (the business name
 * while none is set), tagline, the pictures (logo, dark logo, icon, favicon, dark favicon) with their addresses, contacts
 * (the main phone and the phone list), the address in parts and as lines, the
 * opening hours and social links, and the time zone and language.
 * @param {StoreDetails} details
 * @param {{ logoUrl: string | null, iconUrl: string | null, logoDarkUrl?: string | null, faviconUrl?: string | null,
 *   faviconDarkUrl?: string | null, businessName?: string, siteUrl?: string }} context the public address of each
 *   picture, and the website's own address (its domain; not a setting)
 */
export const publicStoreDetails = (
	details,
	{ logoUrl, iconUrl, logoDarkUrl = null, faviconUrl = null, faviconDarkUrl = null, businessName = '', siteUrl = '' },
) => ({
	name: details.name || businessName,
	tagline: details.tagline,
	logo: publicFile(details.logo, logoUrl),
	logoDark: publicFile(details.logoDark, logoDarkUrl),
	icon: publicFile(details.icon, iconUrl),
	favicon: publicFile(details.favicon, faviconUrl),
	faviconDark: publicFile(details.faviconDark, faviconDarkUrl),
	contact: {
		email: details.email,
		phone: details.phone,
		phones: details.phones,
		whatsapp: details.whatsapp,
		whatsappUrl: whatsappLink(details.whatsapp),
	},
	address: {
		...details.address,
		countryName: details.address.country ? countryName(details.address.country) : '',
		lines: addressLines(details.address, details.address.country),
		text: addressText(details.address),
	},
	hours: { weekly: details.hours.weekly, exceptions: details.hours.exceptions },
	social: details.social,
	timeZone: details.timeZone,
	language: details.language,
	siteUrl,
});

/**
 * The business.json document (`@ss/contracts` business.json version 1) the store details make, for a headless website
 * to serve at `/.well-known/business.json`: the name (the business name while none is set), the logo (its public https
 * address), email, phone (the main one, else the first of the phone list), the address as text, its country, the time zone, the shop currency and the currencies taken
 * and the language. The members with no value are left out. business.json has one logo and one phone: the dark logo,
 * the icon, the favicons and the other phones have no place in it. Fails (`ok: false`) only without any name.
 * @param {StoreDetails} details
 * @param {{ logoUrl?: string | null, currency?: string, currencies?: readonly string[], businessName?: string,
 *   timeZone?: string, language?: string, country?: string }} [context] what the details do not hold
 */
export const businessJsonOf = (details, context = {}) =>
	buildBusinessJson({
		name: details.name || context.businessName,
		logo: context.logoUrl,
		email: details.email,
		phone: details.phone || details.phones[0]?.number,
		address: addressText(details.address, '\n'),
		country: details.address.country || context.country,
		timeZone: details.timeZone || context.timeZone,
		currency: context.currency,
		currencies: context.currencies,
		language: details.language || context.language,
	});
