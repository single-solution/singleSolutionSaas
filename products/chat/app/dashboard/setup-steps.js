/**
 * What a Chat website still has to set, as the setup checklist of the Overview (owner 2026-10-17): the settings the
 * switched-on features need, each with one plain line on why and a button to the exact section of Settings. The AI
 * provider, Storage and the tokens of the other products come from the manifest's `neededBy`, so none is listed here.
 * @module
 */
import { isFilled } from '@ss/ui/dashboard';

/** @typedef {import('@ss/ui/dashboard').SetupRequirement} SetupRequirement */

/** @type {ReadonlyArray<SetupRequirement>} */
export const SETUP = Object.freeze([
	{
		key: 'instructions',
		when: ['ai_instructions'],
		setting: 'ai_instructions.instructions',
		label: 'Tell the AI about your business',
		why: 'Every answer follows what you write: what you sell, how it should sound and what it must never say.',
		action: 'Write it',
	},
	{
		key: 'booking',
		when: ['book_slot'],
		setting: 'book_slot.bookingUrl',
		label: 'Set the booking address',
		why: 'The AI cannot offer or book times until it knows the address on your server that gives free times.',
		action: 'Set address',
	},
	{
		key: 'sign-in-page',
		when: ['signed_in_chat'],
		setting: 'signed_in_chat.signInUrl',
		label: 'Set the sign-in page address',
		why: 'Visitors who must sign in to continue are sent to this page of your website.',
		action: 'Set address',
	},
	{
		key: 'alert-people',
		when: ['staff_alerts'],
		setting: 'staff_alerts.recipients',
		done: (/** @type {unknown} */ value, /** @type {{ values: Record<string, unknown> }} */ { values }) =>
			isFilled(value) || isFilled(values.staffPermission),
		label: 'Choose who gets staff alerts',
		why: 'Alerts about new chats reach nobody until you list people, or let your staff with a role receive them.',
		action: 'Add people',
	},
	{
		key: 'alert-page',
		when: ['staff_alerts'],
		setting: 'staff_alerts.adminUrl',
		label: 'Set the conversation page address',
		why: 'Alerts link staff to this page of your admin, where they open the chat and reply.',
		action: 'Set address',
	},
]);
