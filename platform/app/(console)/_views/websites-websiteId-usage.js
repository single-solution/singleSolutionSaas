import { loadUsage } from '../../../src/console/loaders.js';
import { UsageView } from '../../../src/console/views/usage.js';
import { merchantContext, one } from '../_lib/server.js';

export const metadata = { title: 'Usage' };

/**
 * @param {{ params: Promise<{ websiteId: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props
 */
export default async function UsagePage({ params, searchParams }) {
	const { websiteId } = await params;
	const q = await searchParams;
	const { api, merchantId } = await merchantContext(`/websites/${websiteId}/usage`);
	return <UsageView {...await loadUsage(api, merchantId, websiteId, { from: one(q.from), to: one(q.to) })} />;
}
