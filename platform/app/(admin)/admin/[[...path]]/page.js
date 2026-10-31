/**
 * The admin console: one page (one server function) renders the view of every path; any other path is a 404. The
 * console frame is the layout above (it stays on screen across navigations) and `loading.js` the skeleton shown at
 * once while a page is on the way. Pages fade and slide in (`PageTransition`); a `Page` screen animates its
 * body only. Each view exports its `metadata`.
 */
import { notFound, redirect } from 'next/navigation.js';
import { PageTransition } from '@ss/ui';
import {
	loadActivity,
	loadAdmin,
	loadAdmins,
	loadAdminWebsite,
	loadBilling,
	loadMerchant,
	loadMerchants,
	loadMyAccount,
	loadOverview,
	loadProduct,
	loadProducts,
	loadSettings,
} from '../../../../src/console/admin/loaders.js';
import {
	ADMIN_PARTS,
	FINANCE_PARTS,
	MY_ACCOUNT_PARTS,
	PRODUCT_PARTS,
	SETTINGS_PARTS,
	adminRoutes,
} from '../../../../src/console/admin/paths.js';
import { LEGACY_PEER_REDIRECTS, websitePartOf } from '../../../../src/console/website-parts.js';
import { adminContext, one } from '../../_lib/server.js';
import { MyAccountView } from '../../../../src/console/admin/views/account.js';
import { ActivityView } from '../../../../src/console/admin/views/activity.js';
import { AdminsView } from '../../../../src/console/admin/views/admins.js';
import { FinanceView } from '../../../../src/console/admin/views/finance.js';
import { MerchantsView } from '../../../../src/console/admin/views/merchants.js';
import { OverviewView } from '../../../../src/console/admin/views/overview.js';
import { ProductsView } from '../../../../src/console/admin/views/products.js';
import { SettingsView } from '../../../../src/console/admin/views/settings.js';
import { AdminWebsiteView } from '../../../../src/console/admin/views/website.js';

export const dynamic = 'force-dynamic';

async function HomePage() {
	const { api, admin } = await adminContext('/admin');
	return <OverviewView {...await loadOverview(api)} admin={admin} />;
}

async function MyAccountPage() {
	const { api } = await adminContext('/admin/account');
	return <MyAccountView {...await loadMyAccount(api)} part="profile" />;
}

/** @param {{ params: Promise<{ part: string }> }} props */
async function MyAccountPartPage({ params }) {
	const { part } = await params;
	if (!MY_ACCOUNT_PARTS.includes(part) || part === 'profile') notFound();
	redirect(adminRoutes.accountPart(part));
}

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
async function ActivityPage({ searchParams }) {
	const q = await searchParams;
	const { api, admin } = await adminContext('/admin/activity');
	const filter = { merchantId: one(q.merchantId), adminId: one(q.adminId), from: one(q.from), to: one(q.to) };
	return <ActivityView key={JSON.stringify(filter)} {...await loadActivity(api, filter, admin)} />;
}

async function AdminsPage() {
	const { api, admin } = await adminContext('/admin/admins');
	const list = await loadAdmins(api, admin);
	const firstId = list.ok && list.items?.[0]?.adminId ? String(list.items[0].adminId) : null;
	const detail = firstId ? await loadAdmin(api, admin, firstId) : null;
	return <AdminsView {...list} detail={detail} fromList admin={admin} />;
}

/** @param {{ params: Promise<{ adminId: string }> }} props */
async function AdminPage({ params }) {
	const { adminId } = await params;
	const { api, admin } = await adminContext(`/admin/admins/${adminId}`);
	return <AdminsView {...await loadAdmin(api, admin, adminId)} selectedId={adminId} admin={admin} />;
}

/** @param {{ params: Promise<{ adminId: string, part: string }> }} props */
async function AdminPartPage({ params }) {
	const { adminId, part } = await params;
	if (!ADMIN_PARTS.includes(part)) notFound();
	redirect(`/admin/admins/${adminId}#${part}`);
}

/** @param {{ part?: string, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
async function FinanceScreen({ part = 'attention', searchParams }) {
	const q = await searchParams;
	const { api, admin } = await adminContext(part === 'attention' ? '/admin/finance' : `/admin/finance/${part}`);
	return (
		<FinanceView
			{...await loadBilling(api, {
				merchantId: one(q.merchantId),
				from: one(q.from),
				to: one(q.to),
				method: one(q.method),
				by: one(q.by),
			})}
			part={part}
			admin={admin}
		/>
	);
}

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
function FinancePage({ searchParams }) {
	return <FinanceScreen searchParams={searchParams} />;
}

/** @param {{ params: Promise<{ part: string }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
async function FinancePartPage({ params, searchParams }) {
	const { part } = await params;
	if (!FINANCE_PARTS.includes(/** @type {any} */ (part)) || part === 'attention') notFound();
	return <FinanceScreen part={part} searchParams={searchParams} />;
}

function AdminLoginPage() {
	redirect('/login');
}

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
async function MerchantsPage({ searchParams }) {
	const q = await searchParams;
	const { api, admin } = await adminContext('/admin/merchants');
	const list = await loadMerchants(api, { status: one(q.status), q: one(q.q), cursor: one(q.cursor) });
	const firstId = list.ok && list.page.items[0]?.merchantId ? String(list.page.items[0].merchantId) : null;
	const detail = firstId ? await loadMerchant(api, firstId, admin) : null;
	return <MerchantsView list={list} detail={detail} fromList admin={admin} />;
}

/** @param {{ params: Promise<{ merchantId: string }>, searchParams?: Promise<Record<string, string | string[] | undefined>> }} props */
async function MerchantPage({ params, searchParams }) {
	const { merchantId } = await params;
	const q = searchParams ? await searchParams : {};
	const { api, admin } = await adminContext(`/admin/merchants/${merchantId}`);
	const [list, detail] = await Promise.all([
		loadMerchants(api, { status: one(q.status), q: one(q.q), cursor: one(q.cursor) }),
		loadMerchant(api, merchantId, admin),
	]);
	return <MerchantsView list={list} detail={detail} merchantId={merchantId} admin={admin} />;
}

const MERCHANT_PARTS = ['websites', 'credits', 'details', 'activity'];

/** @param {{ params: Promise<{ merchantId: string, part: string }> }} props */
async function MerchantPartPage({ params }) {
	const { merchantId, part } = await params;
	if (!MERCHANT_PARTS.includes(part)) notFound();
	redirect(adminRoutes.merchantPart(merchantId, part));
}

/** @param {{ params: Promise<{ merchantId: string, websiteId: string, part?: string, sub?: string }> }} props */
async function MerchantWebsitePage({ params }) {
	const { merchantId, websiteId, part, sub } = await params;
	if (part && LEGACY_PEER_REDIRECTS.includes(/** @type {any} */ (part))) {
		redirect(adminRoutes.website(merchantId, websiteId));
	}
	const path = websitePartOf(part, sub);
	const { api, admin } = await adminContext(adminRoutes.websitePart(merchantId, websiteId, path));
	return <AdminWebsiteView detail={await loadAdminWebsite(api, merchantId, websiteId, path, admin)} admin={admin} />;
}

/** @param {{ searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
async function ProductsPage({ searchParams }) {
	const q = await searchParams;
	const status = one(q.status);
	const { api, admin } = await adminContext('/admin/products');
	const list = await loadProducts(api, { status });
	const firstId = list.ok && list.items?.[0]?.productId ? String(list.items[0].productId) : null;
	const detail = firstId ? await loadProduct(api, firstId) : null;
	return <ProductsView {...list} detail={detail} fromList admin={admin} />;
}

/** @param {{ params: Promise<{ productId: string }>, searchParams?: Promise<Record<string, string | string[] | undefined>> }} props */
async function ProductPage({ params, searchParams }) {
	const { productId } = await params;
	const q = searchParams ? await searchParams : {};
	const status = one(q.status);
	const { api, admin } = await adminContext(`/admin/products/${productId}`);
	const [list, detail] = await Promise.all([loadProducts(api, { status }), loadProduct(api, productId)]);
	return <ProductsView {...list} detail={detail} productId={productId} admin={admin} />;
}

/** @param {{ params: Promise<{ productId: string, part: string }> }} props */
async function ProductPartPage({ params }) {
	const { productId, part } = await params;
	if (!PRODUCT_PARTS.includes(part)) notFound();
	redirect(`/admin/products/${productId}#${part}`);
}

async function SettingsPage() {
	const { api } = await adminContext('/admin/settings');
	return <SettingsView {...await loadSettings(api)} />;
}

/** @param {{ params: Promise<{ part: string }> }} props */
export async function SettingsPartPage({ params }) {
	const { part } = await params;
	if (!SETTINGS_PARTS.includes(part)) notFound();
	redirect(adminRoutes.settingsPart(part));
}
export { SettingsPartPage as SettingsPart };

/**
 * Path patterns under /admin (`:name` captures a segment into `params`), views, metadata and the kind of view: a
 * `page`, a `screen` (a `Page` of `@ss/ui`: it keeps its header in place and fades its own body in) or `public` (no
 * session, no title suffix).
 * @typedef {'page' | 'screen' | 'public'} ViewKind
 */
const VIEWS = /** @type {Array<[string[], (props: any) => any, import('next').Metadata, ViewKind]>} */ ([
	[[], HomePage, { title: 'Overview' }, 'screen'],
	[['account'], MyAccountPage, { title: 'My account' }, 'screen'],
	[['account', ':part'], MyAccountPartPage, { title: 'My account' }, 'screen'],
	[['activity'], ActivityPage, { title: 'Activity' }, 'screen'],
	[['admins'], AdminsPage, { title: 'Admins' }, 'screen'],
	[['finance'], FinancePage, { title: 'Credits and billing' }, 'screen'],
	[['finance', ':part'], FinancePartPage, { title: 'Credits and billing' }, 'screen'],
	[['login'], AdminLoginPage, { title: 'Sign in' }, 'public'],
	[['merchants'], MerchantsPage, { title: 'Merchants' }, 'screen'],
	[['products'], ProductsPage, { title: 'Products' }, 'screen'],
	[['settings'], SettingsPage, { title: 'Settings' }, 'screen'],
	[['settings', ':part'], SettingsPartPage, { title: 'Settings' }, 'screen'],
	[['merchants', ':merchantId'], MerchantPage, { title: 'Merchant' }, 'screen'],
	[['admins', ':adminId'], AdminPage, { title: 'Admin' }, 'screen'],
	[['admins', ':adminId', ':part'], AdminPartPage, { title: 'Admin' }, 'screen'],
	[['products', ':productId'], ProductPage, { title: 'Product' }, 'screen'],
	[['products', ':productId', ':part'], ProductPartPage, { title: 'Product' }, 'screen'],
	[['merchants', ':merchantId', ':part'], MerchantPartPage, { title: 'Merchant' }, 'screen'],
	[['merchants', ':merchantId', 'websites', ':websiteId'], MerchantWebsitePage, { title: 'Website' }, 'screen'],
	[['merchants', ':merchantId', 'websites', ':websiteId', ':part'], MerchantWebsitePage, { title: 'Website' }, 'screen'],
	[['merchants', ':merchantId', 'websites', ':websiteId', ':part', ':sub'], MerchantWebsitePage, { title: 'Website' }, 'screen'],
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
			? { ...found.metadata, title: `${found.metadata.title} · Admin` }
			: found.metadata
		: {};
}

/** @param {{ params: Promise<{ path?: string[] }>, searchParams: Promise<Record<string, string | string[] | undefined>> }} props */
export default async function Page({ params, searchParams }) {
	const found = resolve((await params).path ?? []);
	if (!found) return notFound();
	const View = found.view;
	const view = <View params={Promise.resolve(found.params)} searchParams={searchParams} />;
	return found.kind === 'page' ? <PageTransition>{view}</PageTransition> : view;
}
