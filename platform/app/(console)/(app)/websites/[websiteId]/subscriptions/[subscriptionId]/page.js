import { loadSubscription } from '../../../../../../../src/console/loaders.js';
import { SubscriptionView } from '../../../../../../../src/console/views/subscription.js';
import { merchantContext } from '../../../../../_lib/server.js';

export const metadata = { title: 'Subscription' };

/** @param {{ params: Promise<{ websiteId: string, subscriptionId: string }> }} props */
export default async function SubscriptionPage({ params }) {
	const { websiteId, subscriptionId } = await params;
	const { api, merchantId } = await merchantContext(`/websites/${websiteId}/subscriptions/${subscriptionId}`);
	return <SubscriptionView {...await loadSubscription(api, merchantId, websiteId, subscriptionId)} />;
}
