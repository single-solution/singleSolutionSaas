/**
 * Dashboard session view: who is signed in through the Portal launch (exchanged at app-kit's `GET /sso?launch=`).
 * Used by the dashboard and by the certification suite to check every launch kind.
 */

/**
 * @param {{ kind: string, role: string, scope?: Record<string, unknown>, user?: { id?: string, email?: string }, subject?: string }} session app-kit session
 */
export const sessionView = (session) => ({
	kind: session.kind,
	role: session.role,
	scope: session.scope ?? {},
	user: session.user?.id ?? session.subject ?? null,
	actor: typeof session.scope?.actor === 'string' ? session.scope.actor : null,
});
