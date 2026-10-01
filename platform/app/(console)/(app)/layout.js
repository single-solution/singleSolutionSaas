import { redirect } from 'next/navigation';
import { loadFrame } from '../../../src/console/loaders.js';
import { loadImpersonation } from '../../../src/console/admin/loaders.js';
import { ConsoleShell } from '../../../src/console/views/shell.js';
import { consoleApi, consoleSession } from '../_lib/server.js';

export const metadata = { robots: { index: false, follow: false } };

/** @param {{ children: import('react').ReactNode }} props */
export default async function ConsoleLayout({ children }) {
	const session = await consoleSession();
	if (!session.ok) {
		if (session.status === 401) redirect('/login');
		throw new Error(session.problem?.detail ?? 'The console is unavailable.');
	}
	const api = await consoleApi();
	const [frame, impersonation] = await Promise.all([
		session.merchantId ? loadFrame(api, session.merchantId) : { websites: [], meter: null, notifications: [] },
		loadImpersonation(api),
	]);
	return (
		<ConsoleShell
			me={session.me}
			merchantId={session.merchantId}
			websites={frame.websites}
			meter={frame.meter}
			notifications={frame.notifications}
			impersonation={impersonation}>
			{children}
		</ConsoleShell>
	);
}
