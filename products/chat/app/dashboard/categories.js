/**
 * Chat's feature categories for the Features and Settings sidebars (PLAN E+F: capability grain).
 * @module
 */

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
export const CATEGORIES = Object.freeze([
	{ title: 'Chat', features: ['visitor_chat'] },
	{ title: 'Inbox and team', features: ['inbox', 'handoff'] },
	{ title: 'AI', features: ['ai_replies', 'knowledge_base', 'webhook_tools', 'book_slot', 'shop_assistant'] },
	{ title: 'Leads', features: ['leads_flows'] },
	{ title: 'Safety and records', features: ['moderation', 'reports', 'import'] },
]);
