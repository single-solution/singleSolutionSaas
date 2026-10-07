import { redirect } from 'next/navigation';
import { adminRoutes } from '../../../../src/console/admin/paths.js';

export const metadata = { title: 'Merchants' };

/** The admin home is the merchants list. */
export default function AdminHome() {
	redirect(adminRoutes.merchants());
}
