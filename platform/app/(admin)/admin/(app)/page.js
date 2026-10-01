import { loadDashboard } from '../../../../src/console/admin/loaders.js';
import { DashboardView } from '../../../../src/console/admin/views/dashboard.js';
import { staffContext } from '../../_lib/server.js';

export const metadata = { title: 'Platform health' };

export default async function PlatformHealthPage() {
	const { api } = await staffContext('/admin');
	return <DashboardView {...await loadDashboard(api)} />;
}
