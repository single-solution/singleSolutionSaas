import { loadResources } from '../../../src/console/loaders.js';
import { ConnectorsView } from '../../../src/console/views/connectors.js';
import { merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Resources' };

/** @param {{ params: Promise<{ websiteId: string }> }} props */
export default async function ResourcesPage({ params }) {
	const { websiteId } = await params;
	const { api, merchantId } = await merchantContext(`/websites/${websiteId}/resources`);
	return <ConnectorsView {...await loadResources(api, merchantId, websiteId)} />;
}
