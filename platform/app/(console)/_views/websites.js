import { loadWebsites } from '../../../src/console/loaders.js';
import { WebsitesView } from '../../../src/console/views/websites.js';
import { merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Websites' };

export default async function WebsitesPage() {
	const { api, merchantId } = await merchantContext('/websites');
	return <WebsitesView {...await loadWebsites(api, merchantId)} />;
}
