import { loadMerchant, loadMerchants } from '../../../../src/console/admin/loaders.js';
import { MerchantsView } from '../../../../src/console/admin/views/merchants.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Merchants' };

/** The Merchants screen: list of merchants with the first merchant open beside it on wide screens. */
/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function MerchantsPage({ searchParams }) {
	const q = await searchParams;
	const { api, admin } = await adminContext('/admin/merchants');
	const list = await loadMerchants(api, { status: one(q.status), q: one(q.q), cursor: one(q.cursor) });
	const firstId = list.ok && list.page.items[0]?.merchantId ? String(list.page.items[0].merchantId) : null;
	const detail = firstId ? await loadMerchant(api, firstId, admin) : null;
	return <MerchantsView list={list} detail={detail} fromList admin={admin} />;
}
