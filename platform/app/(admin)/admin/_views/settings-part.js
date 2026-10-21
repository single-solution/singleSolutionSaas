import { notFound } from 'next/navigation';
import { loadSettings } from '../../../../src/console/admin/loaders.js';
import { SETTINGS_PARTS } from '../../../../src/console/admin/paths.js';
import { SettingsView } from '../../../../src/console/admin/views/settings.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Settings' };

/** A part of Settings: `/admin/settings/support`, `mail`, `security` or `billing`; any other is a 404. */
/** @param {{ params: Promise<{ part: string }> }} props */
export default async function SettingsPartPage({ params }) {
	const { part } = await params;
	if (!SETTINGS_PARTS.includes(part)) notFound();
	const { api } = await adminContext(`/admin/settings/${part}`);
	return <SettingsView {...await loadSettings(api)} part={part} />;
}
