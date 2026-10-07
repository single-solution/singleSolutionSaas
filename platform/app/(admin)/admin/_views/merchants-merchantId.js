import { loadMerchant } from '../../../../src/console/admin/loaders.js';
import { MerchantView } from '../../../../src/console/admin/views/merchants.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Merchant' };

/** @param {{ params: Promise<{ merchantId: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function MerchantPage({ params, searchParams }) {
	const { merchantId } = await params;
	const q = await searchParams;
	const tab = one(q.tab);
	const { api, admin } = await adminContext(`/admin/merchants/${merchantId}`);
	return (
		<MerchantView
			{...await loadMerchant(api, merchantId)}
			admin={admin}
			tab={tab === 'credits' || tab === 'details' || tab === 'activity' ? tab : 'websites'}
		/>
	);
}
