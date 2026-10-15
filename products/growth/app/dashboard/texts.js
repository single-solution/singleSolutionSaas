/**
 * The dashboard's words (US English, kept in this file; the dashboard is not translated, PLAN 0.6): Growth's title and
 * its own words over the words every product dashboard shares (`@ss/ui`).
 * @module
 */
import { dashboardTexts } from '@ss/ui';

export const TEXTS = dashboardTexts({
	title: 'Growth',
	overview: {
		tags: 'Tags ready',
		tagsHelp: 'Switched-on tag features with a well-formed id or a script set (Settings).',
		ofTotal: '{count} of {total}',
		tagsStep: 'Set the ids of the tag features',
		noTag: {
			one: 'A tag feature has no id or script yet',
			many: '{count} tag features have no id or script yet',
			effect: 'They are charged, but load nothing on your pages until a well-formed id or a script is set in Settings.',
			action: 'Open Settings',
		},
	},
	settings: {
		looksHelp:
			'Every word of the consent banner, the notice bar and the admin widgets (the consent words included), their theme, and how money and dates look.',
		formatHelp: 'How money and dates look in the widgets (revenue and days in the analytics dashboard).',
		localeHelp: "A tag such as en-US or fr-FR; empty uses each visitor's browser.",
		consentWarning:
			'Tags load without waiting for consent. Laws in many places (for example the EU’s GDPR and ePrivacy rules and the UK’s PECR) require a visitor’s consent before tracking; you are responsible for following the law where you operate.',
		gtmMissing:
			'Google Analytics 4 is left to Tag Manager, but no well-formed Tag Manager container id is set, so Google Analytics gets nothing.',
	},
	developers: {
		script: 'Page script',
		scriptHelp:
			'Add it to the head of every page, before the other products’ scripts; it shows the consent banner and the notice bar, loads your tags after consent and records analytics.',
		events: 'Shop events',
		eventsHelp:
			'Browser events Ecommerce’s widgets send by themselves and your own code may send; also site searches, contacts and 404s.',
		api: 'API',
		apiHelp:
			'Your server reads analytics, serves robots.txt and the verification tags, submits to IndexNow, runs the SEO checklist and applies the redirects with the server token.',
		widgets: 'Widget snippets',
		widgetsHelp: 'The analytics dashboard, the SEO checklist and the redirects in your own admin.',
		ticket: 'Ticket snippet',
		ticketHelp: 'Your server asks for a ticket for the admin widgets after checking its user.',
	},
	setup: {
		title: 'Setup at a glance',
		help: 'How the switched-on features are set up for this website, from their settings.',
		tagsTitle: 'Tags and consent',
		consent: 'Consent',
		waits: 'Tags wait for consent',
		noWait: 'Tags load without consent',
		banner: 'Consent banner',
		on: 'On',
		ownTool: 'Off: your own consent tool',
		set: 'Set',
		notSet: 'Not set',
		viaGtm: 'Inside Tag Manager',
		itemIds: 'Item ids sent',
		ids: { product: 'Product ids', variant: 'Variant ids' },
		analyticsTitle: 'Visitor analytics',
		detail: 'Detail',
		anonymous: 'Anonymous',
		sessions: 'Sessions',
		afterConsent: 'Counts only after consent',
		country: 'Country and city',
		retention: 'Raw events kept',
		months: '{months} months',
		recorded: 'Also recorded',
		visitsOnly: 'Visits and pages only',
		parts: {
			conversion_funnel: 'Conversion funnel',
			searches_404s: 'Searches and 404s',
			web_vitals: 'Web Vitals',
		},
		vitalsToGa4: 'Web Vitals to Google Analytics',
		seoTitle: 'Search engines',
		aiCrawlers: 'AI training crawlers',
		blocked: 'Blocked',
		allowed: 'Allowed',
		sitemaps: 'Sitemaps in robots.txt',
		verification: 'Verification tags',
		indexnow: 'IndexNow key file',
		noKey: 'No key set',
		checklist: 'SEO checklist',
		pages: '{count} pages',
		noticeTitle: 'Notice bar',
		now: 'Now',
		closes: 'Visitors can close it',
		closeFor: { visit: 'Yes, for the visit', page: 'Yes, for the page' },
		hiddenOn: 'Hidden on',
		none: 'None',
		yes: 'Yes',
		no: 'No',
		noticeShowing: 'Showing',
		noticeEmpty: 'Not shown: no text',
		noticeOff: 'Not shown: turned off',
		noticeBadDates: 'Not shown: a date is not a time',
		noticeStarts: 'Starts {time}',
		noticeEnded: 'Ended {time}',
		malformed: 'Not loaded, as they are not well formed: {fields}.',
		vitalsNoGoogle:
			'Web Vitals go to Google Analytics only while Google tags is on with a Google Analytics 4 id or a Tag Manager container.',
		vitalsGa4Only: 'Visitor analytics is off: Web Vitals go to Google Analytics only and nothing is kept in your database.',
		vitalsNowhere:
			'Visitor analytics is off and Web Vitals do not go to Google Analytics, so nothing is measured: turn on one of them.',
		robotsPreview: 'Your site serves this at https://{domain}/robots.txt (GET /v1/robots.txt):',
		tagsPreview: 'Your page head includes these tags (GET /v1/verification):',
		noTags: '(no verification tags yet)',
		keyAt: 'Your site serves the key {key} as plain text at {url}; every submission names that address.',
		yourKey: '(your key)',
		keyPathBad:
			'The key file address is not a path on your website (for example /indexnow-key.txt): submissions are refused until it is.',
	},
});
