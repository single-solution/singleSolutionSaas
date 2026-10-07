import { redirect } from 'next/navigation';
import { AdminShell } from '../../../src/console/admin/views/shell.js';
import { adminBranding, adminSession } from './server.js';

/**
 * The signed-in admin shell around a view: signed-out visitors go to /login, merchants to their console.
 * @param {{ children: import('react').ReactNode }} props
 */
export async function AdminFrame({ children }) {
	const session = await adminSession();
	if (!session.ok) {
		if (session.status === 401) redirect('/login');
		if (/** @type {{ merchant?: boolean }} */ (session).merchant) redirect('/overview');
		throw new Error(session.problem?.detail ?? 'The admin console is unavailable.');
	}
	return (
		<AdminShell admin={session.admin} twoStepRequired={session.twoStepRequired} branding={await adminBranding()}>
			{children}
		</AdminShell>
	);
}
