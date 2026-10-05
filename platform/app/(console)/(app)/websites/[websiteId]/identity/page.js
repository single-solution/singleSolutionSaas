import { loadIdentity } from '../../../../../../src/console/loaders.js';
import { IdentityView } from '../../../../../../src/console/views/identity.js';
import { merchantContext } from '../../../../_lib/server.js';

export const metadata = { title: 'Identity' };

/** @param {{ params: Promise<{ websiteId: string }> }} props */
export default async function IdentityPage({ params }) {
	const { websiteId } = await params;
	const { api, merchantId } = await merchantContext(`/websites/${websiteId}/identity`);
	return <IdentityView {...await loadIdentity(api, merchantId, websiteId)} />;
}
