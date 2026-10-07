import { loadConnectors } from '../../../../src/console/admin/loaders.js';
import { ConnectorsAdminView } from '../../../../src/console/admin/views/operations.js';
import { staffContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Connectors' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function ConnectorsPage({ searchParams }) {
	const q = await searchParams;
	const { api } = await staffContext('/admin/connectors');
	return (
		<ConnectorsAdminView
			{...await loadConnectors(api, { merchantId: one(q.merchantId), kind: one(q.kind), status: one(q.status) })}
		/>
	);
}
