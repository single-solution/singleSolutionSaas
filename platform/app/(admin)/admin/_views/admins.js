import { loadAdmins } from '../../../../src/console/admin/loaders.js';
import { AdminsView } from '../../../../src/console/admin/views/admins.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Admins' };

export default async function AdminsPage() {
	const { api, admin } = await adminContext('/admin/admins');
	return <AdminsView {...await loadAdmins(api, admin)} />;
}
