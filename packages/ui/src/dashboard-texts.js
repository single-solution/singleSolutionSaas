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
	tryAgain: 'Try again',
	backToPortal: 'Back to Portal',
	pickWebsite: 'Pick a website',
	website: 'Website',
	adminView: 'Editing as admin: changes go live on {domain}',
	saved: 'Saved',
	saveFailed: 'Not saved',
	fixThese: 'Fix what is listed under the editor, then save again.',
	save: 'Save',
	reset: 'Reset to default',
	cancel: 'Cancel',
	rowActions: 'Actions for {name}',
	andMore: '{names} and {count} more',
	categories: Object.freeze({ more: 'More' }),
	managed: Object.freeze({
		title: 'Set in the Portal',
		open: 'Open Website settings',
	}),
	tabs: Object.freeze({
		overview: 'Overview',
		settings: 'Settings',
		texts: 'Texts',
		developers: 'Developers',
		defaults: 'Defaults',
		prices: 'Prices',
	}),
	features: Object.freeze({
		on: 'On',
		off: 'Off',
		cost: 'Cost',
		locked: 'Locked',
		docs: 'Docs',
		needsOn: 'Needs {features} to be on',
		switchOnHint: 'Switch on {name} to set it up.',
		switchOn: 'Switch on',
		switchOff: 'Switch off',
		switchOnTitle: 'Switch on {name}?',
		switchOffTitle: 'Switch off {name}?',
		confirmCost: 'New hourly cost: {cost}',
		alsoOff: 'Also turned off: {features}',
		askSupport: 'Ask support to switch it on: {contact}.',
		notWorking: 'Not working: connect {connection}',
		couldNotCheck: 'Could not check the connection',
		retry: 'Retry',
		needsSetup: 'Needs setup',
		connect: 'Connect',
	}),
	settings: Object.freeze({
		off: 'This feature is off.',
		nothingOn: 'There are no features to set up yet.',
		none: 'This feature has no settings to change.',
		changed: '{count} changed',
		settingsView: 'Settings',
		advanced: 'Advanced',
		advancedHelp: 'Settings most people never change',
		generate: 'Generate',
		invalidJson: 'Enter valid JSON.',
		inherited: 'Using your website’s {what}.',
		inheritedLink: 'Change it in the Portal',
		groups: 'Groups',
		needsAttention: 'Needs attention',
		unsaved: 'You have unsaved changes',
		saveChanges: 'Save changes',
		discard: 'Discard',
		featuresTitle: 'Feature settings',
		featuresHelp: 'How each feature behaves on this website.',
		navSearch: 'Search settings',
	}),
	texts: Object.freeze({
		title: 'Widget texts',
		help: 'Change any word the widgets show. Keep the {placeholders} the English text has.',
		search: 'Find a text by its words',
		results: 'Search results',
		none: 'No text matches.',
		screens: 'Screens and widgets',
		navSearch: 'Search screens',
		count: '{count} texts',
		countOne: '1 text',
		changed: '{count} changed',
		where: 'Shown in {where}',
	}),
	connections: Object.freeze({
		neededBy: 'Needed by: {features}',
		connected: 'Connected',
		not_connected: 'Not connected',
		test_failed: 'Test failed',
		value: 'New value',
		neededByNone: 'Optional',
		save: 'Save and test',
		test: 'Test',
		more: 'More actions for {name}',
		remove: 'Remove',
		removeTitle: 'Remove {name}?',
		removeHelp: 'The saved value is deleted here. The features that need it stop working until it is connected again.',
		/** What a connection the Portal owns says instead of a form: the database, the storage, the AI provider key and the links to other products. */
		managed: Object.freeze({
			database: 'The database is entered once for all your products, in the Portal. This product uses its own database in it.',
			storage:
				'The storage is entered once for all your products, in the Portal. This product keeps its files in its own folder.',
			secret:
				'The AI provider key is entered once for all your products, in the Portal. Every product that uses AI takes it from there.',
			link: 'The Portal links your products by itself. Nothing is pasted here; a link ends when a product leaves the website.',
			open: 'Open it in the Portal',
			notLinked: 'Not linked yet.',
		}),
	}),
	developers: Object.freeze({
		docs: 'Feature docs',
		docsHelp: 'The docs of every feature. Features that are off are marked.',
		more: 'More',
		search: 'Find a feature',
		openDocs: 'Open the docs',
		script: 'Widget script',
		scriptHelp: 'Add it to the pages that show the widgets; your browser token is in the Portal.',
		off: 'off',
		none: 'No feature matches.',
		columns: Object.freeze({ on: 'On', off: 'Off' }),
		/** The chips of the list: the website's connections, and the developer parts. */
		groups: Object.freeze({ connections: 'Connections', developer: 'Developer' }),
	}),
	defaults: Object.freeze({
		intro: 'Global defaults apply to every website that has not saved its own value.',
		settings: 'Feature settings',
		texts: 'Widget texts',
		changes: 'Recent changes',
		navSearch: 'Search defaults',
	}),
	prices: Object.freeze({
		intro: 'One hourly price per feature, in credits, for every merchant and website.',
		perHour: 'Credits per hour',
		hourly: 'Hourly prices',
		security: 'Security',
		changes: 'Recent changes',
		unsaved: 'You have unsaved prices',
	}),
	reseal: Object.freeze({
		title: 'Encryption key',
		intro: 'After ENCRYPTION_KEY is changed, with the old key set as ENCRYPTION_KEY_PREVIOUS, seal every stored secret again with the new key. Pressing again is safe.',
		button: 'Re-seal stored secrets',
		result: '{resealed} re-sealed, {current} already on the current key, {unreadable} could not be opened with either key.',
		finished: 'Every stored secret now uses the current key: ENCRYPTION_KEY_PREVIOUS can be removed.',
		unreadable:
			'Keep ENCRYPTION_KEY_PREVIOUS and check that it is the old key. Then enter these again and press Re-seal again: {parts}. Remove ENCRYPTION_KEY_PREVIOUS only when "could not be opened" is 0.',
		parts: Object.freeze({
			connections: '{count} secrets in Connections (type them again on each website)',
			keys: '{count} signing keys (press Reconnect for this product in the Portal)',
			product: '{count} of the product’s own stored secrets (set them up again where the product asks for them)',
		}),
		again: '{failed} websites could not be reached: press again later, and keep ENCRYPTION_KEY_PREVIOUS until none is left.',
	}),
});

/**
 * Fill `{name}` placeholders (unknown names stay).
 * @param {string} text
 * @param {Record<string, string | number>} values
 */
const fillWords = (text, values) =>
	text.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(values, name) ? String(values[name]) : match));

/**
 * What the Owner does after a Re-seal: press again for websites not reached; keep ENCRYPTION_KEY_PREVIOUS and enter
 * again what could not be opened, part by part; only when neither is left may it be removed.
 * @param {{ finished: string, again: string, unreadable: string,
 *   parts: Readonly<Record<'connections' | 'keys' | 'product', string>> }} words
 * @param {{ unreadable: number, failedWebsites: string[], unreadableIn?: Partial<Record<'connections' | 'keys' | 'product', number>> }} done
 * @returns {string}
 */
export const resealAdvice = (words, done) => {
	if (done.failedWebsites.length > 0) return fillWords(words.again, { failed: done.failedWebsites.length });
	if (done.unreadable === 0) return words.finished;
	const parts = Object.entries(done.unreadableIn ?? {})
		.filter(([, count]) => (count ?? 0) > 0)
		.map(([part, count]) =>
			fillWords(words.parts[/** @type {'connections' | 'keys' | 'product'} */ (part)], { count: count ?? 0 }),
		);
	return fillWords(words.unreadable, { parts: parts.join('; ') });
};

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
