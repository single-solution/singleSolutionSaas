import { loadWebsiteOverview } from '../../../../../src/console/loaders.js';
import { WebsiteOverviewView } from '../../../../../src/console/views/websites.js';
import { merchantContext } from '../../../_lib/server.js';

export const metadata = { title: 'Website' };

/** @param {{ params: Promise<{ websiteId: string }> }} props */
export default async function WebsitePage({ params }) {
	const { websiteId } = await params;
	const { api, merchantId } = await merchantContext(`/websites/${websiteId}`);
	return <WebsiteOverviewView {...await loadWebsiteOverview(api, merchantId, websiteId)} />;
}
