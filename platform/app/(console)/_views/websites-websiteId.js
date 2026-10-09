import { loadWebsites } from '../../../src/console/loaders.js';
import { WebsitesView } from '../../../src/console/views/websites.js';
import { consoleBranding, merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Websites' };

/** The Websites screen with a website selected. */
/** @param {{ params: Promise<{ websiteId: string }> }} props */
export default async function WebsitePage({ params }) {
	const { websiteId } = await params;
	const { api, merchantId } = await merchantContext(`/websites/${websiteId}`);
	const websites = await loadWebsites(api, merchantId, websiteId);
	// the support contact shows only in the welcome of a merchant with no websites yet
	const welcome = websites.ok && websites.rows.length === 0;
	return <WebsitesView {...websites} branding={welcome ? await consoleBranding() : undefined} />;
}
