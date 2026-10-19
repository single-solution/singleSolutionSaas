import { loadAttentionCount } from '../../../src/console/admin/loaders.js';
import { adminCan } from '../../../src/console/admin/rights.js';
import { portalApi } from '../../_lib/server.js';
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
	// the number on the "Credits and billing" menu entry; the menu never waits on a failure of it
	const attention =
		!session.twoStepRequired && adminCan(session.admin, 'billing.read')
			? await loadAttentionCount(await portalApi()).catch(() => 0)
			: 0;
	return (
		<AdminShell admin={session.admin} twoStepRequired={session.twoStepRequired} branding={branding} attention={attention}>
			{children}
		</AdminShell>
	);
}
