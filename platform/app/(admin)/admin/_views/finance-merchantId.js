import { loadLedger } from '../../../../src/console/admin/loaders.js';
import { LedgerView } from '../../../../src/console/admin/views/finance.js';
import { staffContext } from '../../_lib/server.js';

export const metadata = { title: 'Ledger' };

/** @param {{ params: Promise<{ merchantId: string }> }} props */
export default async function LedgerPage({ params }) {
	const { merchantId } = await params;
	const { api, staff } = await staffContext(`/admin/finance/${merchantId}`);
	return <LedgerView {...await loadLedger(api, merchantId)} staff={staff} />;
}
