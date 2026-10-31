'use client';
/**
 * The product dashboard (PLAN 0.4.3): `@ss/ui`'s ProductDashboard, opened from the Portal (`/sso` →
 * `/dashboard?websiteId=…`), with Chat's words and its own parts of the tabs (`tabs.js`). Setup only: it calls the
 * kit's dashboard API and shows no business data (no conversations, no leads).
 * @module
 */
import { ProductDashboard } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { TABS } from './tabs.js';
import { TEXTS } from './texts.js';

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
const CATEGORIES = Object.freeze([
	{ title: 'Chat', features: ['visitor_chat'] },
	{ title: 'Inbox and team', features: ['inbox', 'handoff'] },
	{ title: 'AI', features: ['ai_replies', 'knowledge_base', 'webhook_tools', 'book_slot', 'shop_assistant'] },
	{ title: 'Leads', features: ['leads_flows'] },
	{ title: 'Safety and records', features: ['moderation', 'reports', 'import'] },
]);

export default function Dashboard() {
	return <ProductDashboard manifest={manifest} texts={TEXTS} categories={CATEGORIES} tabs={TABS} />;
}
