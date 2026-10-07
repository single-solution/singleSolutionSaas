/**
 * The admin console: one page (one server function) renders the view of every path — signed-in views inside
 * `AdminFrame` (the shell; it sends signed-out visitors to the one sign-in page); any other path is a 404.
 * Views keep the `params` / `searchParams` / `metadata` they had as pages.
 */
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { AdminFrame } from '../../_lib/frame.js';
import Loading from './loading-view.js';
import Home, { metadata as HomeMeta } from '../_views/home.js';
import Account, { metadata as AccountMeta } from '../_views/account.js';
import Activity, { metadata as ActivityMeta } from '../_views/activity.js';
import Admins, { metadata as AdminsMeta } from '../_views/admins.js';
import Finance, { metadata as FinanceMeta } from '../_views/finance.js';
import Login, { metadata as LoginMeta } from '../_views/login.js';
import Merchants, { metadata as MerchantsMeta } from '../_views/merchants.js';
import Products, { metadata as ProductsMeta } from '../_views/products.js';
import Settings, { metadata as SettingsMeta } from '../_views/settings.js';
import MerchantsMerchantId, { metadata as MerchantsMerchantIdMeta } from '../_views/merchants-merchantId.js';
import MerchantsMerchantIdWebsitesWebsiteId, {
	metadata as MerchantsMerchantIdWebsitesWebsiteIdMeta,
} from '../_views/merchants-merchantId-websites-websiteId.js';
import ProductsProductId, { metadata as ProductsProductIdMeta } from '../_views/products-productId.js';

export const dynamic = 'force-dynamic';

/** Path patterns under /admin (`:name` captures a segment into `params`), views, metadata and whether they need a session. */
const VIEWS = /** @type {Array<[string[], (props: any) => any, import('next').Metadata, boolean]>} */ ([
	[[], Home, HomeMeta, true],
	[['account'], Account, AccountMeta, true],
	[['activity'], Activity, ActivityMeta, true],
	[['admins'], Admins, AdminsMeta, true],
	[['finance'], Finance, FinanceMeta, true],
	[['login'], Login, LoginMeta, false],
	[['merchants'], Merchants, MerchantsMeta, true],
	[['products'], Products, ProductsMeta, true],
	[['settings'], Settings, SettingsMeta, true],
	[['merchants', ':merchantId'], MerchantsMerchantId, MerchantsMerchantIdMeta, true],
	[
		['merchants', ':merchantId', 'websites', ':websiteId'],
		MerchantsMerchantIdWebsitesWebsiteId,
		MerchantsMerchantIdWebsitesWebsiteIdMeta,
		true,
	],
	[['products', ':productId'], ProductsProductId, ProductsProductIdMeta, true],
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
