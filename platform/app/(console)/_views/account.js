import { loadAccount } from '../../../src/console/loaders.js';
import { AccountView } from '../../../src/console/views/account.js';
import { merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Account' };

export default async function AccountPage() {
	const { api, merchantId } = await merchantContext('/account');
	return <AccountView {...await loadAccount(api, merchantId)} />;
}
