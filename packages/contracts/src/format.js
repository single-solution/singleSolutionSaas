/**
 * Format and time zone (PLAN 0.8.10 K7, K8): one kit `formatMoney` and `formatDate` for widgets, messages, invoices,
 * hosted pages and chat answers, fed by a website's Format value (stored like the theme) and its business.json time
 * zone; and the calendar helpers every calendar rule uses (days, years and weekdays in the business time zone, UTC
 * when missing). Pure and browser-safe (no Node.js imports): products' `core/` and widgets use it through
 * `@ss/contracts/format` and `@ss/app-kit/widget`.
 *
 * - `locale`: BCP 47; '' = the viewer's browser in widgets and `en` in text the server makes.
 * - `currencyDisplay`: `code` ("PKR 12,500.00"), `symbol` (the locale's narrow symbol, "Rs 12,500.00") or `custom`
 *   (`currencySymbol` in the place of the code, "Rs. 12,500.00").
 * - `wholeUnits`: true shows no minor units ("PKR 12,500").
 * - `times`: `viewer` (widgets show the viewer's own time zone) or `business` (the business.json time zone). Text the
 *   server makes has no viewer, so it always uses the business time zone.
 *
 * Amounts are integer minor units of an ISO 4217 currency; the minor units are ISO 4217's (2 unless listed), never the
 * runtime's display defaults.
 * @module
 */

/**
 * @typedef {object} Format
 * @property {string} locale BCP 47 language tag, or '' (the viewer's, `en` on the server)
 * @property {'code' | 'symbol' | 'custom'} currencyDisplay
 * @property {string} currencySymbol at most 8 characters, used with `custom`
 * @property {boolean} wholeUnits
 * @property {'viewer' | 'business'} times
 */

/**
 * Who looks at the text: the browser's language and time zone in widgets; null for text the server makes.
 * @typedef {{ locale?: string, timeZone?: string } | null} Viewer
 */

/** The fields of a Format value, in screen order. */
export const FORMAT_FIELDS = Object.freeze(
	/** @type {const} */ (['locale', 'currencyDisplay', 'currencySymbol', 'wholeUnits', 'times']),
);

/** The Format before anyone changes it. @type {Readonly<Format>} */
export const DEFAULT_FORMAT = Object.freeze({
	locale: '',
	currencyDisplay: 'code',
	currencySymbol: '',
	wholeUnits: false,
	times: 'viewer',
});

/**
 * True when the text has a control character.
 * @param {string} value
 */
const hasControl = (value) => [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/** Longest custom currency symbol. */
const MAX_SYMBOL = 8;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/;

/**
 * True when the runtime accepts a BCP 47 tag.
 * @param {string} tag
 */
const knownLocale = (tag) => {
	try {
		return Intl.getCanonicalLocales(tag).length === 1;
	} catch {
		return false;
	}
};

/**
 * Why a Format field value is invalid, or null.
 * @param {string} field
 * @param {unknown} value
 * @returns {string | null}
 */
export const formatViolation = (field, value) => {
	switch (field) {
		case 'locale':
			return value === '' || (typeof value === 'string' && LOCALE.test(value) && knownLocale(value))
				? null
				: "locale is a language tag such as en, en-GB or ur-PK, or '' for the viewer's";
		case 'currencyDisplay':
			return value === 'code' || value === 'symbol' || value === 'custom' ? null : 'currencyDisplay is code, symbol or custom';
		case 'currencySymbol':
			return typeof value === 'string' && value.length <= MAX_SYMBOL && !hasControl(value)
				? null
				: `currencySymbol is at most ${MAX_SYMBOL} characters`;
		case 'wholeUnits':
			return typeof value === 'boolean' ? null : 'wholeUnits is true or false';
		case 'times':
			return value === 'viewer' || value === 'business' ? null : 'times is viewer or business';
		default:
			return `unknown format field ${field}`;
	}
};

/**
 * A complete Format from a stored or partial value: unknown fields are dropped, invalid or missing ones take the
 * default.
 * @param {unknown} value
 * @returns {Format}
 */
export const normaliseFormat = (value) => {
	const input =
		typeof value === 'object' && value !== null && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const field of FORMAT_FIELDS)
		out[field] =
			Object.hasOwn(input, field) && formatViolation(field, input[field]) === null ? input[field] : DEFAULT_FORMAT[field];
	return /** @type {Format} */ (out);
};

/** Currencies with no minor unit (ISO 4217 exponent 0). */
const ZERO_DECIMAL = new Set([
	'BIF',
	'CLP',
	'DJF',
	'GNF',
	'ISK',
	'JPY',
	'KMF',
	'KRW',
	'PYG',
	'RWF',
	'UGX',
	'UYI',
	'VND',
	'VUV',
	'XAF',
	'XOF',
	'XPF',
]);
/** Currencies with three decimals (ISO 4217 exponent 3). */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/**
 * Minor-unit digits of a currency (ISO 4217 exponent; 2 unless listed).
 * @param {string} currency
 * @returns {number}
 */
export const currencyDigits = (currency) => (ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2);

/** No-break spaces the runtime puts between a symbol and the number, as plain spaces (plain text everywhere). */
const NO_BREAK_SPACES = new RegExp('[\u00a0\u202f]', 'g');
const plainSpaces = (/** @type {string} */ text) => text.replace(NO_BREAK_SPACES, ' ');

/**
 * The locale a text is written in: the Format's, else the viewer's, else `en`.
 * @param {Format} format
 * @param {Viewer} viewer
 */
const localeOf = (format, viewer) => {
	const wanted = format.locale || viewer?.locale || 'en';
	return knownLocale(wanted) ? wanted : 'en';
};

/**
 * An amount in minor units as text, following a Format.
 * @param {number} amount integer minor units (negative amounts get a minus sign)
 * @param {string} currency ISO 4217 code
 * @param {Partial<Format>} [format]
 * @param {Viewer} [viewer] the browser's language in widgets; null (default) for text the server makes
 * @returns {string} '' for an amount that is not a finite number
 */
export const formatMoney = (amount, currency, format = DEFAULT_FORMAT, viewer = null) => {
	if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
	const f = normaliseFormat(format);
	const digits = currencyDigits(currency);
	const fraction = f.wholeUnits ? 0 : digits;
	const major = amount / 10 ** digits;
	const locale = localeOf(f, viewer);
	try {
		const parts = new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
			currencyDisplay: f.currencyDisplay === 'symbol' ? 'narrowSymbol' : 'code',
			minimumFractionDigits: fraction,
			maximumFractionDigits: fraction,
		}).formatToParts(major);
		const symbol = f.currencyDisplay === 'custom' && f.currencySymbol !== '' ? f.currencySymbol : null;
		return plainSpaces(parts.map((part) => (part.type === 'currency' && symbol !== null ? symbol : part.value)).join(''));
	} catch {
		// not an ISO 4217 code the runtime knows: the number with the code
		const number = new Intl.NumberFormat(locale, { minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(
			major,
		);
		return plainSpaces(`${currency} ${number}`);
	}
};

/** @typedef {'date' | 'datetime' | 'time'} DateStyle */

/** Intl options of each date style ("12 Mar 2026", "12 Mar 2026, 14:30", "14:30" in en-GB). */
const DATE_STYLES = Object.freeze({
	date: Object.freeze({ dateStyle: 'medium' }),
	datetime: Object.freeze({ dateStyle: 'medium', timeStyle: 'short' }),
	time: Object.freeze({ timeStyle: 'short' }),
});

/**
 * True for an IANA time zone the runtime knows.
 * @param {unknown} timeZone
 * @returns {timeZone is string}
 */
const knownTimeZone = (timeZone) => {
	if (typeof timeZone !== 'string' || timeZone === '') return false;
	try {
		new Intl.DateTimeFormat('en', { timeZone });
		return true;
	} catch {
		return false;
	}
};

/**
 * @param {unknown} value
 * @returns {Date | null}
 */
const dateOf = (value) => {
	const at = value instanceof Date ? value : typeof value === 'number' || typeof value === 'string' ? new Date(value) : null;
	return at && !Number.isNaN(at.getTime()) ? at : null;
};

/**
 * A date or time as text, following a Format.
 * @param {Date | number | string | null | undefined} value an instant (Date, epoch ms or ISO-8601 text)
 * @param {Partial<Format>} [format]
 * @param {{ timeZone?: string, style?: DateStyle, viewer?: Viewer }} [options] `timeZone`: the business.json time zone
 *   (UTC when missing); `viewer`: the browser's language and time zone in widgets, null (default) for text the server
 *   makes, which always uses the business time zone
 * @returns {string} '' for a value that is not an instant
 */
export const formatDate = (value, format = DEFAULT_FORMAT, { timeZone = 'UTC', style = 'datetime', viewer = null } = {}) => {
	const at = dateOf(value);
	if (!at) return '';
	const f = normaliseFormat(format);
	const business = knownTimeZone(timeZone) ? timeZone : 'UTC';
	const zone =
		f.times === 'business' || viewer === null ? business : knownTimeZone(viewer.timeZone) ? viewer.timeZone : undefined;
	return plainSpaces(
		new Intl.DateTimeFormat(localeOf(f, viewer), {
			...(DATE_STYLES[style] ?? DATE_STYLES.datetime),
			...(zone === undefined ? {} : { timeZone: zone }),
		}).format(at),
	);
};

// ------------------------------------------------------------------------------------- calendar rules (K8)

/** @type {Map<string, Intl.DateTimeFormat>} */
const CALENDARS = new Map();

/** @param {string} timeZone */
const calendarOf = (timeZone) => {
	const zone = knownTimeZone(timeZone) ? timeZone : 'UTC';
	let found = CALENDARS.get(zone);
	if (!found) {
		found = new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
		CALENDARS.set(zone, found);
	}
	return found;
};

/**
 * @typedef {object} ZonedParts
 * @property {number} year
 * @property {number} month 1–12
 * @property {number} day 1–31
 * @property {number} hour 0–23
 * @property {number} minute
 * @property {number} second
 * @property {number} weekday 0 = Sunday … 6 = Saturday
 */

/**
 * The wall clock of an instant in a time zone (UTC when the zone is missing or unknown).
 * @param {Date | number | string} at
 * @param {string | null | undefined} timeZone
 * @returns {ZonedParts}
 */
export const zonedParts = (at, timeZone) => {
	const instant = dateOf(at) ?? new Date(Number.NaN);
	if (Number.isNaN(instant.getTime())) throw new RangeError('zonedParts needs an instant');
	/** @type {Record<string, number>} */
	const parts = {};
	for (const part of calendarOf(timeZone ?? 'UTC').formatToParts(instant))
		if (part.type !== 'literal') parts[part.type] = Number(part.value);
	const year = /** @type {number} */ (parts.year);
	const month = /** @type {number} */ (parts.month);
	const day = /** @type {number} */ (parts.day);
	return {
		year,
		month,
		day,
		hour: /** @type {number} */ (parts.hour),
		minute: /** @type {number} */ (parts.minute),
		second: /** @type {number} */ (parts.second),
		weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
	};
};

/** @param {number} n @param {number} width */
const pad = (n, width = 2) => String(n).padStart(width, '0');

/**
 * The calendar day of an instant in a time zone, as `YYYY-MM-DD` (report and analytics days).
 * @param {Date | number | string} at
 * @param {string | null | undefined} timeZone
 */
export const zonedDay = (at, timeZone) => {
	const { year, month, day } = zonedParts(at, timeZone);
	return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
};

/**
 * The instant a calendar day (`YYYY-MM-DD`) starts in a time zone, in epoch ms.
 * @param {string} day
 * @param {string | null | undefined} timeZone
 * @returns {number} NaN for a value that is not a day
 */
export const zonedDayStart = (day, timeZone) => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!match) return Number.NaN;
	const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	if (Number.isNaN(wall) || new Date(wall).toISOString().slice(0, 10) !== day) return Number.NaN;
	/** The zone's offset at an instant (wall clock − UTC), in ms. @param {number} instant */
	const offset = (instant) => {
		const p = zonedParts(instant, timeZone);
		return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
	};
	// two passes settle the offset around a daylight-saving change
	const first = wall - offset(wall);
	return wall - offset(first);
};
