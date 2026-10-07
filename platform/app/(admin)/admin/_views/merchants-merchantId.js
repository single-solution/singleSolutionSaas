import { loadMerchant } from '../../../../src/console/admin/loaders.js';
import { MerchantView } from '../../../../src/console/admin/views/merchants.js';
import { staffContext } from '../../_lib/server.js';

export const metadata = { title: 'Merchant' };

/** @param {{ params: Promise<{ merchantId: string }> }} props */
export default async function MerchantPage({ params }) {
	const { merchantId } = await params;
	const { api, staff } = await staffContext(`/admin/merchants/${merchantId}`);
	return <MerchantView {...await loadMerchant(api, merchantId)} staff={staff} />;
}
