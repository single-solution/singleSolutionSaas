'use client';
/**
 * The website page seen by an admin (PLAN 0.8.2), opened from the merchant page's Websites tab: Owner and Support add
 * and remove products and the website, see Install and tokens and open product dashboards (admin view for this
 * website); Finance sees the products and the usage only.
 * @module
 */
import { ADMIN } from '../../../texts/console.js';
import { api } from '../../paths.js';
import { WebsitePage } from '../../views/website.js';
import { adminFetch } from '../client.js';
import { adminRoutes } from '../paths.js';
import { AdminProblem, adminCan } from './common.js';

/**
 * @param {any} props loader result of `loadWebsite` (admin) plus `admin`
 */
export function AdminWebsiteView(props) {
	if (!props.ok) return <AdminProblem problem={props.problem} />;
	const { admin } = props;
	const merchantId = String(props.website.merchantId);
	const websiteId = String(props.website.websiteId);
	return (
		<WebsitePage
			website={props.website}
			merchantName={props.merchantName}
			siblings={props.websites}
			cards={props.cards}
			tokens={props.tokens}
			tokensProblem={props.tokensProblem}
			usage={props.usage}
			usageProblem={props.usageProblem}
			tab={props.tab}
			addable={props.addable}
			can={{
				manage: adminCan(admin, 'products_on_websites.write'),
				removeWebsite: adminCan(admin, 'websites.write'),
				tokens: adminCan(admin, 'tokens.manage'),
				open: adminCan(admin, 'dashboards.open'),
			}}
			fetcher={adminFetch}
			links={{
				website: (id) => adminRoutes.website(merchantId, id),
				back: { href: adminRoutes.merchant(merchantId), label: props.merchantName || ADMIN.merchantsTitle },
			}}
			launch={(productId) => ({ path: api.adminLaunch(productId), body: { websiteId } })}
		/>
	);
}
