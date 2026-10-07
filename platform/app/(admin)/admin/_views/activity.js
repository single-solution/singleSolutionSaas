import { loadActivity } from '../../../../src/console/admin/loaders.js';
import { ActivityView } from '../../../../src/console/admin/views/activity.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Activity' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function ActivityPage({ searchParams }) {
	const q = await searchParams;
	const { api } = await adminContext('/admin/activity');
	return (
		<ActivityView
			{...await loadActivity(api, {
				merchantId: one(q.merchantId),
				adminId: one(q.adminId),
				from: one(q.from),
				to: one(q.to),
			})}
		/>
	);
}
