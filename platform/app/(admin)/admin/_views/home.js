import { loadOverview } from '../../../../src/console/admin/loaders.js';
import { OverviewView } from '../../../../src/console/admin/views/overview.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Overview' };

export default async function OverviewPage() {
	const { api, admin } = await adminContext('/admin');
	return <OverviewView {...await loadOverview(api)} admin={admin} />;
}
