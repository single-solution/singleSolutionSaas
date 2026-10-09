/**
 * The merchant console and the public account pages (the one sign-in page for admins and merchants): one page (one
 * server function) renders the view of every path; any other path is a 404. The console frame is the layout above
 * (it stays on screen across navigations; the public pages stay unframed) and `loading.js` the skeleton shown at once
 * while a page is on the way. Pages fade and slide in (`PageTransition`); the Websites screen keeps its list in place
 * and animates the detail only. Views keep the `params` / `searchParams` / `metadata` they had as pages.
 */
import { notFound } from 'next/navigation';
import { PageTransition } from '@ss/ui';
import Account, { metadata as AccountMeta } from '../_views/account.js';
import Credits, { metadata as CreditsMeta } from '../_views/credits.js';
import ForgotPassword, { metadata as ForgotPasswordMeta } from '../_views/forgot-password.js';
import Login, { metadata as LoginMeta } from '../_views/login.js';
import ResetPassword, { metadata as ResetPasswordMeta } from '../_views/reset-password.js';
import SetPassword, { metadata as SetPasswordMeta } from '../_views/set-password.js';
import ConfirmEmail, { metadata as ConfirmEmailMeta } from '../_views/confirm-email.js';
import Overview, { metadata as OverviewMeta } from '../_views/overview.js';
import Websites, { metadata as WebsitesMeta } from '../_views/websites.js';
import WebsitesWebsiteId, { metadata as WebsitesWebsiteIdMeta } from '../_views/websites-websiteId.js';

export const dynamic = 'force-dynamic';

/**
 * Path patterns under / (`:name` captures a segment into `params`), views, metadata and the kind of view: a console
 * `page`, a list-and-detail `screen` (it animates its detail itself) or a `public` account page.
 * @typedef {'page' | 'screen' | 'public'} ViewKind
 */
const VIEWS = /** @type {Array<[string[], (props: any) => any, import('next').Metadata, ViewKind]>} */ ([
	[['account'], Account, AccountMeta, 'page'],
	[['credits'], Credits, CreditsMeta, 'page'],
	[['forgot-password'], ForgotPassword, ForgotPasswordMeta, 'public'],
	[['login'], Login, LoginMeta, 'public'],
	[['reset-password'], ResetPassword, ResetPasswordMeta, 'public'],
	[['set-password'], SetPassword, SetPasswordMeta, 'public'],
	[['confirm-email'], ConfirmEmail, ConfirmEmailMeta, 'public'],
	[['overview'], Overview, OverviewMeta, 'page'],
	[['websites'], Websites, WebsitesMeta, 'screen'],
	[['websites', ':websiteId'], WebsitesWebsiteId, WebsitesWebsiteIdMeta, 'screen'],
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
