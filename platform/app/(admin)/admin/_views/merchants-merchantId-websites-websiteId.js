import { loadWebsite } from '../../../../src/console/admin/loaders.js';
import { AdminWebsiteView } from '../../../../src/console/admin/views/website.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Website' };

/**
 * @param {{ params: Promise<{ merchantId: string, websiteId: string }>,
 *   searchParams: Promise<Record<string, string | string[] | undefined>> }} props
 */
export default async function WebsitePage({ params, searchParams }) {
	const { merchantId, websiteId } = await params;
	const q = await searchParams;
	const { api, admin } = await adminContext(`/admin/merchants/${merchantId}/websites/${websiteId}`);
	return <AdminWebsiteView {...await loadWebsite(api, { merchantId, websiteId, tab: one(q.tab), admin })} admin={admin} />;
}
