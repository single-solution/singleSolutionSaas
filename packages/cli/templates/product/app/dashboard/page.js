'use client';
/**
 * The product dashboard (PLAN 0.4.3): one page, opened from the Portal (`/sso` → `/dashboard?websiteId=…`), with the
 * left sidebar Overview · Features · Settings · Connections · Developers, plus Defaults and Prices for Owners. The page
 * and its tabs are `@ss/ui/dashboard`'s, the same in every product: a product passes its manifest and its words, and
 * puts its own sections in `tabs` (`{ settings: OwnSettings }`, or a new tab `{ key: { component, icon, kind } }`).
 * @module
 */
import { ProductDashboard } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { TEXTS } from './texts.js';

export default function Dashboard() {
	return <ProductDashboard manifest={manifest} texts={TEXTS} />;
}
