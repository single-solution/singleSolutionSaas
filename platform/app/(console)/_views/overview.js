import { loadOverview } from '../../../src/console/loaders.js';
import { OverviewView } from '../../../src/console/views/websites.js';
import { consoleBranding, merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Overview' };

export default async function OverviewPage() {
	const { api, merchantId } = await merchantContext('/overview');
	const overview = await loadOverview(api, merchantId);
	// the support contact shows only in the welcome of a merchant with no websites yet
	const welcome = overview.ok && overview.rows.length === 0;
	return <OverviewView {...overview} branding={welcome ? await consoleBranding() : undefined} />;
}
