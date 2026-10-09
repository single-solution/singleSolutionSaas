import { loadMerchantsScreen } from '../../../../src/console/admin/loaders.js';
import { MerchantsView } from '../../../../src/console/admin/views/merchants.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Merchants' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function MerchantsPage({ searchParams }) {
	const q = await searchParams;
	const { api, admin } = await adminContext('/admin/merchants');
	return (
		<MerchantsView
			{...await loadMerchantsScreen(api, { status: one(q.status), q: one(q.q), cursor: one(q.cursor) }, admin)}
			admin={admin}
		/>
	);
}
