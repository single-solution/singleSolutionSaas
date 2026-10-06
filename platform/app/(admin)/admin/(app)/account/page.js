import { AccountView } from '../../../../../src/console/admin/views/account.js';
import { staffContext } from '../../../_lib/server.js';

export const metadata = { title: 'Account settings' };

export default async function AccountPage() {
	const { staff } = await staffContext('/admin/account');
	return <AccountView staff={staff} />;
}
