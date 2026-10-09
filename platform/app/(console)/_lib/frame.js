import { loadFrame } from '../../../src/console/loaders.js';
import { ConsoleShell } from '../../../src/console/views/shell.js';
import { consoleApi, consoleBranding, consoleSession } from './server.js';

/**
 * The signed-in merchant shell (the console's layout); the shell leaves the public account pages unframed. Anyone
 * else gets the page alone: every console page checks the session itself and sends signed-out visitors to sign in
 * (coming back to the page) and admins to their console, also on client-side navigations, which do not render the
 * layout again. Pages that show money hand their fresh billing summary to the shell (`FrameBilling`).
 * @param {{ children: import('react').ReactNode }} props
 */
export async function ConsoleFrame({ children }) {
	const [session, branding] = await Promise.all([consoleSession(), consoleBranding()]);
	if (!session.ok) return children;
	const frame = await loadFrame(await consoleApi(), session.merchantId);
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
