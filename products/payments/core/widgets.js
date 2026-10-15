/**
 * Names the widgets, pages and docs share (PLAN 0.4.10): the browser global of `widget.js` (`window.SSPayments`), the
 * attribute of the elements the merchant places (`<div data-ss-payments="pay_button" data-link="link_…">`) and the
 * content types of bank-transfer proofs.
 * @module
 */

/** The browser global `widget.js` sets: `window.SSPayments.admin({ getTicket })`. */
export const WIDGET_GLOBAL = 'SSPayments';

/** Widgets mount only into elements with this attribute; its value is the widget key from manifest.json. */
export const WIDGET_ATTRIBUTE = 'data-ss-payments';

/** Content types a bank-transfer proof may have, with their file extensions. */
export const PROOF_TYPES = Object.freeze({
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/webp': 'webp',
	'application/pdf': 'pdf',
});
