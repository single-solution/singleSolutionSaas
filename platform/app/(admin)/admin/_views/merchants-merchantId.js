import { loadMerchant, loadMerchants } from '../../../../src/console/admin/loaders.js';
import { MerchantsView } from '../../../../src/console/admin/views/merchants.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Merchants' };

/** The Merchants screen with a merchant selected: its list (filtered as before) beside the merchant. */
/** @param {{ params: Promise<{ merchantId: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function MerchantPage({ params, searchParams }) {
	const { merchantId } = await params;
	const q = await searchParams;
	const { api, admin } = await adminContext(`/admin/merchants/${merchantId}`);
	const [list, detail] = await Promise.all([
		loadMerchants(api, { status: one(q.status), q: one(q.q), cursor: one(q.cursor) }),
		loadMerchant(api, merchantId, admin),
	]);
	return <MerchantsView {...list} detail={detail} selectedId={merchantId} admin={admin} />;
}
