import { redirectIfSignedIn, consoleBranding } from '../(console)/_lib/server.js';
import { SiteHome } from './_components/SiteHome.js';

export const dynamic = 'force-dynamic';

/** Public marketing home on the Portal (signed-in merchants go to the console). */
export async function generateMetadata() {
	const branding = await consoleBranding().catch(() => null);
	const name = branding?.name ? String(branding.name) : 'Single Solution';
	return {
		title: name,
		description:
			'Run your online shop from one place: website, shop tools, payments, chat, messages, and a phone app for staff. Plans follow your account.',
		robots: { index: true, follow: true },
	};
}

export default async function SitePage() {
	await redirectIfSignedIn();
	const branding = await consoleBranding().catch(() => null);
	return <SiteHome brandName={branding?.name ? String(branding.name) : 'Single Solution'} />;
}
