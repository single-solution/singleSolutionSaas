import { loadWebsite } from '../../../src/console/loaders.js';
import { WebsiteView } from '../../../src/console/views/websites.js';
import { merchantContext, one } from '../_lib/server.js';

export const metadata = { title: 'Website' };

/**
 * @param {{ params: Promise<{ websiteId: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props
 */
export default async function WebsitePage({ params, searchParams }) {
	const { websiteId } = await params;
	const q = await searchParams;
	const { api, merchantId } = await merchantContext(`/websites/${websiteId}`);
	return <WebsiteView {...await loadWebsite(api, merchantId, websiteId, one(q.tab))} />;
}
