'use client';
/**
 * The product dashboard (PLAN 0.4.3): `@ss/ui`'s ProductDashboard, opened from the Portal (`/sso` →
 * `/dashboard?websiteId=…`), with Ecommerce's words and its own parts of the tabs (`tabs.js`). Setup only: it calls
 * the kit's dashboard API and shows no business data (no products, orders or customers).
 * @module
 */
import { ProductDashboard } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { TABS } from './tabs.js';
import { TEXTS } from './texts.js';

/** @type {import('@ss/ui/dashboard').DashboardCategories} */
const CATEGORIES = Object.freeze([
	{ title: 'Catalog', features: ['catalog', 'digital_goods', 'bookings'] },
	{ title: 'Orders', features: ['checkout', 'delivery_zones', 'taxes', 'returns', 'invoices'] },
	{ title: 'Offers', features: ['coupons', 'deals', 'loyalty', 'bundles'] },
	{ title: 'Shopper', features: ['reviews'] },
	{ title: 'Growth', features: ['seo', 'feeds', 'ai_copy', 'reports', 'import'] },
]);

export default function Dashboard() {
	return <ProductDashboard manifest={manifest} texts={TEXTS} categories={CATEGORIES} tabs={TABS} />;
}
