/**
 * Payments' feature categories for the Features and Settings sidebars, the most used first.
 * @module
 */

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
export const CATEGORIES = Object.freeze([
	{
		title: 'Ways to pay',
		features: [
			'manual_payments',
			'stripe',
			'paypal',
			'payfast',
			'payfast_pk',
			'jazzcash',
			'easypaisa',
			'rapid',
			'generic_gateway',
		],
	},
	{ title: 'Selling tools', features: ['payment_links', 'subscriptions', 'refunds', 'payment_api'] },
]);
