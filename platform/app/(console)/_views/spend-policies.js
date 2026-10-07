import { loadSpendCap } from '../../../src/console/loaders.js';
import { SpendCapView } from '../../../src/console/views/credits.js';
import { merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Spend cap' };

export default async function SpendCapPage() {
	const { api, merchantId } = await merchantContext('/spend-policies');
	return <SpendCapView {...await loadSpendCap(api, merchantId)} />;
}
