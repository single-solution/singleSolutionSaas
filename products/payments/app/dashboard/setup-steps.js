/**
 * What a Payments website still has to set, as the setup checklist of the Overview (owner 2026-10-17): a way to take
 * payments, and the manual payment methods payers can see. Each gateway's keys come from the manifest's `neededBy`, so
 * no connection is listed here.
 * @module
 */

/** @typedef {import('@ss/ui/dashboard').SetupRequirement} SetupRequirement */

/** @type {ReadonlyArray<SetupRequirement>} */
export const SETUP = Object.freeze([
	{
		key: 'way-to-pay',
		oneOf: [
			'stripe',
			'paypal',
			'payfast',
			'payfast_pk',
			'jazzcash',
			'easypaisa',
			'rapid',
			'generic_gateway',
			'manual_payments',
		],
		label: 'Switch on a way to take payments',
		why: 'Payers have nothing to pay with until a payment gateway or a manual method is on.',
		action: 'See features',
	},
]);
