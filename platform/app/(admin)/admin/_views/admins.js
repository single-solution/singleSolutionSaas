import { loadAdmin, loadAdmins } from '../../../../src/console/admin/loaders.js';
import { AdminsView } from '../../../../src/console/admin/views/admins.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Admins' };

/** The Admins screen: list of admins with the first admin open beside it on wide screens. */
export default async function AdminsPage() {
	const { api, admin } = await adminContext('/admin/admins');
	const list = await loadAdmins(api, admin);
	const firstId = list.ok && list.items?.[0]?.adminId ? String(list.items[0].adminId) : null;
	const detail = firstId ? await loadAdmin(api, admin, firstId) : null;
	return <AdminsView {...list} detail={detail} fromList admin={admin} />;
}
