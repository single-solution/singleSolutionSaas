import { loadOverview } from '../../../src/console/loaders.js';
import { OverviewView } from '../../../src/console/views/websites.js';
import { consoleBranding, merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Overview' };

export default async function OverviewPage() {
	const { api, merchantId } = await merchantContext('/overview');
	return <OverviewView {...await loadOverview(api, merchantId)} branding={await consoleBranding()} />;
}
