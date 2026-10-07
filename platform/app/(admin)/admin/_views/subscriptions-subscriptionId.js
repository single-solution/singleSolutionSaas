import { loadSubscription } from '../../../../src/console/admin/loaders.js';
import { SubscriptionAdminView } from '../../../../src/console/admin/views/config.js';
import { adminContext } from '../../_lib/server.js';

export const metadata = { title: 'Subscription' };

/** @param {{ params: Promise<{ subscriptionId: string }> }} props */
export default async function SubscriptionPage({ params }) {
	const { subscriptionId } = await params;
	const { api, admin } = await adminContext(`/admin/subscriptions/${subscriptionId}`);
	return <SubscriptionAdminView {...await loadSubscription(api, subscriptionId)} admin={admin} />;
}
