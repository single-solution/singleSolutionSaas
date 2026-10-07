/**
 * Formatting for the consoles. Money is always shown in **credits** derived from integer millicredits (1 credit =
 * 1000 millicredits), with at most 3 decimals and no rounding beyond that (millicredits are exact).
 * Dates render in UTC so server and browser output agree (no hydration drift).
 * @module
 */

const CREDITS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
const INTEGER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
	year: 'numeric',
	month: 'short',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	timeZone: 'UTC',
	hourCycle: 'h23',
});
const DATE = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });

/**
 * Credits from millicredits as a plain number string (`12.345`); `—` for null/undefined/NaN.
 * @param {number | null | undefined} millicredits
 * @returns {string}
 */
export const creditsNumber = (millicredits) => {
	if (typeof millicredits !== 'number' || !Number.isFinite(millicredits)) return '—';
	// integer millicredits divide exactly into ≤ 3 decimals
	return CREDITS.format(Math.trunc(millicredits) / 1000);
};

/**
 * `12.345 credits` (or `1 credit`). `signed` adds `+` to positive amounts.
 * @param {number | null | undefined} millicredits
 * @param {{ signed?: boolean, unit?: boolean }} [options]
 * @returns {string}
 */
export const formatCredits = (millicredits, { signed = false, unit = true } = {}) => {
	const text = creditsNumber(millicredits);
	if (text === '—') return text;
	const sign = signed && /** @type {number} */ (millicredits) > 0 ? '+' : '';
	if (!unit) return `${sign}${text}`;
	return `${sign}${text} ${Math.abs(/** @type {number} */ (millicredits)) === 1000 ? 'credit' : 'credits'}`;
};

/**
 * `1.25 credits/h`.
 * @param {number | null | undefined} millicredits per hour
 */
export const formatCreditsPerHour = (millicredits) =>
	creditsNumber(millicredits) === '—' ? '—' : `${creditsNumber(millicredits)} credits/h`;

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
 * `01 Oct 2026, 10:00 UTC`.
 * @param {string | number | Date | null | undefined} value
 */
export const formatDateTime = (value) => {
	const d = toDate(value);
	return d ? `${DATE_TIME.format(d)} UTC` : '—';
};

/**
 * `01 Oct 2026`.
 * @param {string | number | Date | null | undefined} value
 */
export const formatDate = (value) => {
	const d = toDate(value);
	return d ? DATE.format(d) : '—';
};

/**
 * Integer with thousands separators.
 * @param {number | null | undefined} value
 */
export const formatNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? INTEGER.format(value) : '—');

/**
 * Human label of a snake/kebab code (`low_balance` → `Low balance`).
 * @param {string | null | undefined} code
 */
export const humanize = (code) => {
	if (!code) return '';
	const text = String(code).replace(/[_-]+/g, ' ').trim();
	return text.charAt(0).toUpperCase() + text.slice(1);
};
