/**
 * Names the widgets, pages and docs share (PLAN 0.4.10): the browser global of `widget.js` (`window.SSPayments`), the
 * attribute of the elements the merchant places (`<div data-ss-payments="pay_button" data-link="link_…">`) and the
 * feature of each widget.
 * @module
 */

/** The browser global `widget.js` sets: `window.SSPayments.admin({ getTicket })`. */
export const WIDGET_GLOBAL = 'SSPayments';

/** Widgets mount only into elements with this attribute; its value is the widget key from manifest.json. */
export const WIDGET_ATTRIBUTE = 'data-ss-payments';

/** The features of each widget (manifest.json `widgets`): a widget mounts only while one of them is on. */
export const WIDGET_FEATURES = Object.freeze({
	pay_button: Object.freeze(['payment_links', 'payment_api']),
	payments_admin: Object.freeze(['payment_api']),
	subscriptions_admin: Object.freeze(['subscriptions']),
});

/** Content types a bank-transfer proof may have, with their file extensions. */
export const PROOF_TYPES = Object.freeze({
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'application/pdf': 'pdf',
});
