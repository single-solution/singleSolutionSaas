/**
 * Names the page script, the widgets, the routes and the docs share (PLAN 0.4.10, 0.8.9): the browser global of
 * `widget.js` (`window.SSGrowth`), the attribute of the elements the merchant places
 * (`<div data-ss-growth="analytics_dashboard">`), the browser events the page script listens for and the key under
 * which the visitor's consent is kept in their own browser.
 * @module
 */

/**
 * The browser global `widget.js` sets: `window.SSGrowth.admin({ getTicket })`, `.consent`, `.search()`, `.contact()`,
 * `.notFound()`.
 */
export const WIDGET_GLOBAL = 'SSGrowth';

/** Widgets mount only into elements with this attribute; its value is the widget key from manifest.json. */
export const WIDGET_ATTRIBUTE = 'data-ss-growth';

/** A page marks itself as a 404 with `<meta name="ss-growth-page" content="not_found">`. */
export const PAGE_MARKER = 'ss-growth-page';

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

/**
 * More browser events the page script listens for (PLAN 0.8.10 G2): a site search (`detail`: `{ term, results? }`,
 * also `SSGrowth.search(term, { results })`) and a contact (`detail`: `{ method? }`, for example a WhatsApp or phone
 * link; also `SSGrowth.contact({ method })`). Both go to the loaded pixels; a search is also recorded (Searches and
 * 404s).
 */
export const SITE_EVENTS = Object.freeze({ 'ss:search': 'search', 'ss:contact': 'contact' });

/** The shop events, in the order of the shop funnel (each also a goal or funnel step's event, G1). */
export const FUNNEL_STEPS = Object.freeze(['view_item', 'add_to_cart', 'begin_checkout', 'purchase']);

/**
 * The events the page script knows by itself (G1, G2): the shop events, a site search and a contact. Any other event
 * name is a custom event the page sends with `SSGrowth.track(name, props)`.
 */
export const STANDARD_EVENTS = Object.freeze([...FUNNEL_STEPS, 'search', 'contact']);

/** Google Consent Mode v2's signals a consent category may grant (G3). */
export const CONSENT_SIGNALS = Object.freeze([
	'ad_storage',
	'ad_user_data',
	'ad_personalization',
	'analytics_storage',
	'functionality_storage',
	'personalization_storage',
	'security_storage',
]);

/** Where the visitor's consent choice is kept (their own browser's localStorage). */
export const CONSENT_STORAGE_KEY = 'ss-growth-consent';

/** Where the page script keeps the start of the current visit (sessionStorage: a time, never an id). */
export const VISIT_STORAGE_KEY = 'ss-growth-visit';

/** Where the page script keeps the tab's session with the `sessions` detail (sessionStorage: a random id, never a
 * cross-site id; PLAN 0.8.10 G3). */
export const SESSION_STORAGE_KEY = 'ss-growth-session';

/**
 * A stored consent choice is asked again after this many months unless the merchant sets their own (the consent
 * banner's setting "Ask again after", `askAgainMonths`, G6).
 */
export const CONSENT_MONTHS = 12;

/** The longest the merchant may keep a consent choice before it is asked again, in months. */
export const MAX_CONSENT_MONTHS = 24;

/** A visit ends after this long without a page view. */
export const VISIT_IDLE_MS = 30 * 60_000;
