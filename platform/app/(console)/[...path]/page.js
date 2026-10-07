/**
 * The merchant console and the public account pages (the one sign-in page for admins and merchants): one page (one server function) renders the view of every path — signed-in views inside `ConsoleFrame`
 * (the shell; it sends signed-out visitors to sign in), sign-in views on their own; any other path is a 404.
 * Views keep the `params` / `searchParams` / `metadata` they had as pages.
 */
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { ConsoleFrame } from '../_lib/frame.js';
import Loading from './loading-view.js';
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

/** Path patterns under / (`:name` captures a segment into `params`), views, metadata and whether they need a session. */
const VIEWS = /** @type {Array<[string[], (props: any) => any, import('next').Metadata, boolean]>} */ ([
	[['account'], Account, AccountMeta, true],
	[['credits'], Credits, CreditsMeta, true],
	[['forgot-password'], ForgotPassword, ForgotPasswordMeta, false],
	[['login'], Login, LoginMeta, false],
	[['reset-password'], ResetPassword, ResetPasswordMeta, false],
	[['set-password'], SetPassword, SetPasswordMeta, false],
	[['confirm-email'], ConfirmEmail, ConfirmEmailMeta, false],
	[['overview'], Overview, OverviewMeta, true],
	[['websites'], Websites, WebsitesMeta, true],
	[['websites', ':websiteId'], WebsitesWebsiteId, WebsitesWebsiteIdMeta, true],
]);

/**
 * @param {string[]} path
 * @returns {{ view: (props: any) => any, metadata: import('next').Metadata, framed: boolean, params: Record<string, string> } | null}
 */
const resolve = (path) => {
	for (const [pattern, view, metadata, framed] of VIEWS) {
		if (pattern.length !== path.length) continue;
		/** @type {Record<string, string>} */
		const params = {};
		if (
			pattern.every((part, index) =>
				part.startsWith(':') ? ((params[part.slice(1)] = path[index] ?? ''), true) : part === path[index],
			)
		)
			return { view, metadata, framed, params };
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
	if (!found.framed) return view;
	return (
		<ConsoleFrame>
			<Suspense fallback={<Loading />}>{view}</Suspense>
		</ConsoleFrame>
	);
}
