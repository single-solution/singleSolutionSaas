/**
 * Names the page script, the widgets, the routes and the docs share (PLAN 0.4.10, 0.8.9): the browser global of
 * `widget.js` (`window.SSGrowth`), the attribute of the elements the merchant places
 * (`<div data-ss-growth="analytics_dashboard">`), the feature of each widget, the browser events the page script
 * listens for and the key under which the visitor's consent is kept in their own browser.
 * @module
 */

/** The browser global `widget.js` sets: `window.SSGrowth.admin({ getTicket })`, `.consent`, `.search()`, `.notFound()`. */
export const WIDGET_GLOBAL = 'SSGrowth';

/** Widgets mount only into elements with this attribute; its value is the widget key from manifest.json. */
export const WIDGET_ATTRIBUTE = 'data-ss-growth';

/** A page marks itself as a 404 with `<meta name="ss-growth-page" content="not_found">`. */
export const PAGE_MARKER = 'ss-growth-page';

/** The features of each widget (manifest.json `widgets`): a widget mounts only while one of them is on. */
export const WIDGET_FEATURES = Object.freeze({
	consent_banner: Object.freeze(['consent_banner']),
	notice_bar: Object.freeze(['notice_bar']),
	analytics_dashboard: Object.freeze(['visitor_analytics']),
	seo_checklist: Object.freeze(['seo_checklist', 'indexnow']),
});

/**
 * The browser events Growth's page script listens for on `window` (PLAN 0.8.9). Ecommerce's shopper widgets dispatch
 * them; the merchant's own code may too. Each maps to the funnel step it records.
 */
export const BROWSER_EVENTS = Object.freeze({
	'ss:view_item': 'view_item',
	'ss:add_to_cart': 'add_to_cart',
	'ss:begin_checkout': 'begin_checkout',
	'ss:purchase': 'purchase',
});

/** The funnel steps, in order. */
export const FUNNEL_STEPS = Object.freeze(['view_item', 'add_to_cart', 'begin_checkout', 'purchase']);

/** Where the visitor's consent choice is kept (their own browser's localStorage). */
export const CONSENT_STORAGE_KEY = 'ss-growth-consent';

/** Where the page script keeps the start of the current visit (sessionStorage: a time, never an id). */
export const VISIT_STORAGE_KEY = 'ss-growth-visit';

/** A stored consent choice is asked again after this many days. */
export const CONSENT_DAYS = 365;

/** A visit ends after this long without a page view. */
export const VISIT_IDLE_MS = 30 * 60_000;
