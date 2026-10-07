import { loadSettings } from '../../../../src/console/admin/loaders.js';
import { SettingsView } from '../../../../src/console/admin/views/settings.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
	const { api } = await adminContext('/admin/settings');
	return <SettingsView {...await loadSettings(api)} />;
}
