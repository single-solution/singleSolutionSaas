import { loadSetup } from '../../../../src/console/loaders.js';
import { adminRoutes } from '../../../../src/console/admin/paths.js';
import { AdminSetupView } from '../../../../src/console/admin/views/setup.js';
import { PageProblem } from '../../../../src/console/views/common.js';
import { SETUP } from '../../../../src/texts/console.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Setup' };

/** The Setup sheet of a merchant's website (Owner and Support). */
/** @param {{ params: Promise<{ merchantId: string, websiteId: string }> }} props */
export default async function WebsiteSetupPage({ params }) {
	const { merchantId, websiteId } = await params;
	const { api } = await adminContext(adminRoutes.websiteSetup(merchantId, websiteId));
	const setup = await loadSetup(api, merchantId, websiteId);
	const back = { href: adminRoutes.website(merchantId, websiteId), label: SETUP.back };
	if (!setup.ok) return <PageProblem problem={setup.problem} back={back} />;
	return (
		<AdminSetupView
			sheet={setup.sheet}
			links={setup.links}
			merchantId={merchantId}
			websiteId={websiteId}
			back={back}
			settingsHref={adminRoutes.websiteSettings(merchantId, websiteId)}
		/>
	);
}
