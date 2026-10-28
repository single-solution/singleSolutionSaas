/**
 * Notifications feature categories (PLAN E: capability grain).
 * @module
 */

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
export const CATEGORIES = Object.freeze([
	{ title: 'Channels', features: ['email', 'sms', 'whatsapp', 'push'] },
	{ title: 'Delivery', features: ['webhooks', 'send_api'] },
]);
