import { redirect } from 'next/navigation';
import { AdminShell } from '../../../src/console/admin/views/shell.js';
import { staffSession } from './server.js';

/**
 * The signed-in admin shell around a view (formerly the admin (app) layout): signed-out staff go to /admin/login.
 * @param {{ children: import('react').ReactNode }} props
 */
export async function AdminFrame({ children }) {
	const session = await staffSession();
	if (!session.ok) {
		if (session.status === 401) redirect('/admin/login');
		throw new Error(session.problem?.detail ?? 'The admin console is unavailable.');
	}
	return <AdminShell staff={session.staff}>{children}</AdminShell>;
}
