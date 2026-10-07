/**
 * Server render of every admin page against a live in-process Portal: the first Owner turns two-step on, seeds a
 * merchant with a website, connects two fake products (one inactive), adds a product to the website and credits; then
 * every admin page renders without errors or React warnings, and each role (Owner, Support, Finance) sees only the menu
 * entries, tabs and actions it can use (PLAN 0.2, 0.6).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { sessionCookieName, totpCode } from '../../src/infra/auth.js';
import { closeMongoClients } from '../../src/infra/db.js';
import * as admin from '../../src/console/admin/loaders.js';
import { adminApi, adminRoutes, query } from '../../src/console/admin/paths.js';
import { AdminShell, adminSections } from '../../src/console/admin/views/shell.js';
import { MerchantView, MerchantsView } from '../../src/console/admin/views/merchants.js';
import { OverviewView, dayBars } from '../../src/console/admin/views/overview.js';
import { ActivityView } from '../../src/console/admin/views/activity.js';
import { AdminsView } from '../../src/console/admin/views/admins.js';
import { MyAccountView } from '../../src/console/admin/views/account.js';
import { SettingsView } from '../../src/console/admin/views/settings.js';
import { FinanceView, MerchantCredits } from '../../src/console/admin/views/finance.js';
import { ProductView, ProductsView, featureNames } from '../../src/console/admin/views/products.js';
import { AdminWebsiteView } from '../../src/console/admin/views/website.js';
import { adminCan } from '../../src/console/admin/views/common.js';
import { startMongo } from '../helpers.js';
import { createWorld } from './merchant-harness.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
});
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

/**
 * Server-render a view, failing on render errors and React warnings.
 * @param {import('react').ReactElement} element
 */
const ssr = (element) => {
	const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	try {
		const html = renderToString(element);
		expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([]);
		return html;
	} finally {
		errors.mockRestore();
	}
};

/** @param {string} html */
const text = (html) =>
	html
		.replace(/<[^>]+>/g, ' ')
		.replace(/&#x27;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/\s+/g, ' ');

/**
 * A world with a merchant, a website with Notes on it (one feature on), an inactive second product and credits.
 * @param {string} name database name
 */
const seed = async (name) => {
	const world = await createWorld({ db: mongo.db(name) });
	const { b: merchant, merchantId } = await world.signup('owner@shop.test', 'Shop & Co');
	const site = await world.addWebsite(merchantId, 'shop.example.com');
	const notes = await world.connect();
	await world.connect({ id: 'chatty', name: 'Chatty', widgets: false }, { active: false });
	await world.addProduct(merchantId, site.websiteId, 'notes');
	await world.credit(merchantId, 250_000, 'bank-1');
	await world.switchFeatures(notes, site.websiteId, ['notes']);
	return { world, merchant, merchantId, websiteId: /** @type {string} */ (site.websiteId) };
};

describe('admin console smoke', () => {
	it('server-renders every admin page for the Owner', async () => {
		const { world, merchant, merchantId, websiteId } = await seed('admin_smoke');
		try {
			const { ownerBrowser } = world;
			// two-step on for the Owner (My account shows the recovery codes left)
			const started = await ownerBrowser.api.post('/v1/me/two-step/start');
			const confirmed = await ownerBrowser.api.post('/v1/me/two-step/confirm', {
				code: totpCode(started.ok ? started.data.secret : '', Date.now()),
			});
			expect(confirmed.ok && confirmed.data.recoveryCodes.length).toBe(10);
			// the admin cookie is separate from merchant sessions
			expect([...ownerBrowser.jar.keys()]).toEqual([sessionCookieName('admin', true)]);
			const session = await admin.loadAdminSession(ownerBrowser.api);
			if (!session.ok) throw new Error('no admin session');
			const owner = session.admin;
			expect((await ownerBrowser.api.post(adminApi.admins(), { email: 'help@ss.test', role: 'support' })).ok).toBe(true);

			// ------------------------------------------------------------------ frame
			const shell = text(
				ssr(
					<AdminShell admin={owner} branding={{ name: 'Single Solution', accent: '#4f46e5' }}>
						<p>child</p>
					</AdminShell>,
				),
			);
			for (const item of ['Overview', 'Merchants', 'Products', 'Credits and billing', 'Admins', 'Settings', 'Activity'])
				expect(shell).toContain(item);
			expect(shell).toContain('My account');
			expect(shell).toContain('child');
			const pending = text(
				ssr(
					<AdminShell admin={owner} twoStepRequired>
						<p>hidden</p>
					</AdminShell>,
				),
			);
			expect(pending).toContain('Set up two-step sign-in');
			expect(pending).not.toContain('hidden');

			// ------------------------------------------------------------------ Overview: per-product numbers
			const overview = await admin.loadOverview(ownerBrowser.api);
			const overviewHtml = text(ssr(<OverviewView {...overview} admin={owner} />));
			expect(overviewHtml).toContain('E-mail sending is not set up');
			expect(overviewHtml).toContain('Notes');
			expect(overviewHtml).toContain('1 website');
			expect(overviewHtml).toContain('earned this month (UTC)');
			expect(overviewHtml).toContain('Chatty');
			expect(overviewHtml).toContain('0 websites');
			expect(overviewHtml).toContain('Inactive');
			expect(overviewHtml).toContain('Credits earned per UTC day (last 30 days)');
			expect(overviewHtml).toContain('Recent activity');
			expect(text(ssr(<OverviewView ok overview={{ products: [] }} admin={owner} />))).toContain('No products connected yet.');

			// ------------------------------------------------------------------ merchants and the merchant page
			expect(text(ssr(<MerchantsView {...await admin.loadMerchants(ownerBrowser.api, {})} admin={owner} />))).toContain(
				'Shop & Co',
			);
			const byDomain = await admin.loadMerchants(ownerBrowser.api, { q: 'shop.example.com' });
			expect(byDomain.ok && byDomain.page.items.map((m) => m.merchantId)).toEqual([merchantId]);
			const detail = await admin.loadMerchant(ownerBrowser.api, merchantId);
			const detailHtml = text(ssr(<MerchantView {...detail} admin={owner} />));
			expect(detailHtml).toContain('shop.example.com');
			expect(detailHtml).toContain('Notes ( Active )');
			expect(detailHtml).toContain('250 credits');
			expect(detailHtml).toContain('Add website');
			for (const tab of ['details', 'activity', 'credits'])
				expect(text(ssr(<MerchantView {...detail} admin={owner} tab={tab} />))).toMatch(
					/Owner name|Merchant created|250 credits/,
				);

			// ------------------------------------------------------------------ the website page (every tab)
			for (const tab of ['products', 'install', 'usage']) {
				const page = await admin.loadWebsite(ownerBrowser.api, { merchantId, websiteId, tab, admin: owner });
				const raw = ssr(<AdminWebsiteView {...page} admin={owner} />);
				const html = text(raw);
				expect(html).toContain('shop.example.com');
				expect(html).toContain('Shop & Co');
				expect(raw).toContain('aria-label="Website actions"');
				if (tab === 'products') {
					expect(html).toContain('Add product');
					expect(raw).toContain('aria-label="Actions for Notes"');
				}
				expect(html).toContain('Install and tokens');
			}
			const page = await admin.loadWebsite(ownerBrowser.api, { merchantId, websiteId, admin: owner });
			if (!page.ok) throw new Error('website page');
			// Add product lists only active connected products
			expect(page.addable).toEqual([{ productId: 'notes', name: 'Notes' }]);
			expect(page.tokens?.map((t) => t.productId)).toEqual(['notes']);
			const missingSite = await admin.loadWebsite(ownerBrowser.api, {
				merchantId,
				websiteId: 'web_0000000000000000000000000z',
				admin: owner,
			});
			expect(missingSite.ok).toBe(false);
			expect(text(ssr(<AdminWebsiteView {...missingSite} admin={owner} />))).toContain('Not found');

			// ------------------------------------------------------------------ Products
			const products = await admin.loadProducts(ownerBrowser.api, { status: 'bogus' });
			expect(products.ok && products.filter).toEqual({ status: null });
			const productsHtml = text(ssr(<ProductsView {...products} admin={owner} />));
			expect(productsHtml).toContain('Add product');
			expect(productsHtml).toContain('Notes');
			expect(productsHtml).toContain('Chatty');
			expect(productsHtml).toContain('Earned this month (UTC)');
			const active = await admin.loadProducts(ownerBrowser.api, { status: 'active' });
			expect(active.ok && active.items.map((p) => p.productId)).toEqual(['notes']);
			const product = await admin.loadProduct(ownerBrowser.api, 'notes', { tab: 'websites' });
			if (!product.ok) throw new Error('product');
			expect(product.tab).toBe('websites');
			expect(product.websites.items).toMatchObject([
				{ domain: 'shop.example.com', merchantName: 'Shop & Co', featuresOn: ['notes'] },
			]);
			const productHtml = text(ssr(<ProductView {...product} admin={owner} />));
			for (const word of ['Open as admin', 'Set inactive', 'Reconnect', 'Connected', 'Overview', 'Websites', 'Shop & Co'])
				expect(productHtml).toContain(word);
			const overviewTab = await admin.loadProduct(ownerBrowser.api, 'chatty');
			if (!overviewTab.ok) throw new Error('product');
			expect(overviewTab.tab).toBe('overview');
			const chattyHtml = text(ssr(<ProductView {...overviewTab} admin={owner} />));
			expect(chattyHtml).toContain('Set active');
			expect(chattyHtml).toContain('Credits earned this month (UTC)');
			expect(chattyHtml).toContain('Websites using it');
			const unknown = await admin.loadProduct(ownerBrowser.api, 'nothing-here');
			expect(unknown.ok).toBe(false);
			expect(text(ssr(<ProductView {...unknown} admin={owner} />))).toContain('Products');

			// ------------------------------------------------------------------ the other pages
			const activity = await admin.loadActivity(ownerBrowser.api, { merchantId, adminId: '<bad>', from: 'x' });
			expect(activity.ok && activity.filter).toEqual({ merchantId, adminId: null, from: null, to: null });
			expect(text(ssr(<ActivityView {...activity} />))).toContain('Product added');
			const adminsHtml = text(ssr(<AdminsView {...await admin.loadAdmins(ownerBrowser.api, owner)} />));
			expect(adminsHtml).toContain('help@ss.test');
			expect(adminsHtml).toContain('Invited');
			expect(text(ssr(<SettingsView {...await admin.loadSettings(ownerBrowser.api)} />))).toContain('SMTP host');
			expect(text(ssr(<MyAccountView {...await admin.loadMyAccount(ownerBrowser.api)} />))).toContain(
				'10 recovery codes left',
			);
			const finance = await admin.loadBilling(ownerBrowser.api, { merchantId, by: 'merchant', method: 'Bank transfer' });
			expect(finance).toMatchObject({ ok: true, filter: { merchantId, by: 'merchant' } });
			expect(text(ssr(<FinanceView {...finance} admin={owner} />))).toContain('Credits and billing');
			const creditsHtml = text(
				ssr(
					<MerchantCredits
						billing={detail.ok ? detail.billing : null}
						receipts={detail.ok ? detail.receipts : []}
						dayCharges={[
							{
								day: '2026-10-01',
								websiteId,
								productId: 'notes',
								domain: 'shop.example.com',
								product: 'Notes',
								lines: [{ feature: 'notes', hours: 3 }],
								credits: 3000,
							},
						]}
					/>,
				),
			);
			expect(creditsHtml).toContain('bank-1');
			expect(creditsHtml).toContain('PKR 1,000');
			expect(creditsHtml).toContain('notes 3 h');

			// ------------------------------------------------------------------ failures render friendly states
			const missing = await admin.loadMerchant(ownerBrowser.api, 'mer_0000000000000000000000000z');
			expect(missing).toMatchObject({ ok: false, status: 404 });
			for (const View of [
				MerchantView,
				MerchantsView,
				ProductsView,
				FinanceView,
				ActivityView,
				AdminsView,
				SettingsView,
				MyAccountView,
				OverviewView,
			])
				expect(text(ssr(<View {...missing} admin={owner} />))).toMatch(/not|could not|found/i);
			// a merchant session is not an admin session
			expect(await admin.loadAdminSession(merchant.api)).toMatchObject({ ok: false, status: 403, merchant: true });
		} finally {
			await world.close();
		}
	});

	it('limits menus, tabs and actions to the admin role', async () => {
		const { world, merchantId, websiteId } = await seed('admin_roles');
		try {
			const { admin: support, b: supportBrowser } = await world.adminOf('support');
			const { admin: finance, b: financeBrowser } = await world.adminOf('finance');
			/** @param {any} who */
			const menu = (who) => adminSections(who, '/admin/merchants').flatMap((s) => s.items.map((i) => i.label));
			expect(menu(world.owner)).toEqual([
				'Overview',
				'Merchants',
				'Products',
				'Credits and billing',
				'Admins',
				'Settings',
				'Activity',
			]);
			// Products is an Owner menu (0.8.2); Support may still read the product list for Add product
			expect(menu(support)).toEqual(['Overview', 'Merchants', 'Credits and billing', 'Activity']);
			expect(menu(finance)).toEqual(['Overview', 'Merchants', 'Credits and billing', 'Activity']);
			expect(
				adminSections(world.owner, '/admin/products/notes')
					.flatMap((s) => s.items)
					.find((i) => i.current)?.label,
			).toBe('Products');

			// Support: the website page with every admin action and Install and tokens; Products read-only
			const supportPage = await admin.loadWebsite(supportBrowser.api, { merchantId, websiteId, admin: support });
			expect(supportPage.ok && supportPage.tokens?.length).toBe(1);
			const supportHtml = ssr(<AdminWebsiteView {...supportPage} admin={support} />);
			for (const word of ['Add product', 'aria-label="Website actions"', 'Install and tokens', 'Open Notes'])
				expect(supportHtml).toContain(word);
			const supportProducts = text(ssr(<ProductsView {...await admin.loadProducts(supportBrowser.api)} admin={support} />));
			expect(supportProducts).toContain('Notes');
			expect(supportProducts).not.toContain('Add product');
			const supportProduct = text(
				ssr(<ProductView {...await admin.loadProduct(supportBrowser.api, 'notes')} admin={support} />),
			);
			expect(supportProduct).toContain('Notes');
			for (const word of ['Open as admin', 'Set inactive', 'Reconnect']) expect(supportProduct).not.toContain(word);

			// Finance: products and usage only; no Install and tokens, no Open, no admin actions
			const financePage = await admin.loadWebsite(financeBrowser.api, {
				merchantId,
				websiteId,
				tab: 'install',
				admin: finance,
			});
			if (!financePage.ok) throw new Error('finance website page');
			expect(financePage.tokens).toBeNull();
			expect(financePage.addable).toBeNull();
			const financeHtml = ssr(<AdminWebsiteView {...financePage} admin={finance} />);
			expect(financeHtml).toContain('Notes');
			expect(financeHtml).toContain('Usage');
			for (const word of ['Install and tokens', 'Add product', 'Website actions', 'Open', 'Server token', 'Browser token'])
				expect(financeHtml).not.toContain(word);
			const financeMerchant = text(
				ssr(<MerchantView {...await admin.loadMerchant(financeBrowser.api, merchantId)} admin={finance} />),
			);
			expect(financeMerchant).toContain('shop.example.com');
			expect(financeMerchant).not.toContain('Add website');
			// the API refuses what the screens hide
			expect((await financeBrowser.api.get(`/v1/merchants/${merchantId}/websites/${websiteId}/tokens`)).status).toBe(403);
			expect((await financeBrowser.api.post('/v1/admin/products/notes/launch', { websiteId })).status).toBe(403);
			const forbidden = await admin.loadProducts(financeBrowser.api);
			expect(forbidden).toMatchObject({ ok: false, status: 403 });
			expect(text(ssr(<ProductsView {...forbidden} admin={finance} />))).toContain('Not permitted');
			expect(adminCan(support, 'dashboards.open')).toBe(true);
			expect(adminCan(finance, 'tokens.manage')).toBe(false);
			expect(adminCan(null, 'merchants.read')).toBe(false);
		} finally {
			await world.close();
		}
	});

	it('pure helpers of the admin views', () => {
		expect(query({ a: 'x', b: null, c: '', d: 2 })).toBe('?a=x&d=2');
		expect(query({})).toBe('');
		expect(adminRoutes.activity({ merchantId: 'mer_1' })).toBe('/admin/activity?merchantId=mer_1');
		expect(adminRoutes.login('/admin/x')).toBe('/login?next=%2Fadmin%2Fx');
		expect(adminRoutes.merchant('mer_1', 'details')).toBe('/admin/merchants/mer_1?tab=details');
		expect(adminRoutes.website('mer_1', 'web_1', 'usage')).toBe('/admin/merchants/mer_1/websites/web_1?tab=usage');
		expect(adminRoutes.website('mer_1', 'web_1')).toBe('/admin/merchants/mer_1/websites/web_1');
		expect(adminRoutes.product('notes', 'websites')).toBe('/admin/products/notes?tab=websites');
		expect(adminRoutes.product('notes', 'overview')).toBe('/admin/products/notes');
		expect(adminRoutes.products({ status: 'active' })).toBe('/admin/products?status=active');
		expect(adminApi.productWebsites('notes', 'abc')).toBe('/v1/admin/products/notes/websites?cursor=abc');
		expect(adminApi.launch('notes')).toBe('/v1/admin/products/notes/launch');
		expect(dayBars([{ day: '2026-10-01', amount: 1500 }])).toEqual([{ label: '10-01', value: 1.5, hint: '2026-10-01' }]);
		expect(dayBars(undefined)).toEqual([]);
		const features = [{ key: 'notes', name: 'Notes' }];
		expect(featureNames(features, ['notes', 'gone'])).toBe('Notes, gone');
		expect(featureNames(features, [])).toBe('None');
		expect(featureNames(undefined, ['x'])).toBe('x');
	});
});
