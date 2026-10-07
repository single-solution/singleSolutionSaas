/**
 * Display rules shared by the price block, the sticky buy bar, related cards and the gallery: money formatting through
 * `Intl` (locale and currency always come from the page or the configuration), savings, and image alt text built
 * from a merchant-editable template.
 * @module
 */
import { text } from './util.js';

/** `currencyDisplay` values of `Intl.NumberFormat`. */
export const CURRENCY_DISPLAYS = Object.freeze(/** @type {const} */ (['symbol', 'narrowSymbol', 'code', 'name']));

/**
 * @typedef {object} MoneyOptions
 * @property {string} [locale] BCP 47 tag ('' = the visitor's)
 * @property {(typeof CURRENCY_DISPLAYS)[number]} [display]
 * @property {number} [digits] fraction digits; -1 = the currency's own
 */

/**
 * Format a decimal price string. Without a currency the number alone is formatted; an unknown locale falls back to
 * the runtime default.
 * @param {string} price decimal string ('' → '')
 * @param {string} currency ISO 4217 code or ''
 * @param {MoneyOptions} [options]
 * @returns {string}
 */
export const formatMoney = (price, currency, { locale = '', display = 'symbol', digits = -1 } = {}) => {
	if (price === '') return '';
	const amount = Number(price);
	const fraction = digits >= 0 ? { minimumFractionDigits: digits, maximumFractionDigits: digits } : {};
	/** @type {Intl.NumberFormatOptions} */
	const options = currency ? { style: 'currency', currency, currencyDisplay: display, ...fraction } : fraction;
	try {
		return new Intl.NumberFormat(locale || undefined, options).format(amount);
	} catch {
		return new Intl.NumberFormat(undefined, options).format(amount);
	}
};

const SCALE = 10_000;
/** @param {string} price */
const units = (price) => Math.round(Number(price) * SCALE);

/**
 * Savings of a sale price against its compare-at price, or null when there is none.
 * @param {string} price
 * @param {string} compareAt
 * @returns {{ amount: string, percent: number } | null}
 */
export const savings = (price, compareAt) => {
	if (price === '' || compareAt === '') return null;
	const now = units(price);
	const was = units(compareAt);
	if (!(was > now) || was <= 0) return null;
	return { amount: String((was - now) / SCALE), percent: Math.round(((was - now) / was) * 100) };
};

/**
 * Fill `{name}` placeholders with text (unknown names stay visible).
 * @param {string} template
 * @param {Readonly<Record<string, string | number>>} params
 * @returns {string}
 */
export const fillText = (template, params) =>
	template.replace(/\{([A-Za-z_]\w*)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));

export const ALT_MAX = 125;

/**
 * Alt text of a gallery image: the merchant's own alt wins when it says more than the bare title; otherwise the
 * template (`{title}`, `{brand}`, `{index}`, `{total}`) — the single-image template when there is one image. Capped
 * at {@link ALT_MAX} characters.
 * @param {{ stored: string, title: string, brand: string, index: number, total: number, template: string, single: string }} input
 * @returns {string}
 */
export const altText = ({ stored, title, brand, index, total, template, single }) => {
	const own = text(stored, 250);
	const generic = own === '' || own.toLowerCase() === title.toLowerCase();
	const alt = generic ? text(fillText(total > 1 ? template : single, { title, brand, index: index + 1, total }), 250) : own;
	const chars = [...alt];
	return chars.length > ALT_MAX
		? `${chars
				.slice(0, ALT_MAX - 1)
				.join('')
				.trimEnd()}…`
		: alt;
};

/**
 * A decimal price in integer minor units of its currency (`12.5 EUR` → 1250, `1500 JPY` → 1500), or null.
 * @param {string} price
 * @param {string} currency
 * @returns {number | null}
 */
export const minorUnits = (price, currency) => {
	if (price === '' || currency === '') return null;
	try {
		const digits =
			new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
		const amount = Math.round(Number(price) * 10 ** digits);
		return Number.isSafeInteger(amount) ? amount : null;
	} catch {
		return null;
	}
};

/**
 * Data of the standard `item.viewed@1` event for an item, or null when its id is not an opaque id.
 * @param {import('./item.js').Item} item
 * @returns {{ itemId: string, price?: { amount: number, currency: string } } | null}
 */
export const itemViewedData = (item) => {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item.id)) return null;
	const amount = minorUnits(item.price, item.currency);
	return amount === null ? { itemId: item.id } : { itemId: item.id, price: { amount, currency: item.currency } };
};
