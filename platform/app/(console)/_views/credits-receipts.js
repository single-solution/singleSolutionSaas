import { loadCredits } from '../../../src/console/loaders.js';
import { CreditsView } from '../../../src/console/views/credits.js';
import { merchantContext } from '../_lib/server.js';

export const metadata = { title: 'Credit receipts' };

export default async function CreditReceiptsPage() {
	const { api, merchantId } = await merchantContext('/credits/receipts');
	return <CreditsView {...await loadCredits(api, merchantId, {}, 'receipts')} />;
}
