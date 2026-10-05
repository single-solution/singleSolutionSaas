import { loadDeliveries } from '../../../../../../src/console/loaders.js';
import { DeliveriesView } from '../../../../../../src/console/views/deliveries.js';
import { merchantContext, one } from '../../../../_lib/server.js';

export const metadata = { title: 'Deliveries' };

/**
 * @param {{ params: Promise<{ websiteId: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props
 */
export default async function DeliveriesPage({ params, searchParams }) {
	const { websiteId } = await params;
	const q = await searchParams;
	const { api, merchantId } = await merchantContext(`/websites/${websiteId}/deliveries`);
	return <DeliveriesView {...await loadDeliveries(api, merchantId, websiteId, { status: one(q.status) })} />;
}
