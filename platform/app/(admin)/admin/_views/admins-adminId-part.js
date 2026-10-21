import { notFound, redirect } from 'next/navigation';
import { ADMIN_PARTS } from '../../../../src/console/admin/paths.js';

export const metadata = { title: 'Admin' };

/** A part of an admin's page: `/admin/admins/:adminId/:part` redirects to `/admin/admins/:adminId#${part}`. */
/** @param {{ params: Promise<{ adminId: string, part: string }> }} props */
export default async function AdminPartPage({ params }) {
	const { adminId, part } = await params;
	if (!ADMIN_PARTS.includes(part)) notFound();
	redirect(`/admin/admins/${adminId}#${part}`);
}
