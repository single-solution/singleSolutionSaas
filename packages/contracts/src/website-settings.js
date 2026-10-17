/**
 * Website settings (`ss.website-settings/1`): the facts that are the same for every product of one website, kept once in
 * the Portal and delivered to every product on it — business facts, brand and theme, region (country, time zone,
 * currencies, languages, units, Format, phone and address rules), pages and legal texts, and the team that gets alerts.
 * The document holds no secret, so it may be logged and shown in the Setup sheet. Unset text is `''`, an unset list is
 * `[]`, an unset picture is `''`; `version` counts the Portal's saves (0: nothing saved yet).
 *
 * This module is browser-safe (the Portal's console imports it): the vocabulary, the empty document, the checks that
 * need no schema library (`websiteSettingsProblems`, which `validateWebsiteSettings` runs after the shape is right),
 * `tidyWebsiteSection` (what the Portal does to a form's answer before it checks it), the three pure helpers that make
 * the shapes products already use from the document (`businessInfoOf`, `formatOf`, `themeOf`) and the manifest's
 * `websiteSettings.requires` paths. Limits and shapes of the JSON Schema are in `schemas/website-settings.js`.
 * @module
 */
import { PLACE_PARTS, addressFormat, addressLines, isAddressCountry, tidyPostcode } from './address.js';
import { DEFAULT_FORMAT, formatViolation, normalizeFormat } from './format.js';
import { isUtcTimestamp } from './internal.js';
import { isObject } from './util.js';

/** @typedef {import('./types.js').WebsiteSettings} WebsiteSettings */
/** @typedef {import('./types.js').BusinessInfo} BusinessInfo */
/** @typedef {import('./types.js').ValidationProblem} ValidationProblem */
/** @typedef {import('./types.js').WebsiteTheme} WebsiteTheme */
/** @typedef {'business' | 'brand' | 'region' | 'pages' | 'team'} WebsiteSection */

/** The schema name stamped on every document. */
export const WEBSITE_SETTINGS_SCHEMA = 'ss.website-settings/1';

/** The sections of the document: a form of the Portal saves one of them. */
export const WEBSITE_SETTINGS_SECTIONS = Object.freeze(
	/** @type {readonly WebsiteSection[]} */ (['business', 'brand', 'region', 'pages', 'team']),
);

/** Largest document, in bytes of its JSON (free plans: one small document per website). */
export const WEBSITE_SETTINGS_MAX_BYTES = 64 * 1024;

/** The longest values and the longest lists. */
export const WEBSITE_SETTINGS_LIMITS = Object.freeze({
	name: 200,
	shortName: 120,
	otherNames: 10,
	tagline: 200,
	taxNumber: 60,
	businessType: 60,
	email: 320,
	phone: 40,
	phones: 10,
	phoneLabel: 40,
	social: 20,
	socialLabel: 40,
	url: 2048,
	weeklyWindows: 70,
	exceptions: 200,
	windowsPerDay: 6,
	exceptionName: 80,
	currencies: 20,
	languages: 20,
	countries: 250,
	regionCountries: 50,
	regionNames: 200,
	regionName: 100,
	hosts: 10,
	documents: 10,
	documentKey: 40,
	documentTitle: 120,
	documentText: 20_000,
	recipients: 50,
	recipientName: 120,
	themeColors: 24,
	customCss: 20 * 1024,
	maxRadius: 24,
});

/** The package weight and size units (the same as the shop's catalog settings: weights kept in grams, sizes in mm). */
export const WEBSITE_UNITS = Object.freeze({
	weight: Object.freeze(['g', 'kg', 'oz', 'lb']),
	size: Object.freeze(['mm', 'cm', 'in']),
});

/** Where staff alerts to a phone go. */
export const PHONE_CHANNELS = Object.freeze(['sms', 'whatsapp']);

/** The theme before anyone changes it: product CSS supplies the colors. */
const DEFAULT_THEME = Object.freeze({
	mode: 'auto',
	fontFamily: 'inherit',
	radius: 8,
	colors: Object.freeze({}),
	customCss: '',
});

/**
 * The document of a website nothing was saved for: version 0, every fact unset, the default Format and theme.
 * @param {string} websiteId
 * @returns {WebsiteSettings}
 */
export const emptyWebsiteSettings = (websiteId) =>
	/** @type {WebsiteSettings} */ ({
		schema: WEBSITE_SETTINGS_SCHEMA,
		websiteId,
		version: 0,
		updatedAt: null,
		business: {
			name: '',
			otherNames: [],
			tagline: '',
			legalName: '',
			taxNumber: '',
			businessType: '',
			email: '',
			phone: '',
			phones: [],
			whatsapp: '',
			address: { line1: '', line2: '', area: '', city: '', region: '', postalCode: '', country: '' },
			hours: { weekly: [], exceptions: [] },
			social: [],
		},
		brand: {
			files: { logo: '', logoDark: '', icon: '', favicon: '', faviconDark: '', shareImage: '' },
			theme: { ...DEFAULT_THEME, colors: {} },
		},
		region: {
			country: '',
			timeZone: '',
			currency: '',
			currencies: [],
			language: '',
			languages: [],
			countriesServed: [],
			units: { weight: '', size: '' },
			format: { ...DEFAULT_FORMAT, currencySymbols: {} },
			phone: { callingCode: '', trunkPrefix: '', countries: [] },
			address: { required: [], regions: [] },
		},
		pages: { hosts: [], signIn: '', privacy: '', documents: [] },
		team: { recipients: [], phoneChannel: '', staffPush: false, support: { email: '', phone: '' } },
	});

// ---------------------------------------------------------------------------------------------------------------
// what a product can ask for (`websiteSettings.requires` in its manifest)

/**
 * The dotted paths into the document a manifest may list in `websiteSettings.requires`: every value of a section that
 * is not inside a list (`region.currency`, `business.address.city`, `region.currencies`).
 * @param {unknown} value
 * @param {string} prefix
 * @returns {string[]}
 */
const leafPaths = (value, prefix) =>
	isObject(value) && Object.keys(value).length > 0
		? Object.entries(value).flatMap(([key, member]) => leafPaths(member, `${prefix}.${key}`))
		: [prefix];

/** Every path a product may require. */
export const WEBSITE_SETTINGS_PATHS = Object.freeze(
	WEBSITE_SETTINGS_SECTIONS.flatMap((section) => leafPaths(emptyWebsiteSettings('web')[section], section)),
);

const PATH_SET = new Set(WEBSITE_SETTINGS_PATHS);

/**
 * True when the text names a value a manifest may require.
 * @param {unknown} path
 * @returns {path is string}
 */
export const isWebsiteSettingsPath = (path) => typeof path === 'string' && PATH_SET.has(path);

/**
 * True when a value counts as not set: empty text, an empty list or object. A number or yes/no is always set.
 * @param {unknown} value
 */
export const isUnsetWebsiteValue = (value) =>
	value === undefined ||
	value === null ||
	value === '' ||
	(Array.isArray(value) && value.length === 0) ||
	(isObject(value) && Object.keys(value).length === 0);

/**
 * The value a dotted path names in the document (`region.currency`), `undefined` when the path leads nowhere.
 * @param {WebsiteSettings} settings
 * @param {string} path
 * @returns {unknown}
 */
export const websiteSettingAt = (settings, path) => {
	/** @type {unknown} */
	let value = settings;
	for (const key of path.split('.')) value = isObject(value) ? value[key] : undefined;
	return value;
};

/**
 * The paths of `requires` the document leaves empty, in the order asked.
 * @param {WebsiteSettings} settings
 * @param {readonly string[]} requires
 * @returns {string[]}
 */
export const missingWebsiteSettings = (settings, requires) =>
	requires.filter((path) => isUnsetWebsiteValue(websiteSettingAt(settings, path)));

/**
 * The kind of value a path holds, `null` for a path that is no value of the document: `string`, `array` (a list of
 * texts), `boolean` or `number`. A setting of a product can start from a value of its own kind only (`x-ui.defaultFrom`).
 * @param {string} path
 * @returns {'string' | 'array' | 'boolean' | 'number' | null}
 */
export const websiteSettingKind = (path) => {
	if (!PATH_SET.has(path)) return null;
	const sample = websiteSettingAt(emptyWebsiteSettings('web'), path);
	if (Array.isArray(sample)) return 'array';
	if (typeof sample === 'string') return 'string';
	if (typeof sample === 'boolean') return 'boolean';
	return typeof sample === 'number' ? 'number' : null;
};

/**
 * The Portal section of the Website settings page a path belongs to (`region.currency` → `region`): the anchor the
 * "set it in the Portal" links point to.
 * @param {string} path
 * @returns {WebsiteSection}
 */
export const websiteSectionOf = (path) => /** @type {WebsiteSection} */ (path.split('.')[0]);

// ---------------------------------------------------------------------------------------------------------------
// the checks the JSON Schema cannot make

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HTTPS_OR_PATH = /^(?:https:\/\/[^\s]+|\/(?!\/)[^\s]*)$/;

/** @param {string} time 'HH:MM' @returns {number} minutes after midnight ('24:00' = 1440) */
const minutesOf = (time) => (time === '24:00' ? 1440 : Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)));

/**
 * True when the item is a window of two `HH:MM` times, the end after the start (`24:00` = the end of the day).
 * @param {unknown} item
 */
const isWindow = (item) =>
	isObject(item) &&
	typeof item.start === 'string' &&
	typeof item.end === 'string' &&
	TIME.test(item.start) &&
	(TIME.test(item.end) || item.end === '24:00') &&
	minutesOf(item.start) < minutesOf(item.end);

/** @param {Array<{ start: string, end: string }>} ranges whether two of them overlap */
const overlapping = (ranges) =>
	ranges.some((a, i) =>
		ranges.some((b, j) => j > i && minutesOf(a.start) < minutesOf(b.end) && minutesOf(b.start) < minutesOf(a.end)),
	);

/** @param {string} value an https address without credentials (or '') */
const httpsProblem = (value) => {
	if (value === '') return null;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.username === '' && url.password === ''
			? null
			: 'must be an https address without a password';
	} catch {
		return 'must be an https address';
	}
};

/**
 * True when the text has a control character (line breaks and tabs count only when `allowBreaks` is false).
 * @param {string} value @param {boolean} allowBreaks
 */
const hasControl = (value, allowBreaks) => {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i);
		if (allowBreaks && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
};

/** @param {string} path whether the text at the path may hold line breaks and tabs (CSS and the legal texts) */
const takesLineBreaks = (path) => path === '/brand/theme/customCss' || /^\/pages\/documents\/\d+\/text$/.test(path);

/** @param {string} path @param {string} keyword @param {string} message @returns {ValidationProblem} */
const problem = (path, keyword, message) => Object.freeze({ path, keyword, message });

/** @param {string} tag @returns {boolean} whether the runtime knows the tag as written (canonical case) */
const canonicalLanguage = (tag) => {
	try {
		return Intl.getCanonicalLocales(tag)[0] === tag;
	} catch {
		return false;
	}
};

/** @param {string} zone @returns {boolean} whether the runtime knows the IANA time zone */
const knownTimeZone = (zone) => {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone });
		return true;
	} catch {
		return false;
	}
};

/**
 * A list of codes in which each is once and each a known country.
 * @param {ValidationProblem[]} out @param {string} path @param {unknown} codes
 */
const countryList = (out, path, codes) => {
	if (!Array.isArray(codes)) return;
	codes.forEach((code, index) => {
		if (!isAddressCountry(code)) out.push(problem(`${path}/${index}`, 'country', 'must be a country code'));
	});
	if (new Set(codes).size !== codes.length) out.push(problem(path, 'unique', 'must not list a country twice'));
};

/**
 * The opening hours: real windows that do not overlap, real dated exceptions once each.
 * @param {ValidationProblem[]} out @param {string} path @param {Record<string, any>} hours
 */
const hoursProblems = (out, path, hours) => {
	const weekly = Array.isArray(hours.weekly) ? hours.weekly : [];
	weekly.forEach((item, index) => {
		if (!isWindow(item) || !Number.isInteger(item.day) || item.day < 1 || item.day > 7)
			out.push(
				problem(
					`${path}/weekly/${index}`,
					'window',
					'must be a day from 1 (Monday) to 7 (Sunday) with a start and a later end as HH:MM',
				),
			);
	});
	for (let day = 1; day <= 7; day += 1)
		if (overlapping(weekly.filter((item) => item?.day === day && isWindow(item))))
			out.push(problem(`${path}/weekly`, 'overlap', `must not have two windows of day ${day} that overlap`));
	const dates = new Set();
	const exceptions = Array.isArray(hours.exceptions) ? hours.exceptions : [];
	exceptions.forEach((item, index) => {
		const date = typeof item?.date === 'string' ? item.date : '';
		const parsed = new Date(`${date}T00:00:00Z`);
		const real = DATE.test(date) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
		if (!real) out.push(problem(`${path}/exceptions/${index}/date`, 'date', 'must be a real date (YYYY-MM-DD)'));
		else if (dates.has(date)) out.push(problem(`${path}/exceptions/${index}/date`, 'unique', 'must not be listed twice'));
		dates.add(date);
		const windows = Array.isArray(item?.hours) ? item.hours : [];
		windows.forEach((/** @type {unknown} */ candidate, /** @type {number} */ at) => {
			if (!isWindow(candidate))
				out.push(problem(`${path}/exceptions/${index}/hours/${at}`, 'window', 'must have a start and a later end as HH:MM'));
		});
		if (overlapping(windows.filter(isWindow)))
			out.push(problem(`${path}/exceptions/${index}/hours`, 'overlap', 'must not have windows that overlap'));
	});
};

/**
 * Visit every string of the document.
 * @param {unknown} value @param {string} path @param {(path: string, text: string) => void} visit
 */
const eachString = (value, path, visit) => {
	if (typeof value === 'string') visit(path, value);
	else if (Array.isArray(value)) value.forEach((item, index) => eachString(item, `${path}/${index}`, visit));
	else if (isObject(value)) for (const [key, member] of Object.entries(value)) eachString(member, `${path}/${key}`, visit);
};

/**
 * The rules of a document whose shape is right (`schemas/website-settings.js`): real times, dates, countries, time
 * zones and language tags, the store currency and the default language first in their lists, nothing twice, a postal
 * code in the shape its country uses, no control characters, and at most {@link WEBSITE_SETTINGS_MAX_BYTES}.
 * @param {WebsiteSettings} settings
 * @returns {ValidationProblem[]}
 */
export const websiteSettingsProblems = (settings) => {
	/** @type {ValidationProblem[]} */
	const out = [];
	if (settings.updatedAt !== null && !isUtcTimestamp(settings.updatedAt))
		out.push(problem('/updatedAt', 'timestamp', 'must be a real UTC time'));
	eachString(settings, '', (path, text) => {
		if (hasControl(text, takesLineBreaks(path))) out.push(problem(path, 'control', 'must not have a control character'));
	});
	const { business, brand, region, pages, team } = settings;

	// business
	const address = business.address;
	if (address.country !== '' && !isAddressCountry(address.country))
		out.push(problem('/business/address/country', 'country', 'must be a country code'));
	else if (address.country !== '' && address.postalCode !== '') {
		const shape = addressFormat(address.country).postcode;
		if (shape && !shape.test(tidyPostcode(address.postalCode)))
			out.push(problem('/business/address/postalCode', 'postalCode', `must be in the form ${address.country} uses`));
	}
	hoursProblems(out, '/business/hours', business.hours);

	// brand
	for (const [name, url] of Object.entries(brand.files)) {
		const wrong = httpsProblem(url);
		if (wrong) out.push(problem(`/brand/files/${name}`, 'url', wrong));
	}
	business.social.forEach((item, index) => {
		const wrong = httpsProblem(item.url);
		if (wrong) out.push(problem(`/business/social/${index}/url`, 'url', wrong));
	});
	if (new TextEncoder().encode(brand.theme.customCss).length > WEBSITE_SETTINGS_LIMITS.customCss)
		out.push(problem('/brand/theme/customCss', 'maxLength', 'must be at most 20 kB'));

	// region
	if (region.country !== '' && !isAddressCountry(region.country))
		out.push(problem('/region/country', 'country', 'must be a country code'));
	if (region.timeZone !== '' && !knownTimeZone(region.timeZone))
		out.push(problem('/region/timeZone', 'timeZone', 'must be an IANA time zone name such as America/New_York'));
	if (region.language !== '' && !canonicalLanguage(region.language))
		out.push(problem('/region/language', 'language', 'must be a language tag such as en-US'));
	region.languages.forEach((tag, index) => {
		if (!canonicalLanguage(tag))
			out.push(problem(`/region/languages/${index}`, 'language', 'must be a language tag such as en-US'));
	});
	if (new Set(region.languages).size !== region.languages.length)
		out.push(problem('/region/languages', 'unique', 'must not list a language twice'));
	else if (
		region.language === ''
			? region.languages.length > 0
			: region.languages.length > 0 && region.languages[0] !== region.language
	)
		out.push(problem('/region/languages', 'first', 'must start with the default language'));
	if (new Set(region.currencies).size !== region.currencies.length)
		out.push(problem('/region/currencies', 'unique', 'must not list a currency twice'));
	else if (
		region.currency === ''
			? region.currencies.length > 0
			: region.currencies.length > 0 && region.currencies[0] !== region.currency
	)
		out.push(problem('/region/currencies', 'first', 'must start with the store currency'));
	countryList(out, '/region/countriesServed', region.countriesServed);
	countryList(out, '/region/phone/countries', region.phone.countries);
	for (const field of /** @type {const} */ (['locale', 'currencyDisplay', 'currencySymbols', 'wholeUnits', 'times'])) {
		const wrong = formatViolation(field, region.format[field]);
		if (wrong) out.push(problem(`/region/format/${field}`, 'format', wrong));
	}
	if (new Set(region.address.required).size !== region.address.required.length)
		out.push(problem('/region/address/required', 'unique', 'must not list a part twice'));
	const regionCountries = new Set();
	region.address.regions.forEach((entry, index) => {
		if (!isAddressCountry(entry.country))
			out.push(problem(`/region/address/regions/${index}/country`, 'country', 'must be a country code'));
		else if (regionCountries.has(entry.country))
			out.push(problem(`/region/address/regions/${index}/country`, 'unique', 'must not be listed twice'));
		regionCountries.add(entry.country);
		const names = entry.names.map((name) => name.toLowerCase());
		if (new Set(names).size !== names.length)
			out.push(problem(`/region/address/regions/${index}/names`, 'unique', 'must not list a region twice'));
	});

	// pages
	if (new Set(pages.hosts).size !== pages.hosts.length)
		out.push(problem('/pages/hosts', 'unique', 'must not list a host name twice'));
	for (const field of /** @type {const} */ (['signIn', 'privacy'])) {
		const text = pages[field];
		if (text !== '' && !HTTPS_OR_PATH.test(text))
			out.push(problem(`/pages/${field}`, 'url', 'must be an https address or a path on the website'));
		else if (text.startsWith('https:') && httpsProblem(text))
			out.push(problem(`/pages/${field}`, 'url', /** @type {string} */ (httpsProblem(text))));
	}
	const keys = pages.documents.map((document) => document.key);
	if (new Set(keys).size !== keys.length) out.push(problem('/pages/documents', 'unique', 'must not list a document key twice'));

	// team
	team.recipients.forEach((entry, index) => {
		if (entry.email === '' && entry.phone === '')
			out.push(problem(`/team/recipients/${index}`, 'contact', 'needs an email address or a phone number'));
	});

	if (new TextEncoder().encode(JSON.stringify(settings)).length > WEBSITE_SETTINGS_MAX_BYTES)
		out.push(problem('', 'maxBytes', 'must be at most 64 kB'));
	return out;
};

// ---------------------------------------------------------------------------------------------------------------
// tidying a form's answer

/**
 * Trim every text and drop empty entries from lists of texts.
 * @param {unknown} value
 * @returns {any}
 */
const trimmed = (value) => {
	if (typeof value === 'string') return value.trim();
	if (Array.isArray(value)) {
		const items = value.map(trimmed);
		return items.every((item) => typeof item === 'string') ? items.filter((item) => item !== '') : items;
	}
	if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, trimmed(member)]));
	return value;
};

/** @param {readonly string[]} items @returns {string[]} the items once each, in order */
const once = (items) => [...new Set(items)];

/** @param {unknown} tag @returns {unknown} the tag in canonical case when the runtime accepts it, else as it is */
const languageTag = (tag) => {
	if (typeof tag !== 'string' || tag === '') return tag;
	try {
		return Intl.getCanonicalLocales(tag)[0] ?? tag;
	} catch {
		return tag;
	}
};

/** @param {unknown} value @returns {unknown} the codes in capitals */
const capitals = (value) =>
	Array.isArray(value) ? value.map((code) => (typeof code === 'string' ? code.toUpperCase() : code)) : value;

/**
 * What the Portal does to a section a form sent before it checks it: texts trimmed, empty list entries dropped, country
 * and currency codes in capitals, language tags in canonical case, the store currency and the default language first in
 * their lists with each once, host names in lower case once, dated exceptions in date order. Unknown members stay, for
 * the checks to refuse; anything that is not an object is returned as it is.
 * @param {WebsiteSection} section
 * @param {unknown} input
 * @returns {any}
 */
export const tidyWebsiteSection = (section, input) => {
	if (!isObject(input)) return input;
	const value = trimmed(input);
	switch (section) {
		case 'business': {
			if (isObject(value.address) && typeof value.address.country === 'string')
				value.address = { ...value.address, country: value.address.country.toUpperCase() };
			if (isObject(value.hours) && Array.isArray(value.hours.exceptions))
				value.hours = {
					...value.hours,
					exceptions: [...value.hours.exceptions].sort((a, b) => String(a?.date).localeCompare(String(b?.date))),
				};
			return value;
		}
		case 'region': {
			const currency = typeof value.currency === 'string' ? value.currency.toUpperCase() : value.currency;
			const language = languageTag(value.language);
			const currencies = capitals(value.currencies);
			const languages = Array.isArray(value.languages) ? value.languages.map(languageTag) : value.languages;
			return {
				...value,
				country: typeof value.country === 'string' ? value.country.toUpperCase() : value.country,
				currency,
				currencies: Array.isArray(currencies) ? once([...(currency ? [currency] : []), ...currencies]) : currencies,
				language,
				languages: Array.isArray(languages) ? once([...(language ? [language] : []), ...languages]) : languages,
				countriesServed: Array.isArray(value.countriesServed)
					? once(/** @type {string[]} */ (capitals(value.countriesServed)))
					: value.countriesServed,
				...(isObject(value.phone) && Array.isArray(value.phone.countries)
					? { phone: { ...value.phone, countries: once(/** @type {string[]} */ (capitals(value.phone.countries))) } }
					: {}),
			};
		}
		case 'pages':
			return {
				...value,
				hosts: Array.isArray(value.hosts)
					? once(value.hosts.map((/** @type {unknown} */ host) => String(host).toLowerCase()))
					: value.hosts,
			};
		default:
			return value;
	}
};

// ---------------------------------------------------------------------------------------------------------------
// the shapes products already use, made from the document

/**
 * The business.json shape (`BusinessInfo`) of the document: the logo, the main phone (else the first of the list), the
 * address as text lines, and the region's country (else the address's), time zone, currencies and default language;
 * facts not set are `null`. `name` is `''` until the business has one (a product then shows the domain).
 * @param {WebsiteSettings} settings
 * @returns {BusinessInfo}
 */
export const businessInfoOf = (settings) => {
	const { business, brand, region } = settings;
	const lines = addressLines(business.address, business.address.country).join('\n');
	return {
		name: business.name,
		logo: brand.files.logo || null,
		email: business.email || null,
		phone: business.phone || business.phones[0]?.number || null,
		address: lines || null,
		country: region.country || business.address.country || null,
		timeZone: region.timeZone || null,
		currency: region.currency || null,
		currencies: [...region.currencies],
		language: region.language || null,
	};
};

/**
 * The Format of the document, whole (a value that is not valid takes the default).
 * @param {WebsiteSettings} settings
 * @returns {import('./format.js').Format}
 */
export const formatOf = (settings) => normalizeFormat(settings.region.format);

/**
 * The theme of the document (colors, font family, radius, mode and custom CSS).
 * @param {WebsiteSettings} settings
 * @returns {WebsiteTheme}
 */
export const themeOf = (settings) => {
	const { mode, fontFamily, radius, colors, customCss } = settings.brand.theme;
	return { mode, fontFamily, radius, colors: { ...colors }, customCss };
};

/** The address parts a website may require of a customer's address (Region & format › address rules). */
export const ADDRESS_REQUIRED_PARTS = Object.freeze([...PLACE_PARTS, 'country']);
