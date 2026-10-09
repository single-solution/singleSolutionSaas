import { loadAdmins } from '../../../../src/console/admin/loaders.js';
import { AdminsView } from '../../../../src/console/admin/views/admins.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Admins' };

/** The Admins screen with an admin selected. */
/** @param {{ params: Promise<{ adminId: string }> }} props */
export default async function AdminPage({ params }) {
	const { adminId } = await params;
	const { api, admin } = await adminContext(`/admin/admins/${adminId}`);
	return <AdminsView {...await loadAdmins(api, admin)} selectedId={adminId} />;
}
