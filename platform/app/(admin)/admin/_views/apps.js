import { loadApps } from '../../../../src/console/admin/loaders.js';
import { AppsView } from '../../../../src/console/admin/views/apps.js';
import { staffContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Apps' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function AppsPage({ searchParams }) {
	const q = await searchParams;
	const { api, staff } = await staffContext('/admin/apps');
	return <AppsView {...await loadApps(api, { status: one(q.status), kind: one(q.kind) })} staff={staff} />;
}
