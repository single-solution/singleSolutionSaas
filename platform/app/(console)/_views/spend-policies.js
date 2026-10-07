import { loadSpendPolicies } from '../../../src/console/loaders.js';
import { SpendPoliciesView } from '../../../src/console/views/credits.js';
import { merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Spend policies' };

export default async function SpendPoliciesPage() {
	const { api, merchantId } = await merchantContext('/spend-policies');
	return <SpendPoliciesView {...await loadSpendPolicies(api, merchantId)} />;
}
