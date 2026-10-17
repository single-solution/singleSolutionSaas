/**
 * What every product's public docs say about the kit's routes for the merchant's server (PLAN 0.4.10 docs; 0.8.10 K1–K9):
 * the settings API, the signed-in staff member, visitor calls from the server, counts, the activity log and the Format.
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
			'Your server reads this product’s setup with the server token. A change needs more than the token: the signed-in member of your staff, whose role has the permission (see “Who acts” below); on its own the server token changes no setting, text, theme, Format, list or connection (403 needs_signed_in_staff). The rights are those of the dashboard: settings only of features that are on, never the feature switches or prices. GET /v1/features lists the features with on/off and their hourly price. GET /v1/settings lists every feature with its settings schema and, for features that are on, each value and where it comes from (website, default or built-in). PUT /v1/settings/<feature>.<setting> with { value } saves one value (422 validation_failed with errors when it does not fit, 403 feature_off when the feature is off); DELETE resets it to the default.',
			'The same goes for widget texts (GET /v1/texts, PUT and DELETE /v1/texts/<key>), the theme (GET and PUT /v1/theme), the Format (GET and PUT /v1/format), list settings (GET and PUT /v1/lists/<list> with { value }: the whole list) and connections (GET /v1/connections; PUT /v1/connections/<name> with { value } is checked and tested live; DELETE; POST /v1/connections/<name>/test). Secrets never come back, not even their last characters: a connection shows only whether a value is stored (set), its state and the last test’s message. Changing a connection (database, storage, provider key or pasted product token) needs the permission connections.manage; changing a setting, text, theme, Format or list needs settings.manage. Every change shows in Recent changes, and a change of a setting, text, the theme, the Format or a list is also an entry of the activity log. At most 60 changes per minute per website, and 3,000 reads per minute of each of these addresses.',
		]),
	}),
	Object.freeze({
		id: 'acting-user',
		title: 'Who acts: the signed-in staff member',
		paragraphs: Object.freeze([
			'The server token runs your website, but it cannot change configuration or do staff work on its own. Everything a staff member does (change a setting, text, theme, Format, list, connection, role or template; work with orders, products, customers, conversations, payments; read the activity log; get an admin widget ticket) is a call with the server token and the Accounts sign-in of the signed-in staff member in the SS-Sign-In header. The product checks it for your website only, with your website’s Accounts keys (paste the Accounts token in Connections): signed by Accounts, made for this website, not expired. The role in it must have the permission the route needs (GET /v1/permissions lists them; the Owner role has them all). The person it names is who the activity log, histories, replies and notes record, and they join the staff list.',
			'A call with the server token alone is 403 needs_signed_in_staff; a sign-in of another website, an expired or a forged one is 401 invalid_sign_in (with a cause); a role without the permission is 403 forbidden. Headers that only name a person (the old SS-Actor-Id, SS-Actor-Name …) are ignored: they prove nothing. Reading the shop, the cart, checkout and the shopper’s own orders (with the shopper’s SS-Sign-In), sending messages and the import routes (while the Import feature is on) stay the server token’s own.',
		]),
	}),
	Object.freeze({
		id: 'server-visitors',
		title: 'Visitor calls from your server',
		paragraphs: Object.freeze([
			'Every visitor route (the ones your pages call with the browser token) also takes the server token, without an Origin header, for server-rendered and cached pages and for a store admin on its own host. Such a request acts for one visitor: send their sign-in in SS-Sign-In, and SS-Visitor-IP with their IP address (required on writes, else 400 visitor_ip_required). The sign-in is the shopper’s Accounts sign-in (the token Accounts gave your server when they signed in or renewed their session, valid for 15 minutes). The product checks it with your website’s Accounts keys and only for your website, then acts as that shopper and nobody else; a user id alone is never taken. A sign-in that is not valid is refused, never treated as a guest: 401 invalid_sign_in with a cause (audience for another website’s, expired or too_old, signature or unknown_key for one signed by other keys, malformed, accounts_not_connected until the Accounts token is pasted in Connections), or 503 accounts_unavailable while Accounts cannot be asked; renew the sign-in at Accounts and send the call again. Without SS-Sign-In the call is a visitor who is not signed in, so routes that need a shopper answer sign_in_required. The answer is exactly the visitor answer. These calls count in their own window of 3,000 requests per minute per route per website, not the browser one, plus the per-visitor limits by that address, and never count as the widget being installed.',
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
			'GET /v1/activity?actor=&action=&target=&q=&from=&to=&cursor= (server token and a staff sign-in with audit.read, newest first) reads the activity log this product keeps in your database: who (actor with kind, id, name and role), what (action), on what (target and its label, for example an order number), when, and a short plain-text detail. from and to take an ISO-8601 time or a day (YYYY-MM-DD, in your business time zone); q searches labels, details and names. GET /v1/activity/count and /v1/activity/counts?by=action|actor|kind count it. Settings changes made in the dashboard or through the settings API are entries too: action settings.changed, target what changed (settings.<feature>.<setting>, texts.<key>, theme, format or list.<list>), its name as the label (for example Checkout › Payment methods) and the change as the detail (changed, reset to default …). With the Accounts token pasted, each entry is also copied to Accounts.',
		]),
	}),
	Object.freeze({
		id: 'format',
		title: 'Format and time zone',
		paragraphs: Object.freeze([
			'The Format (set in the Portal under Website settings › Region and format; GET /v1/format reads it, PUT answers 409) decides how money and dates look in widgets, messages, invoices and hosted pages: locale (a language tag such as en-US or fr-FR, or empty for the visitor’s own browser; text made on the server then uses en-US), currencyDisplay (code “USD 12,500.00” or symbol “$12,500.00”), currencySymbols (your own symbol per currency, for example PKR “Rs” and CHF “Fr.”; a currency without one shows the usual symbol), wholeUnits (no minor units) and times (viewer: each visitor’s own time zone; business: your business time zone). Text made on the server always uses your business time zone (Website settings › Region and format), and so does every calendar rule (days, months and years), UTC when it is missing.',
		]),
	}),
]);
