/**
 * Ecommerce's feature categories for the Features and Settings sidebars, the most used first.
 * @module
 */

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
export const CATEGORIES = Object.freeze([
	{
		title: 'Products',
		features: [
			'catalog',
			'variants',
			'size_charts',
			'multi_location',
			'grades_serials',
			'digital_goods',
			'bookings',
			'measured_sales',
		],
	},
	{
		title: 'Orders and checkout',
		features: ['checkout', 'delivery_zones', 'courier_apis', 'taxes', 'invoices', 'returns'],
	},
	{ title: 'Offers and pricing', features: ['coupons', 'deals', 'bundles', 'loyalty', 'role_pricing'] },
	{ title: 'Shopper features', features: ['reviews', 'wishlist', 'alerts', 'compare'] },
	{ title: 'Search and SEO', features: ['seo', 'landing_pages', 'feeds', 'llms_txt', 'ai_copy'] },
	{ title: 'Admin tools', features: ['staff_alerts', 'reports', 'events', 'csv', 'bulk_actions', 'import'] },
]);
