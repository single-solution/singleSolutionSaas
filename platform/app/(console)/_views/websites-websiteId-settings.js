import { loadWebsiteSettings } from '../../../src/console/loaders.js';
import { routes } from '../../../src/console/paths.js';
import { PageProblem } from '../../../src/console/views/common.js';
import { WebsiteSettingsView } from '../../../src/console/views/website-settings.js';
import { WEBSITE_SETTINGS } from '../../../src/texts/console.js';
import { merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Website settings' };

/** The Website settings of one of the merchant's websites. */
/** @param {{ params: Promise<{ websiteId: string }> }} props */
export default async function WebsiteSettingsPage({ params }) {
	const { websiteId } = await params;
	const { api, merchantId } = await merchantContext(routes.websiteSettings(websiteId));
	const loaded = await loadWebsiteSettings(api, merchantId, websiteId);
	const back = { href: routes.website(websiteId), label: WEBSITE_SETTINGS.back };
	if (!loaded.ok) return <PageProblem problem={loaded.problem} back={back} />;
	return (
		<WebsiteSettingsView
			data={loaded.data}
			changes={loaded.changes}
			merchantId={merchantId}
			websiteId={websiteId}
			domain={loaded.domain}
			back={back}
		/>
	);
}
