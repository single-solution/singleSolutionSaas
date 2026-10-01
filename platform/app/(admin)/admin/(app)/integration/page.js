import { loadIntegration } from '../../../../../src/console/admin/loaders.js';
import { IntegrationView } from '../../../../../src/console/admin/views/integration.js';
import { staffContext, one } from '../../../_lib/server.js';

export const metadata = { title: 'Integration' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function IntegrationPage({ searchParams }) {
	const q = await searchParams;
	const { api, staff } = await staffContext('/admin/integration');
	return (
		<IntegrationView
			{...await loadIntegration(api, { websiteId: one(q.websiteId), appId: one(q.appId), status: one(q.status) })}
			staff={staff}
		/>
	);
}
