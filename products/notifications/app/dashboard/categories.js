/**
 * Notifications' feature categories for the Features and Settings sidebars, the most used first. A key that is not a
 * feature names a shared settings section (Templates, Delivery log).
 * @module
 */

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
export const CATEGORIES = Object.freeze([
	{ title: 'Channels', features: ['templates', 'email', 'sms', 'whatsapp', 'browser_push', 'staff_push', 'webhooks'] },
	{ title: 'Sending rules', features: ['quiet_hours', 'send_limits', 'fallback', 'delayed_send', 'multi_language', 'send_api'] },
	{ title: 'Records', features: ['delivery_log'] },
]);
