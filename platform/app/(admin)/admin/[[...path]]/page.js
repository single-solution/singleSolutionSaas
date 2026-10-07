/**
 * The admin console (and its sign-in pages): one page (one server function) renders the view of every path — signed-in views inside `AdminFrame`
 * (the shell; it sends signed-out visitors to sign in), sign-in views on their own; any other path is a 404.
 * Views keep the `params` / `searchParams` / `metadata` they had as pages.
 */
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { AdminFrame } from '../../_lib/frame.js';
import Loading from './loading-view.js';
import Home, { metadata as HomeMeta } from '../_views/home.js';
import Account, { metadata as AccountMeta } from '../_views/account.js';
import Apps, { metadata as AppsMeta } from '../_views/apps.js';
import Audit, { metadata as AuditMeta } from '../_views/audit.js';
import Connectors, { metadata as ConnectorsMeta } from '../_views/connectors.js';
import Finance, { metadata as FinanceMeta } from '../_views/finance.js';
import ForgotPassword, { metadata as ForgotPasswordMeta } from '../_views/forgot-password.js';
import Login, { metadata as LoginMeta } from '../_views/login.js';
import Merchants, { metadata as MerchantsMeta } from '../_views/merchants.js';
import Settings, { metadata as SettingsMeta } from '../_views/settings.js';
import Staff, { metadata as StaffMeta } from '../_views/staff.js';
import Subscriptions, { metadata as SubscriptionsMeta } from '../_views/subscriptions.js';
import Websites, { metadata as WebsitesMeta } from '../_views/websites.js';
import AppsAppId, { metadata as AppsAppIdMeta } from '../_views/apps-appId.js';
import FinanceMerchantId, { metadata as FinanceMerchantIdMeta } from '../_views/finance-merchantId.js';
import MerchantsMerchantId, { metadata as MerchantsMerchantIdMeta } from '../_views/merchants-merchantId.js';
import SubscriptionsSubscriptionId, {
	metadata as SubscriptionsSubscriptionIdMeta,
} from '../_views/subscriptions-subscriptionId.js';
import AppsAppIdPolicies, { metadata as AppsAppIdPoliciesMeta } from '../_views/apps-appId-policies.js';

export const dynamic = 'force-dynamic';

/** Path patterns under /admin (`:name` captures a segment into `params`), views, metadata and whether they need a session. */
const VIEWS = /** @type {Array<[string[], (props: any) => any, import('next').Metadata, boolean]>} */ ([
	[[], Home, HomeMeta, false],
	[['account'], Account, AccountMeta, true],
	[['apps'], Apps, AppsMeta, true],
	[['audit'], Audit, AuditMeta, true],
	[['connectors'], Connectors, ConnectorsMeta, true],
	[['finance'], Finance, FinanceMeta, true],
	[['forgot-password'], ForgotPassword, ForgotPasswordMeta, false],
	[['login'], Login, LoginMeta, false],
	[['merchants'], Merchants, MerchantsMeta, true],
	[['settings'], Settings, SettingsMeta, true],
	[['staff'], Staff, StaffMeta, true],
	[['subscriptions'], Subscriptions, SubscriptionsMeta, true],
	[['websites'], Websites, WebsitesMeta, true],
	[['apps', ':appId'], AppsAppId, AppsAppIdMeta, true],
	[['finance', ':merchantId'], FinanceMerchantId, FinanceMerchantIdMeta, true],
	[['merchants', ':merchantId'], MerchantsMerchantId, MerchantsMerchantIdMeta, true],
	[['subscriptions', ':subscriptionId'], SubscriptionsSubscriptionId, SubscriptionsSubscriptionIdMeta, true],
	[['apps', ':appId', 'policies'], AppsAppIdPolicies, AppsAppIdPoliciesMeta, true],
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
	return found
		? found.framed && typeof found.metadata.title === 'string'
			? { ...found.metadata, title: { absolute: `${found.metadata.title} · Admin · Single Solution` } }
			: found.metadata
		: {};
}

/** @param {{ params: Promise<{ path?: string[] }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Page({ params, searchParams }) {
	const found = resolve((await params).path ?? []);
	if (!found) notFound();
	const View = found.view;
	const view = <View params={Promise.resolve(found.params)} searchParams={searchParams} />;
	if (!found.framed) return view;
	return (
		<AdminFrame>
			<Suspense fallback={<Loading />}>{view}</Suspense>
		</AdminFrame>
	);
}
