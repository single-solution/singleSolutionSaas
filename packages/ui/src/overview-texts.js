/**
 * The words of a product dashboard's Overview (PLAN 0.6 "Overviews talk"; US English, kept in this file; the
 * dashboards are not translated): the greeting, the one sentence of what matters now, the kit's "Needs you" items and
 * setup steps, the numbers and Recent changes. `{name}` placeholders are filled by `ProductOverview`; a product's own
 * items carry their own words (its `app/dashboard/texts.js`).
 * @module
 */
export const OVERVIEW_TEXTS = Object.freeze({
	title: 'Overview',
	welcome: 'Welcome back, {name}',
	/** The one sentence under the greeting: nothing needs the viewer, or the most urgent item and how many more. */
	allSet: 'Everything on {domain} is ready, and nothing needs you right now.',
	only: '{first}.',
	oneMore: '{first}, and one more thing needs you.',
	more: '{first}, and {count} more things need you.',
	status: Object.freeze({
		active: 'Active',
		grace: 'In grace',
		stopped: 'Stopped',
		suspended: 'Suspended',
		removed: 'Removed',
	}),
	needs: Object.freeze({
		title: 'Needs you',
		intro: 'Each item says what happens if it waits.',
		none: 'Nothing needs you right now.',
		contact: 'Contact support',
		portal: 'Open the Portal',
		grace: Object.freeze({
			title: '{product} is in grace until {time}',
			merchant:
				'Your credits ran out. It keeps working until then, and those hours are charged. Contact {contact} to add credits.',
			admin: 'The merchant’s credits ran out. It keeps working until then, and those hours are charged. Add credits in the Portal.',
		}),
		stopped: Object.freeze({
			title: '{product} is stopped because the credits ran out',
			merchant:
				'Its widgets show nothing and its API refuses calls. It starts again as soon as credits are added: contact {contact}.',
			admin: 'Its widgets show nothing and its API refuses calls. It starts again as soon as credits are added in the Portal.',
		}),
		suspended: Object.freeze({
			title: 'This merchant is suspended',
			effect: 'The widgets show nothing and the API refuses calls until the merchant is resumed in the Portal.',
		}),
		noFeatures: Object.freeze({
			title: 'No features are on yet',
			effect: 'Nothing is charged, and nothing shows on {domain}, until a feature is switched on.',
			action: 'See features',
		}),
		notConnected: Object.freeze({
			title: '{label} is not connected',
			effect: 'Needed by {features}: charged, but not working until it is connected.',
			action: 'Connect',
		}),
		testFailed: Object.freeze({
			title: '{label} failed its last test',
			effect: 'Needed by {features}: charged, but not working until it passes.',
			action: 'Fix it',
		}),
		widget: Object.freeze({
			title: 'The widget has not been seen on {domain}',
			effect: 'Visitors see nothing until the widget script is on your pages. It counts as installed once seen within 7 days.',
			action: 'Get the script',
		}),
		website: Object.freeze({
			title: 'Needs setup: set your website settings in the Portal',
			effect:
				'Your business facts, look, region and Format are set once for all your products. Until then the business name shows as {domain}, times use UTC and the widgets use the built-in look.',
			action: 'Open Website settings',
			recheck: 'Check again',
			missingTitle: 'Needs setup: set {fields} in the Portal',
			missingEffect: '{product} needs {fields}. Set them once in Website settings › {section}, for all your products.',
		}),
	}),
	setup: Object.freeze({
		title: 'Setup',
		progress: '{done} of {total} done',
		done: 'Done',
		todo: 'To do',
		review: 'Review',
		optional: 'Optional',
		features: 'Switch on a feature',
		featuresWhy: 'Nothing shows on {domain}, and nothing is charged, until a feature is on.',
		featuresAction: 'See features',
		connection: 'Connect {label}',
		connectionWhy: 'Needed by {features}.',
		connectionAction: 'Connect',
		connectionFix: 'Fix it',
		widget: 'Put the widget on your pages',
		widgetWhy: 'Visitors see nothing until the widget script is on your pages.',
		widgetAction: 'Get the script',
		widgetSeen: 'Last seen {time}',
		website: 'Set your website settings in the Portal',
		websiteWhy: 'Your business facts, look, region and Format are set once for all your products. Until then times use UTC.',
		websiteSection: 'Set {fields} in Website settings › {section}',
		websiteSectionWhy: '{product} needs {fields}.',
		websiteAction: 'Open in the Portal',
		websiteSet: 'Your website settings are set',
	}),
	numbers: 'Key numbers',
	today: 'Today’s cost',
	todayHint: 'So far today (UTC)',
	features: 'Features on',
	noFeatures: 'None yet',
	changes: 'Recent changes',
	changesIntro: 'Every change made in this dashboard.',
	noChanges: 'No changes yet.',
	changeWho: 'Who',
	changeWhat: 'What',
	changeWhen: 'When',
	showAll: 'Show all {count}',
	showFewer: 'Show fewer',
	loading: 'Loading…',
});
