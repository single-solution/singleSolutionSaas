/**
 * What a Notifications website still has to set, as the setup checklist of the Overview (owner 2026-10-17): the
 * channels and lists the switched-on features need, each with one plain line on why and a button to the exact section.
 * The provider keys (email, SMS, WhatsApp, push, webhook secret) come from the manifest's `neededBy`, so no connection
 * is listed here.
 * @module
 */

/** @typedef {import('@ss/ui/dashboard').SetupRequirement} SetupRequirement */

/** @type {ReadonlyArray<SetupRequirement>} */
export const SETUP = Object.freeze([
	{
		key: 'channel',
		oneOf: ['email', 'sms', 'whatsapp', 'browser_push', 'staff_push'],
		label: 'Switch on a channel',
		why: 'Messages need at least one channel (email, SMS, WhatsApp or push) to go out.',
		action: 'See features',
	},
	{
		key: 'webhook-address',
		when: ['webhooks'],
		list: 'webhook_urls',
		label: 'Add a webhook address',
		why: 'Outgoing webhooks send nothing until at least one address on your server is added.',
		action: 'Add address',
		section: 'webhooks',
	},
]);
