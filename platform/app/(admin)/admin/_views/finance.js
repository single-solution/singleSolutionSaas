import { loadBilling } from '../../../../src/console/admin/loaders.js';
import { FinanceView } from '../../../../src/console/admin/views/finance.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Credits and billing' };

/**
 * Credits and billing and its parts (`/admin/finance`, `/admin/finance/receipts`, `/admin/finance/charges`): `part`
 * is the part of the address (Needs attention without one); the filters are in the query.
 * @param {{ part?: string, searchParams: Promise<Record<string, string | string[] | undefined>> }} props
 */
export async function FinanceScreen({ part = 'attention', searchParams }) {
	const q = await searchParams;
	const { api, admin } = await adminContext(part === 'attention' ? '/admin/finance' : `/admin/finance/${part}`);
	return (
		<FinanceView
			{...await loadBilling(api, {
				merchantId: one(q.merchantId),
				from: one(q.from),
				to: one(q.to),
				method: one(q.method),
				by: one(q.by),
			})}
			part={part}
			admin={admin}
		/>
	);
}

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default function FinancePage({ searchParams }) {
	return <FinanceScreen searchParams={searchParams} />;
}
