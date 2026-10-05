import { loadVersion } from '../../../../../../../../src/console/admin/loaders.js';
import { VersionView } from '../../../../../../../../src/console/admin/views/apps.js';
import { staffContext } from '../../../../../../_lib/server.js';

export const metadata = { title: 'Manifest version' };

/** @param {{ params: Promise<{ appId: string, version: string }> }} props */
export default async function ManifestVersionPage({ params }) {
	const { appId, version } = await params;
	const { api, staff } = await staffContext(`/admin/apps/${appId}/versions/${version}`);
	return <VersionView {...await loadVersion(api, appId, version)} staff={staff} />;
}
