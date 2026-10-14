import { loadSetup } from '../../../src/console/loaders.js';
import { routes } from '../../../src/console/paths.js';
import { PageProblem } from '../../../src/console/views/common.js';
import { MerchantSetupView } from '../../../src/console/views/setup.js';
import { SETUP } from '../../../src/texts/console.js';
import { merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Setup' };

/** The Setup sheet of one of the merchant's websites. */
/** @param {{ params: Promise<{ websiteId: string }> }} props */
export default async function WebsiteSetupPage({ params }) {
	const { websiteId } = await params;
	const { api, merchantId } = await merchantContext(routes.websiteSetup(websiteId));
	const setup = await loadSetup(api, merchantId, websiteId);
	const back = { href: routes.website(websiteId), label: SETUP.back };
	if (!setup.ok) return <PageProblem problem={setup.problem} back={back} />;
	return <MerchantSetupView sheet={setup.sheet} links={setup.links} merchantId={merchantId} websiteId={websiteId} back={back} />;
}
