import { loadFinance } from '../../../../src/console/admin/loaders.js';
import { FinanceView } from '../../../../src/console/admin/views/finance.js';
import { staffContext } from '../../_lib/server.js';

export const metadata = { title: 'Finance' };

export default async function FinancePage() {
	const { api, staff } = await staffContext('/admin/finance');
	return <FinanceView {...await loadFinance(api)} staff={staff} />;
}
