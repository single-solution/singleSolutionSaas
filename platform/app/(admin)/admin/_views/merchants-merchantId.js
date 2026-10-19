import { loadMerchant } from '../../../../src/console/admin/loaders.js';
import { MerchantsView } from '../../../../src/console/admin/views/merchants.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Merchant' };

/** A merchant's page, on its Websites part. */
/** @param {{ params: Promise<{ merchantId: string }> }} props */
export default async function MerchantPage({ params }) {
	const { merchantId } = await params;
	const { api, admin } = await adminContext(`/admin/merchants/${merchantId}`);
	return <MerchantsView detail={await loadMerchant(api, merchantId, admin)} section="websites" admin={admin} />;
}
