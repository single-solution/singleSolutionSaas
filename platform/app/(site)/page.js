import { redirectIfSignedIn, consoleBranding, consoleApi } from '../(console)/_lib/server.js';
import { loadDocsHub } from '../../src/console/loaders.js';
import { SiteHome } from './_components/SiteHome.js';

export const dynamic = 'force-dynamic';

/** Public marketing home on the Portal (signed-in merchants go to the console). */
export async function generateMetadata() {
	const branding = await consoleBranding().catch(() => null);
	const name = branding?.name ? String(branding.name) : 'Single Solution';
	return {
		title: { absolute: name },
		description:
			'Prebuilt platform for merchants: build your frontend, place ready products (accounts, payments, chat, and more), run the Portal and mobile app, share one pack with your developer. Plans follow your account.',
		robots: { index: true, follow: true },
	};
}

export default async function SitePage() {
	await redirectIfSignedIn();
	const [branding, api] = await Promise.all([consoleBranding().catch(() => null), consoleApi()]);
	const docs = await loadDocsHub(api).catch(() => null);
	const products =
		docs?.ok && Array.isArray(docs.items)
			? docs.items.map((item) => ({
					id: String(item.productId ?? ''),
					name: String(item.name ?? item.productId ?? ''),
					description: typeof item.description === 'string' ? item.description : '',
				}))
			: [];
	return <SiteHome brandName={branding?.name ? String(branding.name) : 'Single Solution'} products={products} />;
}
