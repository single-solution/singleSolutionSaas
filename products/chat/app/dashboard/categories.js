/**
 * Chat's feature categories for the Features and Settings sidebars, the most used first.
 * @module
 */

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
export const CATEGORIES = Object.freeze([
	{
		title: 'Chat widget',
		features: ['visitor_chat', 'guest_chat', 'signed_in_chat', 'attachments', 'typing_receipts', 'ratings', 'transcripts'],
	},
	{
		title: 'Inbox and team',
		features: [
			'inbox',
			'handoff',
			'assignment',
			'presence_queue',
			'saved_replies',
			'internal_notes',
			'context_panel',
			'ai_summary',
			'staff_alerts',
			'visitor_alerts',
		],
	},
	{
		title: 'AI assistant',
		features: [
			'ai_replies',
			'ai_instructions',
			'fallback_answers',
			'ai_backup',
			'language_lock',
			'ai_caps',
			'ai_cost_alerts',
			'shop_context',
		],
	},
	{ title: 'AI knowledge', features: ['knowledge_base', 'knowledge_pages', 'knowledge_editor'] },
	{
		title: 'AI tools',
		features: [
			'webhook_tools',
			'book_slot',
			'shop_search',
			'shop_deals',
			'shop_top',
			'shop_my_orders',
			'track_shipment',
			'product_cards',
		],
	},
	{
		title: 'Proactive and leads',
		features: ['proactive_idle', 'proactive_pages', 'proactive_exit', 'leads_flows', 'custom_fields'],
	},
	{ title: 'Safety and records', features: ['moderation', 'reports', 'import'] },
]);
