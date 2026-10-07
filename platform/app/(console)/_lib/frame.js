import { redirect } from 'next/navigation';
import { loadFrame } from '../../../src/console/loaders.js';
import { ConsoleShell } from '../../../src/console/views/shell.js';
import { consoleApi, consoleBranding, consoleSession } from './server.js';

/**
 * The signed-in merchant console shell around a view: signed-out visitors go to /login, admins to /admin.
 * @param {{ children: import('react').ReactNode }} props
 */
export async function ConsoleFrame({ children }) {
	const session = await consoleSession();
	if (!session.ok) {
		if (session.status === 401) redirect('/login');
		if (/** @type {{ admin?: boolean }} */ (session).admin) redirect('/admin');
		throw new Error(session.problem?.detail ?? 'The console is unavailable.');
	}
	const api = await consoleApi();
	const [frame, branding] = await Promise.all([loadFrame(api, session.merchantId), consoleBranding()]);
	return (
		<ConsoleShell
			me={session.me}
			merchantId={session.merchantId}
			websites={frame.websites}
			billing={frame.billing}
			branding={branding}>
			{children}
		</ConsoleShell>
	);
}
