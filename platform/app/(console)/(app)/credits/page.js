import { loadCredits } from '../../../../src/console/loaders.js';
import { CreditsView } from '../../../../src/console/views/credits.js';
import { merchantContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Credits' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function CreditsPage({ searchParams }) {
	const q = await searchParams;
	const { api, merchantId } = await merchantContext('/credits');
	return (
		<CreditsView {...await loadCredits(api, merchantId, { from: one(q.from), to: one(q.to), websiteId: one(q.websiteId) })} />
	);
}
