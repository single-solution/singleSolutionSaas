/**
 * The merchant console and the public account pages (the one sign-in page for admins and merchants): one page (one
 * server function) renders the view of every path; any other path is a 404. The console frame is the layout above
 * (it stays on screen across navigations; the public pages stay unframed) and `loading.js` the skeleton shown at once
 * while a page is on the way. Pages fade and slide in (`PageTransition`); a `Page` screen animates its body only. Each
 * view defines its `metadata`.
 */
import { notFound, redirect } from 'next/navigation.js';
import { connection } from 'next/server';
import { PageTransition } from '@ss/ui';
import {
	loadAccount,
	loadCredits,
	loadDocsHub,
	loadOverview,
	loadWebsitePage,
	loadWebsites,
} from '../../../src/console/loaders.js';
import { ACCOUNT_PARTS, routes } from '../../../src/console/paths.js';
import { LEGACY_PEER_REDIRECTS, websitePartOf } from '../../../src/console/website-parts.js';
import {
	consoleApi,
	consoleBranding,
	firstAdminAvailable,
	merchantContext,
	one,
	redirectIfSignedIn,
} from '../_lib/server.js';
import { AccountView } from '../../../src/console/views/account.js';
import { CreditsView } from '../../../src/console/views/credits.js';
import { DocsHubView } from '../../../src/console/views/docs.js';
import { SharedSetupView } from '../../../src/console/views/setup.js';
import {
	ConfirmEmailView,
	ForgotPasswordView,
	ResetPasswordView,
	SetPasswordView,
	SignInView,
} from '../../../src/console/views/sign-in.js';
import { OverviewView, WebsiteView, WebsitesView } from '../../../src/console/views/websites.js';

export const dynamic = 'force-dynamic';

async function AccountPage() {
	const { api, merchantId } = await merchantContext('/account');
	return <AccountView {...await loadAccount(api, merchantId)} part="details" />;
}

/** @param {{ params: Promise<{ part: string }> }} props */
async function AccountPartPage({ params }) {
	const { part } = await params;
	if (!ACCOUNT_PARTS.includes(part) || part === 'details') notFound();
	redirect(routes.accountPart(part));
}

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
async function CreditsPage({ searchParams }) {
	const q = await searchParams;
	const { api, merchantId } = await merchantContext('/credits');
	return (
		<CreditsView {...await loadCredits(api, merchantId, { from: one(q.from), to: one(q.to), websiteId: one(q.websiteId) })} />
	);
}

async function CreditReceiptsPage() {
	redirect(routes.creditsReceipts());
}

async function ForgotPasswordPage() {
	await connection();
	return <ForgotPasswordView branding={await consoleBranding()} />;
}

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
async function LoginPage({ searchParams }) {
	await redirectIfSignedIn();
	const q = await searchParams;
	const notice = one(q.expired) === '1' ? 'expired' : one(q.notice);
	return (
		<SignInView
			branding={await consoleBranding()}
			firstAdmin={await firstAdminAvailable()}
			next={one(q.next) ?? null}
			notice={notice === 'expired' || notice === 'reset' || notice === 'email' ? notice : null}
		/>
	);
}

async function ResetPasswordPage() {
	await connection();
	return <ResetPasswordView branding={await consoleBranding()} />;
}

async function SetPasswordPage() {
	await connection();
	return <SetPasswordView branding={await consoleBranding()} />;
}

async function ConfirmEmailPage() {
	await connection();
	return <ConfirmEmailView branding={await consoleBranding()} />;
}

async function OverviewPage() {
	const { api, me, merchantId } = await merchantContext('/overview');
	const overview = await loadOverview(api, merchantId);
	const welcome = overview.ok && overview.rows.length === 0;
	return <OverviewView {...overview} me={me} branding={welcome ? await consoleBranding() : undefined} />;
}

async function WebsitesPage() {
	const { api, merchantId } = await merchantContext('/websites');
	const websites = await loadWebsites(api, merchantId);
	const welcome = websites.ok && websites.rows.length === 0;
	return <WebsitesView {...websites} branding={welcome ? await consoleBranding() : undefined} />;
}

/** @param {{ params: Promise<{ websiteId: string, part?: string, sub?: string }> }} props */
async function WebsitePage({ params }) {
	const { websiteId, part, sub } = await params;
	if (part && LEGACY_PEER_REDIRECTS.includes(/** @type {any} */ (part))) {
		redirect(routes.website(websiteId));
	}
	const path = websitePartOf(part, sub);
	const { api, merchantId } = await merchantContext(routes.websitePart(websiteId, path));
	return <WebsiteView {...await loadWebsitePage(api, merchantId, websiteId, path)} />;
}

async function SharedSetupPage() {
	await connection();
	return <SharedSetupView brand={(await consoleBranding()).name} />;
}

async function DocsPage() {
	await connection();
	const [branding, api] = await Promise.all([consoleBranding(), consoleApi()]);
	const loaded = await loadDocsHub(api);
	return <DocsHubView branding={branding} items={loaded.ok ? loaded.items : []} />;
}

async function DocsProductPage() {
	redirect(routes.docs());
}

/**
 * Path patterns under / (`:name` captures a segment into `params`), views, metadata and the kind of view: a console
 * `page` (wrapped in the page transition), a `screen` (a `Page` of `@ss/ui`: it fades its own body in and keeps its header
 * and inner navigation in place) or a `public` account page.
 * @typedef {'page' | 'screen' | 'public'} ViewKind
 */
const VIEWS = /** @type {Array<[string[], (props: any) => any, import('next').Metadata, ViewKind]>} */ ([
	[['account'], AccountPage, { title: 'Account' }, 'screen'],
	[['account', ':part'], AccountPartPage, { title: 'Account' }, 'screen'],
	[['credits'], CreditsPage, { title: 'Usage and credits' }, 'screen'],
	[['credits', 'receipts'], CreditReceiptsPage, { title: 'Credit receipts' }, 'screen'],
	[['forgot-password'], ForgotPasswordPage, { title: 'Forgot password' }, 'public'],
	[['login'], LoginPage, { title: 'Sign in' }, 'public'],
	[['reset-password'], ResetPasswordPage, { title: 'Choose a new password' }, 'public'],
	[['set-password'], SetPasswordPage, { title: 'Set your password' }, 'public'],
	[['confirm-email'], ConfirmEmailPage, { title: 'Confirm your new email' }, 'public'],
	[['overview'], OverviewPage, { title: 'Overview' }, 'page'],
	[['websites'], WebsitesPage, { title: 'Websites' }, 'screen'],
	[['websites', ':websiteId'], WebsitePage, { title: 'Website' }, 'screen'],
	[['websites', ':websiteId', ':part'], WebsitePage, { title: 'Website' }, 'screen'],
	[['websites', ':websiteId', ':part', ':sub'], WebsitePage, { title: 'Website' }, 'screen'],
	[['shared-setup'], SharedSetupPage, { title: 'Shared Setup', robots: { index: false, follow: false } }, 'public'],
	[
		['docs'],
		DocsPage,
		{
			title: 'Documentation Hub',
			description: 'Public developer documentation and OpenAPI 3.0 specs for Single Solution products.',
			robots: { index: true, follow: true },
		},
		'public',
	],
	[
		['docs', ':productId'],
		DocsProductPage,
		{
			title: 'Product Documentation',
			description: 'Developer documentation, guides, and OpenAPI spec.',
			robots: { index: true, follow: true },
		},
		'public',
	],
]);

/**
 * @param {string[]} path
 * @returns {{ view: (props: any) => any, metadata: import('next').Metadata, kind: ViewKind, params: Record<string, string> } | null}
 */
const resolve = (path) => {
	for (const [pattern, view, metadata, kind] of VIEWS) {
		if (pattern.length !== path.length) continue;
		/** @type {Record<string, string>} */
		const params = {};
		if (
			pattern.every((part, index) =>
				part.startsWith(':') ? ((params[part.slice(1)] = path[index] ?? ''), true) : part === path[index],
			)
		)
			return { view, metadata, kind, params };
	}
	return null;
};

/** @param {{ params: Promise<{ path?: string[] }> }} props */
export async function generateMetadata({ params }) {
	const found = resolve((await params).path ?? []);
	return found ? found.metadata : {};
}

/** @param {{ params: Promise<{ path?: string[] }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Page({ params, searchParams }) {
	const found = resolve((await params).path ?? []);
	if (!found) notFound();
	const View = found.view;
	const view = <View params={Promise.resolve(found.params)} searchParams={searchParams} />;
	return found.kind === 'page' ? <PageTransition>{view}</PageTransition> : view;
}
