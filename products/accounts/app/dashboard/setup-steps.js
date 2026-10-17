/**
 * What an Accounts website still has to set, as the setup checklist of the Overview (owner 2026-10-17): the settings
 * the switched-on features need, each with one plain line on why and a button to the exact section of Settings. The
 * keys of Google, Apple and Facebook, and the database, come from the manifest's `neededBy`, so none is listed here.
 * @module
 */

/** @typedef {import('@ss/ui/dashboard').SetupRequirement} SetupRequirement */

/** @type {ReadonlyArray<SetupRequirement>} */
export const SETUP = Object.freeze([
	{
		key: 'sign-in',
		oneOf: ['phone_code', 'phone_password', 'email_password', 'email_code', 'google', 'apple', 'facebook'],
		label: 'Switch on a way to sign in',
		why: 'Visitors cannot sign in or sign up until at least one way is on.',
		action: 'See features',
	},
	{
		key: 'invite-page',
		when: ['approval'],
		setting: 'approval.invitePageUrl',
		optional: true,
		label: 'Set the invite page address',
		why: 'Invites link to this page of your website. It needs the sign-in widget.',
		action: 'Set address',
		detail: (/** @type {unknown} */ value) => String(value ?? ''),
	},
	{
		key: 'setup-page',
		when: ['staff_links'],
		setting: 'staff_links.setupPageUrl',
		label: 'Set the setup page address',
		why: 'Setup links for your staff open this page of your website.',
		action: 'Set address',
		detail: (/** @type {unknown} */ value) => String(value ?? ''),
	},
]);
