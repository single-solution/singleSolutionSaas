import { loadLedger } from '../../../../src/console/admin/loaders.js';
import { LedgerView } from '../../../../src/console/admin/views/finance.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Ledger' };

/** @param {{ params: Promise<{ merchantId: string }> }} props */
export default async function LedgerPage({ params }) {
	const { merchantId } = await params;
	const { api, admin } = await adminContext(`/admin/finance/${merchantId}`);
	return <LedgerView {...await loadLedger(api, merchantId)} admin={admin} />;
}
