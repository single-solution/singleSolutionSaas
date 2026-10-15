'use client';
/**
 * The product dashboard (PLAN 0.4.3): the shared dashboard of every product (`@ss/ui/dashboard`), opened from the
 * Portal (`/sso` → `/dashboard?websiteId=…`), with Notifications' own parts in its tabs (`tabs.js`): the templates and
 * webhook URLs in the Overview and Settings, the provider forms of Connections, and the developer sections. Setup only:
 * it calls the kit's dashboard API and shows no business data.
 * @module
 */
import { ProductDashboard } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { TABS } from './tabs.js';
import { TEXTS } from './texts.js';

export default function Dashboard() {
	return <ProductDashboard manifest={manifest} texts={TEXTS} tabs={TABS} />;
}
