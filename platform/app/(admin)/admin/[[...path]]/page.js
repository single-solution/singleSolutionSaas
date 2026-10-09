/**
 * The admin console: one page (one server function) renders the view of every path; any other path is a 404. The
 * console frame is the layout above (it stays on screen across navigations) and `loading.js` the skeleton shown at
 * once while a page is on the way. Pages fade and slide in (`PageTransition`); list-and-detail screens keep their
 * list in place and animate the detail only. Views keep the `params` / `searchParams` / `metadata` they had as pages.
 */
import { notFound } from 'next/navigation';
import { PageTransition } from '@ss/ui';
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
import AdminsAdminId, { metadata as AdminsAdminIdMeta } from '../_views/admins-adminId.js';
import ProductsProductId, { metadata as ProductsProductIdMeta } from '../_views/products-productId.js';

export const dynamic = 'force-dynamic';

/**
 * Path patterns under /admin (`:name` captures a segment into `params`), views, metadata and the kind of view: a
 * `page`, a list-and-detail `screen` (it animates its detail itself) or `public` (no session, no title suffix).
 * @typedef {'page' | 'screen' | 'public'} ViewKind
 */
const VIEWS = /** @type {Array<[string[], (props: any) => any, import('next').Metadata, ViewKind]>} */ ([
	[[], Home, HomeMeta, 'page'],
	[['account'], Account, AccountMeta, 'page'],
	[['activity'], Activity, ActivityMeta, 'page'],
	[['admins'], Admins, AdminsMeta, 'screen'],
	[['finance'], Finance, FinanceMeta, 'page'],
	[['login'], Login, LoginMeta, 'public'],
	[['merchants'], Merchants, MerchantsMeta, 'screen'],
	[['products'], Products, ProductsMeta, 'screen'],
	[['settings'], Settings, SettingsMeta, 'page'],
	[['merchants', ':merchantId'], MerchantsMerchantId, MerchantsMerchantIdMeta, 'screen'],
	[['admins', ':adminId'], AdminsAdminId, AdminsAdminIdMeta, 'screen'],
	[['products', ':productId'], ProductsProductId, ProductsProductIdMeta, 'screen'],
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
	return found
		? found.kind !== 'public' && typeof found.metadata.title === 'string'
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
	return found.kind === 'page' ? <PageTransition>{view}</PageTransition> : view;
}
