/**
 * Money and dates in the widgets (PLAN 0.8.10 K7): every amount and time a widget shows follows the widget config's
 * Format and business time zone, for the viewer of the page (the browser's language and time zone).
 * @module
 */
import { formatDate, formatMoney, viewerOf } from '@ss/app-kit/widget';

/**
 * The formatters of one widget.
 * @param {Pick<import('./widget.js').WidgetConfig, 'format' | 'timeZone'>} config
 * @param {HTMLElement} host the widget's element (its window is the viewer's)
 */
export const formattersOf = (config, host) => {
	const viewer = viewerOf(host.ownerDocument.defaultView);
	return Object.freeze({
		/** @param {number} amount minor units @param {string} currency */
		money: (amount, currency) => formatMoney(amount, currency, config.format, viewer),
		/** @param {string | number | Date} value an instant */
		date: (value) => formatDate(value, config.format, { timeZone: config.timeZone, style: 'datetime', viewer }),
	});
};
