import { loadWebsiteSettings } from '../../../../src/console/loaders.js';
import { adminRoutes } from '../../../../src/console/admin/paths.js';
import { PageProblem } from '../../../../src/console/views/common.js';
import { WebsiteSettingsView } from '../../../../src/console/views/website-settings.js';
import { WEBSITE_SETTINGS } from '../../../../src/texts/console.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Website settings' };

/** The Website settings of a merchant's website (Owner and Support). */
/** @param {{ params: Promise<{ merchantId: string, websiteId: string }> }} props */
export default async function WebsiteSettingsPage({ params }) {
	const { merchantId, websiteId } = await params;
	const { api } = await adminContext(adminRoutes.websiteSettings(merchantId, websiteId));
	const loaded = await loadWebsiteSettings(api, merchantId, websiteId);
	const back = { href: adminRoutes.website(merchantId, websiteId), label: WEBSITE_SETTINGS.back };
	if (!loaded.ok) return <PageProblem problem={loaded.problem} back={back} />;
	return (
		<WebsiteSettingsView
			data={loaded.data}
			changes={loaded.changes}
			connections={loaded.connections}
			merchantId={merchantId}
			websiteId={websiteId}
			domain={loaded.domain}
			back={back}
		/>
	);
}
