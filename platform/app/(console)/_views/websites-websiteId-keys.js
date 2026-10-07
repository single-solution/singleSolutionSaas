import { loadKeys } from '../../../src/console/loaders.js';
import { KeysView } from '../../../src/console/views/keys.js';
import { merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Keys' };

/** @param {{ params: Promise<{ websiteId: string }> }} props */
export default async function KeysPage({ params }) {
	const { websiteId } = await params;
	const { api, merchantId } = await merchantContext(`/websites/${websiteId}/keys`);
	return <KeysView {...await loadKeys(api, merchantId, websiteId)} />;
}
