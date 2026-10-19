import { loadMerchant } from '../../../../src/console/admin/loaders.js';
import { MerchantsView } from '../../../../src/console/admin/views/merchants.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Website' };

/** A website of a merchant: its own page, with the website card. */
/** @param {{ params: Promise<{ merchantId: string, websiteId: string }> }} props */
export default async function MerchantWebsitePage({ params }) {
	const { merchantId, websiteId } = await params;
	const { api, admin } = await adminContext(`/admin/merchants/${merchantId}/websites/${websiteId}`);
	return <MerchantsView detail={await loadMerchant(api, merchantId, admin)} websiteId={websiteId} admin={admin} />;
}
