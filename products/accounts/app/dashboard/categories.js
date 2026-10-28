/**
 * Accounts feature categories (PLAN E: capability grain).
 * @module
 */

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
export const CATEGORIES = Object.freeze([
	{ title: 'Sign-in', features: ['sign_in', 'two_step', 'approval'] },
	{ title: 'People', features: ['roles', 'role_requests', 'activity_copies'] },
	{ title: 'Rights', features: ['consents', 'data_rights', 'import'] },
]);
