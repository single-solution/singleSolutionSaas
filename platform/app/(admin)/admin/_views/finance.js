import { loadBilling } from '../../../../src/console/admin/loaders.js';
import { FinanceView } from '../../../../src/console/admin/views/finance.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Credits and billing' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function FinancePage({ searchParams }) {
	const q = await searchParams;
	const { api, admin } = await adminContext('/admin/finance');
	return (
		<FinanceView
			{...await loadBilling(api, {
				merchantId: one(q.merchantId),
				from: one(q.from),
				to: one(q.to),
				method: one(q.method),
				by: one(q.by),
			})}
			admin={admin}
		/>
	);
}
