import { loadOnboarding } from '../../../../src/console/loaders.js';
import { OnboardingView } from '../../../../src/console/views/websites.js';
import { merchantContext, one } from '../../_lib/server.js';

export const metadata = { title: 'Get started' };

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function OnboardingPage({ searchParams }) {
	const { api, merchantId } = await merchantContext('/onboarding');
	const q = await searchParams;
	return <OnboardingView {...await loadOnboarding(api, merchantId, one(q.website))} />;
}
