'use client';
/**
 * The product dashboard (PLAN 0.4.3): the shared dashboard of every product (`@ss/ui/dashboard`), opened from the
 * Portal (`/sso` → `/dashboard?websiteId=…`), with Growth's words and its own parts of the Overview, Settings,
 * Developers and Defaults tabs (`tabs.js`). Setup only: it calls the kit's dashboard API and shows no business data.
 * @module
 */
import { ProductDashboard } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { TABS } from './tabs.js';
import { TEXTS } from './texts.js';

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
const CATEGORIES = Object.freeze([
	{
		title: 'Ads and tracking tags',
		features: ['google_tags', 'meta_pixel', 'tiktok_pixel', 'custom_scripts', 'consent_banner', 'tags', 'pixels'],
	},
	{ title: 'Analytics', features: ['visitor_analytics', 'conversion_funnel', 'searches_404s', 'web_vitals'] },
	{ title: 'Search engines', features: ['robots_verification', 'seo_checklist', 'indexnow', 'redirects'] },
	{ title: 'On-site messages', features: ['notice_bar'] },
	{ title: 'Migration', features: ['import'] },
]);

export default function Dashboard() {
	return <ProductDashboard manifest={manifest} texts={TEXTS} categories={CATEGORIES} tabs={TABS} />;
}
