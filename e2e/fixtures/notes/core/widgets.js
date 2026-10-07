/**
 * Names the widgets and the docs share (PLAN 0.4.10): the browser global of `widget.js` (`window.SS<Product>`) and
 * the attribute of the elements the merchant places for widgets (`<div data-ss-<id>="note_form"></div>`).
 * @module
 */

/** The browser global `widget.js` sets: `window.SSNotes.admin({ getTicket })`. */
export const WIDGET_GLOBAL = 'SSNotes';

/** Widgets mount only into elements with this attribute; its value is the widget key from manifest.json. */
export const WIDGET_ATTRIBUTE = 'data-ss-notes';

/** The feature each widget belongs to (manifest.json `widgets`): a widget mounts only while its feature is on. */
export const WIDGET_FEATURES = Object.freeze({ note_form: 'notes', inbox: 'notes' });
