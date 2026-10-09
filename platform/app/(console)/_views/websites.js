import { loadWebsites } from '../../../src/console/loaders.js';
import { WebsitesView } from '../../../src/console/views/websites.js';
import { consoleBranding, merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Websites' };

export default async function WebsitesPage() {
	const { api, merchantId } = await merchantContext('/websites');
	const websites = await loadWebsites(api, merchantId);
	// the support contact shows only in the welcome of a merchant with no websites yet
	const welcome = websites.ok && websites.rows.length === 0;
	return <WebsitesView {...websites} branding={welcome ? await consoleBranding() : undefined} />;
}
