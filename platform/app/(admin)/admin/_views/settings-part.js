import { notFound, redirect } from 'next/navigation.js';
import { SETTINGS_PARTS, adminRoutes } from '../../../../src/console/admin/paths.js';

export const metadata = { title: 'Settings' };

/** An old address of a part of Settings (`/admin/settings/support`, `mail`, `security`, `billing`) opens the page at that part; any other is a 404. */
/** @param {{ params: Promise<{ part: string }> }} props */
export default async function SettingsPartPage({ params }) {
	const { part } = await params;
	if (!SETTINGS_PARTS.includes(part)) notFound();
	redirect(adminRoutes.settingsPart(part));
}
