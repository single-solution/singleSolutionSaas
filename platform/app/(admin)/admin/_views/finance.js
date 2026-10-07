import { loadFinance } from '../../../../src/console/admin/loaders.js';
import { FinanceView } from '../../../../src/console/admin/views/finance.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Finance' };

export default async function FinancePage() {
	const { api, admin } = await adminContext('/admin/finance');
	return <FinanceView {...await loadFinance(api)} admin={admin} />;
}
