import { loadAudit } from '../../../../../src/console/admin/loaders.js';
import { AuditView } from '../../../../../src/console/admin/views/operations.js';
import { staffContext, one } from '../../../_lib/server.js';

export const metadata = { title: 'Audit log' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function AuditLogPage({ searchParams }) {
	const q = await searchParams;
	const { api } = await staffContext('/admin/audit');
	return (
		<AuditView
			{...await loadAudit(api, {
				scope: one(q.scope),
				actorId: one(q.actorId),
				targetId: one(q.targetId),
				action: one(q.action),
			})}
		/>
	);
}
