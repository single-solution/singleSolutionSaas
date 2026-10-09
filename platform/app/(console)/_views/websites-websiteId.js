import { loadWebsites } from '../../../src/console/loaders.js';
import { WebsitesView } from '../../../src/console/views/websites.js';
import { consoleBranding, merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Websites' };

/** The Websites screen with a website selected. */
/** @param {{ params: Promise<{ websiteId: string }> }} props */
export default async function WebsitePage({ params }) {
	const { websiteId } = await params;
	const { api, merchantId } = await merchantContext(`/websites/${websiteId}`);
	return <WebsitesView {...await loadWebsites(api, merchantId, websiteId)} branding={await consoleBranding()} />;
}
