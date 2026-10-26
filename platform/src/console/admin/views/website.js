'use client';
/**
 * A merchant's website in the Admin Console: the shared website page (`views/website-page.js`) under the breadcrumbs
 * `Merchants › name › domain`, with the rights this admin has (add and remove products, remove the website, tokens and
 * the Setup sheet, open the dashboards, read the Website settings; Owner and Support switch recommended features on).
 * The Portal checks every right again.
 * @module
 */
import { Page } from '@ss/ui';
import { ADMIN } from '../../../texts/console.js';
import { Link } from '../../link.js';
import { api } from '../../paths.js';
import { WebsitePageView } from '../../views/website-page.js';
import { adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';

/** How a website's worst product status reads in the tables and the header. */
export const SITE_PILLS = /** @type {const} */ ({
	success: { status: 'active', label: ADMIN.status.active },
	warning: { status: 'warning', label: ADMIN.status.grace },
	danger: { status: 'error', label: ADMIN.status.stopped },
	neutral: { status: 'off', label: ADMIN.noFeaturesOn },
});

/**
 * The website page of the Admin Console.
 * @param {{ detail: any, admin: any }} props `detail` is the result of `loadAdminWebsite`
 */
export function AdminWebsiteView({ detail, admin }) {
	if (!detail.ok) return <AdminProblem problem={detail.problem} />;
	const merchantId = String(detail.merchant.merchantId);
	const websiteId = String(detail.websiteId);
	const rows = /** @type {Array<{ website: any, cards: any[] }>} */ (detail.rows);
	const selected = rows.find((r) => String(r.website.websiteId) === websiteId) ?? null;
	const crumbs = [
		{ label: ADMIN.merchantsTitle, href: adminRoutes.merchants() },
		{ label: String(detail.merchant.name), href: adminRoutes.merchant(merchantId) },
	];
	if (!selected) return <Page linkAs={Link} crumbs={[...crumbs, { label: websiteId }]} error={ADMIN.noSuchWebsite} />;
	const can = (/** @type {string} */ p) => adminCan(admin, p);
	return (
		<WebsitePageView
			key={websiteId}
			website={selected.website}
			cards={selected.cards}
			part={detail.part}
			crumbs={crumbs}
			hrefOf={(part) => adminRoutes.websitePart(merchantId, websiteId, part)}
			can={{
				manage: can('products_on_websites.write'),
				removeWebsite: can('websites.write'),
				tokens: can('tokens.manage'),
				open: can('dashboards.open'),
				settings: can('website_settings.read'),
			}}
			pills={SITE_PILLS}
			addable={detail.addable}
			launch={(productId) => ({ path: api.adminLaunch(productId), body: { websiteId } })}
			afterRemoved={adminRoutes.merchant(merchantId)}
			settings={detail.settings}
			setup={detail.setup}
			canSwitch
			twoStepOn={Boolean(admin?.twoStep?.enabled)}
		/>
	);
}
