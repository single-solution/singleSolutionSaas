import { loadPolicies } from '../../../../src/console/admin/loaders.js';
import { PoliciesView } from '../../../../src/console/admin/views/config.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Platform policy' };

/** @param {{ params: Promise<{ appId: string }> }} props */
export default async function PlatformPolicyPage({ params }) {
	const { appId } = await params;
	const { api, admin } = await adminContext(`/admin/apps/${appId}/policies`);
	return <PoliciesView {...await loadPolicies(api, appId)} admin={admin} />;
}
