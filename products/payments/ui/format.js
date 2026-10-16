/**
 * Money and dates in the widgets (PLAN 0.8.10 K7): every amount and time a widget shows follows the widget config's
 * Format and business time zone, for the viewer of the page (the browser's language and time zone). Amounts people
 * type take the decimal sign money is shown with (P6).
 * @module
 */
import { formatDate, formatMoney, normalizeFormat, viewerOf } from '@ss/app-kit/widget';
import { amountOf, amountText, decimalSignOf } from '../core/money.js';

/**
 * The formatters of one widget.
 * @param {Pick<import('./widget.js').WidgetConfig, 'format' | 'timeZone'>} config
 * @param {HTMLElement} host the widget's element (its window is the viewer's)
 */
export const formattersOf = (config, host) => {
	const viewer = viewerOf(host.ownerDocument.defaultView);
	// the language money is shown in: the Format's, else the viewer's
	const decimalSign = decimalSignOf(normalizeFormat(config.format).locale || viewer.locale || '');
	return Object.freeze({
		/** @param {number} amount minor units @param {string} currency */
		money: (amount, currency) => formatMoney(amount, currency, config.format, viewer),
		/** @param {string | number | Date} value an instant */
		date: (value) => formatDate(value, config.format, { timeZone: config.timeZone, style: 'datetime', viewer }),
		decimalSign,
		/**
		 * An amount typed in an input, as minor units, or null (see `amountOf`).
		 * @param {string} text @param {string} currency
		 */
		amountOf: (text, currency) => amountOf(text, currency, decimalSign),
		/**
		 * Minor units as a plain number to type, with that decimal sign.
		 * @param {number} amount @param {string} currency
		 */
		amountText: (amount, currency) => amountText(amount, currency, decimalSign),
	});
};
