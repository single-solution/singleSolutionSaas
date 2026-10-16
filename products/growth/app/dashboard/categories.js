/**
 * Growth's feature categories for the Features and Settings sidebars, the most used first. A key that is not a feature
 * names a shared settings section (Tags and consent, Pixel events).
 * @module
 */

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
export const CATEGORIES = Object.freeze([
	{
		title: 'Ads and tracking tags',
		features: ['google_tags', 'meta_pixel', 'tiktok_pixel', 'custom_scripts', 'consent_banner', 'tags', 'pixels'],
	},
	{ title: 'Analytics', features: ['visitor_analytics', 'conversion_funnel', 'searches_404s', 'web_vitals'] },
	{ title: 'Search engines', features: ['robots_verification', 'seo_checklist', 'indexnow', 'redirects'] },
	{ title: 'On-site messages', features: ['notice_bar'] },
	{ title: 'Migration', features: ['import'] },
]);
