/**
 * Ecommerce feature categories (PLAN E: capability grain).
 * @module
 */

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
export const CATEGORIES = Object.freeze([
	{ title: 'Catalog', features: ['catalog', 'digital_goods', 'bookings'] },
	{ title: 'Orders', features: ['checkout', 'delivery_zones', 'taxes', 'returns', 'invoices'] },
	{ title: 'Offers', features: ['coupons', 'deals', 'loyalty', 'bundles'] },
	{ title: 'Shopper', features: ['reviews'] },
	{ title: 'Growth', features: ['seo', 'feeds', 'ai_copy', 'reports', 'import'] },
]);
