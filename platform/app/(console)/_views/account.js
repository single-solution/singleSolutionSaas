import { redirect } from 'next/navigation';
import { loadAccount } from '../../../src/console/loaders.js';
import { AccountView } from '../../../src/console/views/account.js';
import { consoleApi, consoleSession } from '../_lib/server.js';

export const metadata = { title: 'Account' };

export default async function AccountPage() {
	const session = await consoleSession();
	if (!session.ok) redirect('/login?next=%2Faccount');
	return <AccountView {...await loadAccount(await consoleApi(), session.merchantId)} />;
}
