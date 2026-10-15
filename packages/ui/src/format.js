/**
 * Formatting for the consoles. Money is always shown in **credits** derived from integer millicredits (1 credit =
 * 1000 millicredits), with at most 3 decimals and no rounding beyond that (millicredits are exact).
 * Dates are US English (`Oct 4, 2026`; `Oct 4, 2026, 2:30 PM UTC`) and render in UTC, so server and browser output
 * agree (no hydration drift); `formatDateTime(value, { timeZone })` shows the same style in another time zone, with
 * its short name (the viewer's local time once the page runs in a browser). A product dashboard shows dates and
 * numbers in its website's Format (`locale`, fixed-choices audit K2: `15 Oct 2026, 14:30 GMT+5`, `1.234,5`), while its
 * words stay US English. Codes read as words with `humanize`.
 * @module
 */

const CREDITS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
/** @type {Intl.DateTimeFormatOptions} */
const DATE_TIME_PARTS = {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
	hour: 'numeric',
	minute: '2-digit',
	timeZoneName: 'short',
};
const DATE_TIME = new Intl.DateTimeFormat('en-US', { ...DATE_TIME_PARTS, timeZone: 'UTC' });
const DATE = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
/** No-break spaces some runtimes put before AM/PM, as plain spaces (the same text on the server and in browsers). */
const NO_BREAK_SPACES = /[\u00a0\u202f]/g;

/**
 * Credits from millicredits as a plain number string (`12.345`; with `locale`, that locale's separators); `—` for
 * null/undefined/NaN.
 * @param {number | null | undefined} millicredits
 * @param {{ locale?: string | null }} [options]
 * @returns {string}
 */
export const creditsNumber = (millicredits, { locale } = {}) => {
	if (typeof millicredits !== 'number' || !Number.isFinite(millicredits)) return '—';
	// integer millicredits divide exactly into ≤ 3 decimals
	return numberIn(locale)
		.format(Math.trunc(millicredits) / 1000)
		.replace(NO_BREAK_SPACES, ' ');
};

/**
 * A number in a locale's digits and separators (the website Format's `locale`; US English when none or unknown).
 * @param {number | null | undefined} value
 * @param {{ locale?: string | null, maximumFractionDigits?: number }} [options]
 * @returns {string}
 */
export const formatNumber = (value, { locale, maximumFractionDigits = 3 } = {}) =>
	typeof value === 'number' && Number.isFinite(value)
		? numberIn(locale, maximumFractionDigits).format(value).replace(NO_BREAK_SPACES, ' ')
		: '—';

/**
 * The number format of a locale (US English for none or an unknown one).
 * @param {string | null | undefined} locale
 * @param {number} [maximumFractionDigits]
 */
const numberIn = (locale, maximumFractionDigits = 3) => {
	if ((!locale || locale === 'en-US') && maximumFractionDigits === 3) return CREDITS;
	try {
		return new Intl.NumberFormat(locale || 'en-US', { minimumFractionDigits: 0, maximumFractionDigits });
	} catch {
		return CREDITS;
	}
};

/**
 * `12.345 credits` (or `1 credit`); with `locale`, the number in that locale (`12,345 credits`).
 * @param {number | null | undefined} millicredits
 * @param {{ locale?: string | null }} [options]
 * @returns {string}
 */
export const formatCredits = (millicredits, options = {}) => {
	const text = creditsNumber(millicredits, options);
	if (text === '—') return text;
	return `${text} ${Math.abs(/** @type {number} */ (millicredits)) === 1000 ? 'credit' : 'credits'}`;
};

/**
 * `1.25 credits/h`; with `locale`, the number in that locale.
 * @param {number | null | undefined} millicredits per hour
 * @param {{ locale?: string | null }} [options]
 */
export const formatCreditsPerHour = (millicredits, options = {}) =>
	creditsNumber(millicredits, options) === '—' ? '—' : `${creditsNumber(millicredits, options)} credits/h`;

/**
 * Parse a credits amount typed by a person (`12`, `12.5`, `0.125`) into integer millicredits.
 * @param {string} input
 * @returns {{ ok: true, value: number } | { ok: false, message: string }}
 */
export const parseCredits = (input) => {
	const text = String(input ?? '').trim();
	if (!/^\d{1,12}(\.\d{1,3})?$/.test(text)) return { ok: false, message: 'Enter an amount in credits with up to 3 decimals.' };
	const [whole = '0', fraction = ''] = text.split('.');
	return { ok: true, value: Number(whole) * 1000 + Number(fraction.padEnd(3, '0')) };
};

/** @param {unknown} value */
const toDate = (value) => {
	if (value === null || value === undefined || value === '') return null;
	const d = value instanceof Date ? value : new Date(/** @type {string | number} */ (value));
	return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The date and time format of a time zone and a locale (US English by default); UTC for UTC, a missing or an unknown
 * zone; US English for an unknown locale.
 * @param {string | null | undefined} timeZone IANA time zone
 * @param {string | null | undefined} [locale] BCP 47 language tag (the website Format's `locale`)
 */
const dateTimeIn = (timeZone, locale) => {
	const zone = !timeZone ? 'UTC' : timeZone;
	if (zone === 'UTC' && (!locale || locale === 'en-US')) return DATE_TIME;
	try {
		return new Intl.DateTimeFormat(locale || 'en-US', { ...DATE_TIME_PARTS, timeZone: zone });
	} catch {
		try {
			return new Intl.DateTimeFormat('en-US', { ...DATE_TIME_PARTS, timeZone: zone });
		} catch {
			return DATE_TIME;
		}
	}
};

/**
 * `Oct 1, 2026, 10:00 AM UTC`; with `timeZone`, the same style in that zone (`Oct 1, 2026, 6:00 AM EDT`); with
 * `locale`, that locale's order and clock (`en-GB`: `1 Oct 2026, 10:00 UTC`).
 * @param {string | number | Date | null | undefined} value
 * @param {{ timeZone?: string | null, locale?: string | null }} [options] IANA time zone (default UTC), BCP 47 locale
 *   (default en-US)
 */
export const formatDateTime = (value, { timeZone, locale } = {}) => {
	const d = toDate(value);
	return d ? dateTimeIn(timeZone, locale).format(d).replace(NO_BREAK_SPACES, ' ') : '—';
};

/**
 * `Oct 1, 2026` (UTC); with `locale`, that locale's order (`en-GB`: `1 Oct 2026`).
 * @param {string | number | Date | null | undefined} value
 * @param {{ locale?: string | null }} [options]
 */
export const formatDate = (value, { locale } = {}) => {
	const d = toDate(value);
	if (!d) return '—';
	if (!locale || locale === 'en-US') return DATE.format(d);
	try {
		return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
	} catch {
		return DATE.format(d);
	}
};

/** Short words written in capitals (or with their own casing) when a choice's value is shown as a label. */
const WORD_CASE = Object.freeze({
	ai: 'AI',
	api: 'API',
	cod: 'COD',
	csv: 'CSV',
	html: 'HTML',
	iban: 'IBAN',
	id: 'ID',
	ip: 'IP',
	pdf: 'PDF',
	seo: 'SEO',
	sku: 'SKU',
	sms: 'SMS',
	url: 'URL',
	utc: 'UTC',
	whatsapp: 'WhatsApp',
});

/**
 * The rows of a Format's own symbols, one per currency, in the order they were added.
 * @param {Readonly<Record<string, string>>} symbols
 * @returns {Array<{ currency: string, symbol: string }>}
 */
export const symbolRowsOf = (symbols) => Object.entries(symbols).map(([currency, symbol]) => ({ currency, symbol }));

/**
 * The Format's own symbols from the rows: codes in capitals, rows without a code or a symbol left out (the product
 * checks the rest when it is saved).
 * @param {ReadonlyArray<{ currency: string, symbol: string }>} rows
 * @returns {Record<string, string>}
 */
export const symbolsOf = (rows) =>
	Object.fromEntries(
		rows
			.map((row) => [row.currency.trim().toUpperCase(), row.symbol.trim()])
			.filter(([currency, symbol]) => currency !== '' && symbol !== ''),
	);

/**
 * A support contact channel of the Portal (`@ss/contracts/text` support channels).
 * @typedef {{ type: 'email' | 'phone' | 'link', label: string, url: string }} SupportChannel
 */

/**
 * The support contact in one line, each channel as what people read and its label (`help@example.com (Email),
 * https://wa.me/15550100 (WhatsApp)`), or `fallback` without channels.
 * @param {{ channels: ReadonlyArray<SupportChannel> }} support
 * @param {string} [fallback]
 * @returns {string}
 */
export const supportContact = (support, fallback = 'support') =>
	support.channels.map((channel) => `${channel.url.replace(/^(?:mailto|tel):/, '')} (${channel.label})`).join(', ') || fallback;

/**
 * A readable label for a code (a status, a choice's value): `low_balance` → "Low balance", `per_unit_down` → "Per unit
 * down", `sms` → "SMS", `postalCode` → "Postal code", `line1` → "Line 1"; the stored value stays as it is. Values that
 * are not plain words (numbers, mixed case) are shown as they are; nothing (`null`, `undefined`, `''`) is `''`.
 * @param {unknown} value
 * @returns {string}
 */
export const humanize = (value) => {
	if (value === null || value === undefined) return '';
	const text = String(value);
	if (!/^[a-z][a-zA-Z0-9]*(?:[_-][a-zA-Z0-9]+)*$/.test(text)) return text;
	const words = text
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([a-zA-Z])([0-9])/g, '$1 $2')
		.split(/[_\s-]+/)
		.map((word) => word.toLowerCase())
		.map((word) => WORD_CASE[/** @type {keyof typeof WORD_CASE} */ (word)] ?? word);
	const [first = '', ...rest] = words;
	return [first === first.toLowerCase() ? first.charAt(0).toUpperCase() + first.slice(1) : first, ...rest].join(' ');
};
