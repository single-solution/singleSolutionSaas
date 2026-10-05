import { redirect } from 'next/navigation';
import { AdminShell } from '../../../../src/console/admin/views/shell.js';
import { staffSession } from '../../_lib/server.js';

export const metadata = {
	title: { default: 'Admin', template: '%s · Admin · Single Solution' },
	robots: { index: false, follow: false },
};

/** @param {{ children: import('react').ReactNode }} props */
export default async function AdminLayout({ children }) {
	const session = await staffSession();
	if (!session.ok) {
		if (session.status === 401) redirect('/admin/login');
		throw new Error(session.problem?.detail ?? 'The admin console is unavailable.');
	}
	return <AdminShell staff={session.staff}>{children}</AdminShell>;
}
