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

export default function Dashboard() {
	return <ProductDashboard manifest={manifest} texts={TEXTS} tabs={TABS} />;
}
