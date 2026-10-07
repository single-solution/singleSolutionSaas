import { loadMyAccount } from '../../../../src/console/admin/loaders.js';
import { MyAccountView } from '../../../../src/console/admin/views/account.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'My account' };

export default async function MyAccountPage() {
	const { api } = await adminContext('/admin/account');
	return <MyAccountView {...await loadMyAccount(api)} />;
}
