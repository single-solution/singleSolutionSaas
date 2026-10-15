/**
 * The words every product dashboard shares (US English, kept in this file; the dashboards are not translated, PLAN
 * 0.6). A product passes its title and its own words through `dashboardTexts`, which may also reword a shared text
 * (its own `settings.looksHelp`, for example); the Overview's words are in `overview-texts.js`.
 * @module
 */
export const DASHBOARD_TEXTS = Object.freeze({
	loading: 'Loading…',
	signedOut: 'Open this dashboard from the Portal.',
	failed: 'This could not be loaded.',
	backToPortal: 'Back to Portal',
	pickWebsite: 'Pick a website',
	website: 'Website',
	adminView: 'Admin view: {merchant} / {domain}',
	saved: 'Saved',
	save: 'Save',
	reset: 'Reset to default',
	cancel: 'Cancel',
	andMore: '{names} and {count} more',
	tabs: Object.freeze({
		overview: 'Overview',
		features: 'Features',
		settings: 'Settings',
		connections: 'Connections',
		developers: 'Developers',
		defaults: 'Defaults',
		prices: 'Prices',
	}),
	features: Object.freeze({
		price: 'Price: {price}',
		on: 'On',
		needs: 'Needs: {features}',
		contact: 'To change features, contact {contact}.',
		confirmTitle: 'Save features?',
		confirmCost: 'New hourly cost: {cost}',
		alsoOff: 'Also turned off: {features}',
		docs: 'Docs',
		notWorking: 'Not working: connect {connection}',
	}),
	settings: Object.freeze({
		texts: 'Widget texts',
		textsHelp: 'Every word the widgets show. A text must keep the same {placeholders} as the English text.',
		textsFilter: 'Find a text',
		theme: 'Theme',
		mode: 'Light or dark',
		modes: Object.freeze({ auto: 'Follow device', light: 'Light', dark: 'Dark' }),
		fontFamily: 'Font family (inherit, or a font your site loads)',
		radius: 'Corner radius (0–24 px)',
		accent: 'Accent color',
		customCss: 'Custom CSS',
		format: 'Format',
		formatHelp: 'How money and dates look in the widgets, messages, invoices and pages.',
		locale: 'Language and region',
		localeHelp: "A tag such as en-US or fr-FR; empty uses each visitor's browser (en-US in messages).",
		currencyDisplay: 'Currency shown as',
		currencyDisplays: Object.freeze({
			code: 'Code (USD 12,500.00)',
			symbol: 'Symbol ($12,500.00)',
			custom: 'Your own symbol',
		}),
		currencySymbol: 'Your own symbol (up to 8 characters)',
		times: 'Dates and times in',
		timesOptions: Object.freeze({
			viewer: "Each visitor's time zone",
			business: 'Your business time zone (business.json)',
		}),
		wholeUnits: 'Whole amounts only (no minor units)',
		off: 'This feature is off.',
		featuresTitle: 'Feature settings',
		featuresHelp: 'How each feature behaves on this website.',
		looksTitle: 'Words and look',
		looksHelp: 'Every word the widgets show, their theme, and how money and dates look.',
	}),
	connections: Object.freeze({
		neededBy: 'Needed by: {features}',
		connected: 'Connected',
		not_connected: 'Not connected',
		test_failed: 'Test failed',
		value: 'New value',
		token: 'Server token of that product for this website',
		neededByNone: 'Optional',
		save: 'Save and test',
		test: 'Test',
		more: 'More actions for {name}',
		remove: 'Remove',
		removeTitle: 'Remove {name}?',
		removeHelp: 'The saved value is deleted here. The features that need it stop working until it is connected again.',
		none: 'No connections.',
	}),
	developers: Object.freeze({
		intro: 'The docs show every feature, widget and route. Features that are off are marked.',
		openDocs: 'Open the docs',
		websiteId: 'This website’s id: {id}',
		script: 'Widget script',
		scriptHelp: 'Add it to the pages that show the widgets; your browser token is in the Portal.',
		server: 'Your server calls the API with the server token, kept as SS_SERVER_TOKEN on your server.',
		manageTokens: 'Manage tokens in the Portal',
		off: 'off',
	}),
	defaults: Object.freeze({
		intro: 'Global defaults apply to every website that has not saved its own value.',
	}),
	prices: Object.freeze({
		intro: 'One hourly price per feature, in credits, for every merchant and website.',
		perHour: 'Credits per hour',
	}),
	reseal: Object.freeze({
		title: 'Encryption key',
		intro: 'After ENCRYPTION_KEY is changed, with the old key set as ENCRYPTION_KEY_PREVIOUS, seal every stored secret again with the new key. Pressing again is safe.',
		button: 'Re-seal stored secrets',
		result: '{resealed} re-sealed, {current} already on the current key, {unreadable} could not be opened with either key.',
		finished: 'Every stored secret that opens now uses the current key: ENCRYPTION_KEY_PREVIOUS can be removed.',
		again: '{failed} websites could not be reached: press again later, and keep ENCRYPTION_KEY_PREVIOUS until none is left.',
	}),
});

/** @param {unknown} value */
const isGroup = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `own` laid over `base`, group by group (frozen).
 * @param {Record<string, any>} base
 * @param {Record<string, any>} own
 * @returns {Record<string, any>}
 */
const merge = (base, own) => {
	/** @type {Record<string, any>} */
	const out = { ...base };
	for (const [key, value] of Object.entries(own))
		out[key] = isGroup(value) && isGroup(base[key]) ? merge(base[key], value) : isGroup(value) ? merge({}, value) : value;
	return Object.freeze(out);
};

/**
 * A product's dashboard words: the shared words with the product's title and its own words laid over them, group by
 * group (a product's `settings.looksHelp` rewords that one text and keeps the other settings words). Calling it again
 * on its result changes nothing.
 * @template {{ title: string }} T
 * @param {T} own
 * @returns {typeof DASHBOARD_TEXTS & T}
 */
export const dashboardTexts = (own) => /** @type {typeof DASHBOARD_TEXTS & T} */ (merge(DASHBOARD_TEXTS, own));
