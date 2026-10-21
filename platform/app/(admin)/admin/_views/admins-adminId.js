import { loadAdmin } from '../../../../src/console/admin/loaders.js';
import { AdminsView } from '../../../../src/console/admin/views/admins.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Admin' };

/** An admin's page beside the list of admins. */
/** @param {{ params: Promise<{ adminId: string }> }} props */
export default async function AdminPage({ params }) {
	const { adminId } = await params;
	const { api, admin } = await adminContext(`/admin/admins/${adminId}`);
	return <AdminsView {...await loadAdmin(api, admin, adminId)} selectedId={adminId} admin={admin} />;
}
