import { redirect } from 'next/navigation';
import { loadAdminWebsite } from '../../../../src/console/admin/loaders.js';
import { adminRoutes } from '../../../../src/console/admin/paths.js';
import { AdminWebsiteView } from '../../../../src/console/admin/views/website.js';
import { LEGACY_PEER_REDIRECTS, websitePartOf } from '../../../../src/console/website-parts.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Website' };

/** A website of a merchant: its own page, the Overview or the part named by the next one or two segments. */
/** @param {{ params: Promise<{ merchantId: string, websiteId: string, part?: string, sub?: string }> }} props */
export default async function MerchantWebsitePage({ params }) {
	const { merchantId, websiteId, part, sub } = await params;
	if (part && LEGACY_PEER_REDIRECTS.includes(/** @type {any} */ (part))) {
		redirect(adminRoutes.website(merchantId, websiteId));
	}
	const path = websitePartOf(part, sub);
	const { api, admin } = await adminContext(adminRoutes.websitePart(merchantId, websiteId, path));
	return <AdminWebsiteView detail={await loadAdminWebsite(api, merchantId, websiteId, path, admin)} admin={admin} />;
}
