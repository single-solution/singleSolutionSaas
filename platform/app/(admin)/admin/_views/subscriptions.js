import { loadSubscriptionLookup } from '../../../../src/console/admin/loaders.js';
import { SubscriptionLookupView } from '../../../../src/console/admin/views/config.js';
import { adminContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Subscriptions' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function SubscriptionsPage({ searchParams }) {
	const q = await searchParams;
	const { api } = await adminContext('/admin/subscriptions');
	return <SubscriptionLookupView {...await loadSubscriptionLookup(api, { id: one(q.id) })} />;
}
