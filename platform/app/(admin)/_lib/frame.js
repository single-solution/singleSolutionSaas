import { AdminShell } from '../../../src/console/admin/views/shell.js';
import { adminBranding, adminSession } from './server.js';

/**
 * The signed-in admin shell (the console's layout). Anyone else gets the page alone: every admin page checks the
 * session itself and sends signed-out visitors to the one sign-in page (coming back to the page) and merchants to
 * their console, also on client-side navigations, which do not render the layout again.
 * @param {{ children: import('react').ReactNode }} props
 */
export async function AdminFrame({ children }) {
	const [session, branding] = await Promise.all([adminSession(), adminBranding()]);
	if (!session.ok) return children;
	return (
		<AdminShell admin={session.admin} twoStepRequired={session.twoStepRequired} branding={branding}>
			{children}
		</AdminShell>
	);
}
