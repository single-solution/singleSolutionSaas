/**
 * What every product's public docs say about the kit's routes for the merchant's server (PLAN 0.4.10 docs; 0.8.10 K1–K9):
 * the settings API, the acting user, visitor calls from the server, counts, the activity log, events and the Format.
 * Plain text; each product renders the sections in its own `/docs` page (escaped like the rest of the page).
 * @module
 */

/** @typedef {{ id: string, title: string, paragraphs: readonly string[] }} GuideSection */

/** @type {ReadonlyArray<Readonly<GuideSection>>} */
export const KIT_GUIDE = Object.freeze([
	Object.freeze({
		id: 'server-settings',
		title: 'Settings from your server',
		paragraphs: Object.freeze([
			'Your server can read and change this product’s setup with the server token, with the same rights as you have in the dashboard: settings only of features that are on, never the feature switches or prices. GET /v1/features lists the features with on/off and their hourly price. GET /v1/settings lists every feature with its settings schema and, for features that are on, each value and where it comes from (website, default or built-in). PUT /v1/settings/<feature>.<setting> with { value } saves one value (422 validation_failed with errors when it does not fit, 403 feature_off when the feature is off); DELETE resets it to the default.',
			'The same goes for widget texts (GET /v1/texts, PUT and DELETE /v1/texts/<key>), the theme (GET and PUT /v1/theme), the Format (GET and PUT /v1/format), list settings (GET and PUT /v1/lists/<list> with { value }: the whole list) and connections (GET /v1/connections; PUT /v1/connections/<name> with { value } is checked and tested live; DELETE; POST /v1/connections/<name>/test). Secrets never come back: a connection shows only its state, its last 4 characters and the last test’s message. Every change shows in Recent changes; at most 60 changes per minute per website.',
		]),
	}),
	Object.freeze({
		id: 'acting-user',
		title: 'Who acts: SS-Actor headers',
		paragraphs: Object.freeze([
			'A server-token request may name the member of your staff it acts for: SS-Actor-Id (1–64 letters, digits and _ . : @ -; the Accounts user id when you use Accounts), SS-Actor-Name (percent-encoded UTF-8, at most 120 characters), and optionally SS-Actor-Role (percent-encoded, at most 40) and SS-Actor-Email. Their name then shows wherever this product records who did something (the activity log, histories, replies and notes, Recent changes), and they join the staff list. Without the headers the actor is your server. A malformed header answers 400 invalid_actor. The headers grant nothing: the server token can do everything either way.',
		]),
	}),
	Object.freeze({
		id: 'server-visitors',
		title: 'Visitor calls from your server',
		paragraphs: Object.freeze([
			'Every visitor route (the ones your pages call with the browser token) also takes the server token, without an Origin header, for server-rendered and cached pages and for a store admin on its own host. Such a request acts for one visitor: send their sign-in in SS-Sign-In, and SS-Visitor-IP with their IP address (required on writes, else 400 visitor_ip_required). The answer is exactly the visitor answer. These calls count in their own window of 3,000 requests per minute per route per website, not the browser one, plus the per-visitor limits by that address, and never count as the widget being installed.',
		]),
	}),
	Object.freeze({
		id: 'counts',
		title: 'Counts',
		paragraphs: Object.freeze([
			'A main list GET /v1/<list> also answers GET /v1/<list>/count with the same filters → { count, capped } (exact up to 100,000) and GET /v1/<list>/counts?by=<field> → { total, groups } for the fields the list names (the 50 largest groups). The admin widgets’ twins sit under /v1/admin/. A count needs the same feature and permission as its list and answers 503 count_timeout when it takes longer than 3 seconds.',
		]),
	}),
	Object.freeze({
		id: 'activity',
		title: 'Activity log',
		paragraphs: Object.freeze([
			'GET /v1/activity?actor=&action=&target=&q=&from=&to=&cursor= (server token, newest first) reads the activity log this product keeps in your database: who (actor with kind, id, name and role), what (action), on what (target and its label, for example an order number), when, and a short plain-text detail. from and to take an ISO-8601 time or a day (YYYY-MM-DD, in your business.json time zone); q searches labels, details and names. GET /v1/activity/count and /v1/activity/counts?by=action|actor|kind count it. With the Accounts token pasted, each entry is also copied to Accounts.',
		]),
	}),
	Object.freeze({
		id: 'format',
		title: 'Format and time zone',
		paragraphs: Object.freeze([
			'Settings → Format (or GET and PUT /v1/format) decides how money and dates look in widgets, messages, invoices and hosted pages: locale (a language tag such as en-GB, or empty for the visitor’s own browser; text made on the server then uses en), currencyDisplay (code “PKR 12,500.00”, symbol “Rs 12,500.00” or custom with currencySymbol), wholeUnits (no minor units) and times (viewer: each visitor’s own time zone; business: your business.json time zone). Text made on the server always uses your business.json time zone, and so does every calendar rule (days, months and years), UTC when it is missing.',
		]),
	}),
]);
