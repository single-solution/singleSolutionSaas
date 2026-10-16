/**
 * Accounts' feature categories for the Features and Settings sidebars, the most used first. A key that is not a feature
 * names a shared settings section (Passwords, Phone numbers and codes, Profile).
 * @module
 */

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
export const CATEGORIES = Object.freeze([
	{
		title: 'Sign-in methods',
		features: [
			'email_password',
			'phone_password',
			'email_code',
			'phone_code',
			'google',
			'apple',
			'facebook',
			'passwords',
			'phone',
		],
	},
	{ title: 'Sign-up and access', features: ['approval', 'roles', 'role_requests', 'two_step', 'risk_checks'] },
	{ title: 'Profiles and privacy', features: ['custom_fields', 'profile', 'consents', 'data_rights'] },
	{ title: 'Staff and connections', features: ['staff_links', 'orders_tab', 'activity_copies'] },
	{ title: 'Migration', features: ['import'] },
]);
