import { notFound } from 'next/navigation';
import { loadAdmin } from '../../../../src/console/admin/loaders.js';
import { ADMIN_PARTS } from '../../../../src/console/admin/paths.js';
import { AdminsView } from '../../../../src/console/admin/views/admins.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Admin' };

/** A part of an admin's page: `/admin/admins/:adminId/activity`; any other is a 404. */
/** @param {{ params: Promise<{ adminId: string, part: string }> }} props */
export default async function AdminPartPage({ params }) {
	const { adminId, part } = await params;
	if (!ADMIN_PARTS.includes(part)) notFound();
	const { api, admin } = await adminContext(`/admin/admins/${adminId}/${part}`);
	return <AdminsView {...await loadAdmin(api, admin, adminId, part)} selectedId={adminId} section={part} />;
}
