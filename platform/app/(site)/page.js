import { redirectIfSignedIn, consoleApi } from '../(console)/_lib/server.js';
import { loadDocsHub } from '../../src/console/loaders.js';
import { COMPANY_NAME, PRODUCT_BRAND } from './_components/SiteNav.js';
import { SiteHome } from './_components/SiteHome.js';

export const dynamic = 'force-dynamic';

/** Public marketing home on the Portal (signed-in merchants go to the console). */
export async function generateMetadata() {
	return {
		title: { absolute: PRODUCT_BRAND },
		description: `${PRODUCT_BRAND} by ${COMPANY_NAME}: ready website features — sign-in, payments, chat, and more — without building them yourself. You keep the look. One account to manage it. Plans follow your account.`,
		robots: { index: true, follow: true },
	};
}

export default async function SitePage() {
	await redirectIfSignedIn();
	const api = await consoleApi();
	const docs = await loadDocsHub(api).catch(() => null);
	const products =
		docs?.ok && Array.isArray(docs.items)
			? docs.items.map((item) => ({
					id: String(item.productId ?? ''),
					name: String(item.name ?? item.productId ?? ''),
					description: typeof item.description === 'string' ? item.description : '',
				}))
			: [];
	return <SiteHome productName={PRODUCT_BRAND} companyName={COMPANY_NAME} products={products} />;
}
