/**
 * The words of a product dashboard's Overview (PLAN 0.6 "Overviews talk"; US English, kept in this file; the
 * dashboards are not translated): the greeting, the one sentence of what matters now, the kit's "Needs you" items and
 * setup steps, the numbers and Recent changes. `{name}` placeholders are filled by `ProductOverview`; a product's own
 * items carry their own words (its `app/dashboard/texts.js`).
 * @module
 */
export const OVERVIEW_TEXTS = Object.freeze({
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
		business: Object.freeze({
			title: 'business.json was not found on {domain}',
			effect:
				'Your business name shows as the domain, and times use UTC, until https://{domain}/.well-known/business.json is published.',
			action: 'Check again',
		}),
	}),
	setup: Object.freeze({
		title: 'Setup',
		progress: '{done} of {total} done',
		done: 'Done',
		todo: 'To do',
		features: 'Switch on a feature',
		connection: 'Connect {label}',
		widget: 'Put the widget on your pages',
		widgetSeen: 'Last seen {time}',
		business: 'Publish business.json',
	}),
	numbers: 'Key numbers',
	today: 'Today’s cost',
	todayHint: 'So far today (UTC)',
	features: 'Features on',
	noFeatures: 'None yet',
	changes: 'Recent changes',
	changesIntro: 'Every change made in this dashboard.',
	noChanges: 'No changes yet.',
	showAll: 'Show all {count}',
	showFewer: 'Show fewer',
	loading: 'Loading…',
});
