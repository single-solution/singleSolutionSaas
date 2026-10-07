import { loadApp } from '../../../../src/console/admin/loaders.js';
import { AppView } from '../../../../src/console/admin/views/apps.js';
import { staffContext } from '../../_lib/server.js';

export const metadata = { title: 'App' };

/** @param {{ params: Promise<{ appId: string }> }} props */
export default async function AppPage({ params }) {
	const { appId } = await params;
	const { api, staff } = await staffContext(`/admin/apps/${appId}`);
	return <AppView {...await loadApp(api, appId)} staff={staff} />;
}
