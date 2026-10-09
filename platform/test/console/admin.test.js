/**
 * Server render of every admin page against a live in-process Portal: the first Owner turns two-step on, seeds a
 * merchant with a website, connects two fake products (one inactive), adds a product to the website and credits; then
 * every admin page renders without errors or React warnings (the list-and-detail screens with and without a selection),
 * and each role (Owner, Support, Finance) sees only the menu entries and actions it can use (PLAN 0.2, 0.6).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { sessionCookieName, totpCode } from '../../src/infra/auth.js';
import { closeMongoClients } from '../../src/infra/db.js';
import * as admin from '../../src/console/admin/loaders.js';
import { adminApi, adminRoutes, query } from '../../src/console/admin/paths.js';
import { AdminShell, adminSections } from '../../src/console/admin/views/shell.js';
import { MerchantsView } from '../../src/console/admin/views/merchants.js';
import { OverviewView, dayBars } from '../../src/console/admin/views/overview.js';
import { ActivityView } from '../../src/console/admin/views/activity.js';
import { AdminsView } from '../../src/console/admin/views/admins.js';
import { MyAccountView } from '../../src/console/admin/views/account.js';
import { SettingsView } from '../../src/console/admin/views/settings.js';
import { FinanceView, MerchantCredits } from '../../src/console/admin/views/finance.js';
import { ProductsView, featureNames } from '../../src/console/admin/views/products.js';
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
			expect(overviewHtml).toContain('No data for this period.'); // no charges yet: one line, not an empty chart
			expect(overviewHtml).toContain('Recent activity');
			expect(text(ssr(<OverviewView ok overview={{ products: [] }} admin={owner} />))).toContain('No products connected yet.');

			// ------------------------------------------------------------------ Merchants: the list, then a merchant selected
			const list = await admin.loadMerchants(ownerBrowser.api, {});
			// nothing in the URL: the first merchant opens by default (wide screens only; its row marked there, not current)
			const screen = await admin.loadMerchantsScreen(ownerBrowser.api, {}, owner);
			expect(screen).toMatchObject({ ok: true, auto: true, detail: { ok: true, merchant: { merchantId } } });
			const listRaw = ssr(<MerchantsView {...screen} admin={owner} />);
			const listHtml = text(listRaw);
			expect(listHtml).toContain('Shop & Co');
			expect(listHtml).toContain('250 credits'); // the balance on the row
			expect(listHtml).toContain('Add website'); // the merchant's page beside the list
			expect(listRaw).toContain('lg:bg-primary-soft');
			expect(listRaw).not.toContain('aria-current="page"');
			expect(listRaw).not.toContain('rotate-180'); // no Back link: phones show the list until a merchant is chosen
			const none = await admin.loadMerchantsScreen(ownerBrowser.api, { q: 'nobody-here' }, owner);
			expect(none).toMatchObject({ ok: true, page: { items: [] } });
			expect(none).not.toHaveProperty('detail');
			expect(text(ssr(<MerchantsView {...none} admin={owner} />))).toContain('No merchants found.');
			expect(
				text(
					ssr(<MerchantsView ok filter={{ q: null, status: null }} page={{ items: [], nextCursor: null }} admin={owner} />),
				),
			).toContain('Add a merchant to give them websites, products and credits.');
			const byDomain = await admin.loadMerchants(ownerBrowser.api, { q: 'shop.example.com' });
			expect(byDomain.ok && byDomain.page.items.map((m) => m.merchantId)).toEqual([merchantId]);
			const detail = await admin.loadMerchant(ownerBrowser.api, merchantId, owner);
			if (!detail.ok) throw new Error('merchant');
			// Add product lists only active connected products
			expect(detail.addable).toEqual([{ productId: 'notes', name: 'Notes' }]);
			const raw = ssr(<MerchantsView {...list} detail={detail} selectedId={merchantId} admin={owner} />);
			const detailHtml = text(raw);
			// one page: header with the actions, website cards, credits and activity — no tabs
			expect(raw).not.toContain('role="tab"');
			for (const word of [
				'shop.example.com',
				'Notes',
				'Active',
				'250 credits',
				'Add website',
				'Add credits',
				'Edit merchant',
				'Credit receipts',
				'Activity',
				'Install and tokens',
				'Usage',
			])
				expect(detailHtml).toContain(word);
			// the other actions (Suspend, setup link, two-step off, Delete) sit in the header's More menu
			expect(raw).toContain('aria-label="More actions for Shop &amp; Co"');
			expect(raw).not.toMatch(/>Suspend<\/button>/);
			expect(raw).toContain('aria-label="Add product to shop.example.com"');
			expect(raw).toContain('aria-label="Actions for shop.example.com"');
			expect(raw).toContain('aria-label="Actions for Notes"');
			expect(raw).toContain('aria-current="page"'); // the selected row
			const missingMerchant = await admin.loadMerchant(ownerBrowser.api, 'mer_0000000000000000000000000z', owner);
			expect(
				text(
					ssr(
						<MerchantsView {...list} detail={missingMerchant} selectedId="mer_0000000000000000000000000z" admin={owner} />,
					),
				),
			).toContain('Not found');

			// ------------------------------------------------------------------ Products: the list, then a product selected
			const products = await admin.loadProducts(ownerBrowser.api, { status: 'bogus' });
			expect(products.ok && products.filter).toEqual({ status: null });
			const productsHtml = text(ssr(<ProductsView {...products} admin={owner} />));
			expect(productsHtml).toContain('Add product');
			expect(productsHtml).toContain('Notes');
			expect(productsHtml).toContain('Chatty');
			expect(productsHtml).toContain('1 website');
			expect(productsHtml).toContain('No products connected yet.'); // no product in the props: the empty side
			const productsScreen = await admin.loadProductsScreen(ownerBrowser.api, {});
			// by name: Chatty opens by default
			expect(productsScreen).toMatchObject({ ok: true, auto: true, detail: { ok: true, product: { productId: 'chatty' } } });
			expect(products.ok && products.items.map((p) => p.name)).toEqual(['Chatty', 'Notes']);
			const screenRaw = ssr(<ProductsView {...productsScreen} admin={owner} />);
			expect(text(screenRaw)).toContain('Set active');
			expect(screenRaw).not.toContain('aria-current="page"');
			const noProducts = await admin.loadProductsScreen(ownerBrowser.api, { status: 'bogus' });
			expect(noProducts).toHaveProperty('ok', true);
			const active = await admin.loadProducts(ownerBrowser.api, { status: 'active' });
			expect(active.ok && active.items.map((p) => p.productId)).toEqual(['notes']);
			const product = await admin.loadProduct(ownerBrowser.api, 'notes');
			if (!product.ok) throw new Error('product');
			expect(product.websites.items).toMatchObject([
				{ domain: 'shop.example.com', merchantName: 'Shop & Co', featuresOn: ['notes'] },
			]);
			const productRaw = ssr(<ProductsView {...products} detail={product} selectedId="notes" admin={owner} />);
			const productHtml = text(productRaw);
			for (const word of ['Open as admin', 'Set inactive', 'Reconnect', 'Connected', 'Websites using it', 'Shop & Co'])
				expect(productHtml).toContain(word);
			// the address once (the subtitle), and one line instead of an empty 30-day chart
			expect(productHtml.split(String(product.product.baseUrl)).length - 1).toBe(1);
			expect(productHtml).toContain('No credits earned in the last 30 UTC days.');
			expect(productHtml).not.toContain('Credits earned per UTC day (last 30 days)');
			expect(productRaw).toContain('title="shop.example.com"');
			expect(productRaw).not.toContain('role="tab"');
			expect(productRaw).toContain(`href="/admin/merchants/${merchantId}#website-${websiteId}"`);
			const chatty = await admin.loadProduct(ownerBrowser.api, 'chatty');
			const chattyHtml = text(ssr(<ProductsView {...products} detail={chatty} selectedId="chatty" admin={owner} />));
			expect(chattyHtml).toContain('Set active');
			expect(chattyHtml).toContain('Credits earned this month (UTC)');
			const unknown = await admin.loadProduct(ownerBrowser.api, 'nothing-here');
			expect(unknown.ok).toBe(false);
			expect(text(ssr(<ProductsView {...products} detail={unknown} selectedId="nothing-here" admin={owner} />))).toContain(
				'Not found',
			);

			// ------------------------------------------------------------------ the other pages
			const activity = await admin.loadActivity(ownerBrowser.api, { merchantId, adminId: '<bad>', from: 'x' });
			expect(activity.ok && activity.filter).toEqual({ merchantId, adminId: null, from: null, to: null });
			expect(text(ssr(<ActivityView {...activity} />))).toContain('Product added');
			const admins = await admin.loadAdmins(ownerBrowser.api, owner);
			const adminsHtml = text(ssr(<AdminsView {...admins} />));
			expect(adminsHtml).toContain('help@ss.test');
			// the first admin opens by default on wide screens
			expect(adminsHtml).toContain('Two-step');
			const invited = admins.ok ? admins.items.find((a) => a.email === 'help@ss.test') : null;
			const invitedRaw = ssr(<AdminsView {...admins} selectedId={invited?.adminId} />);
			const invitedHtml = text(invitedRaw);
			for (const word of ['Invited', 'Resend invite', 'Copy invite link']) expect(invitedHtml).toContain(word);
			// Correct invite e-mail, Change role and Remove sit in the More menu
			expect(invitedRaw).toContain('aria-label="More actions for help@ss.test"');
			expect(invitedHtml).not.toContain('Change role');
			const meHtml = text(ssr(<AdminsView {...admins} selectedId={owner.adminId} />));
			expect(meHtml).toContain('you');
			expect(meHtml).not.toContain('Change role');
			expect(text(ssr(<AdminsView {...admins} selectedId="adm_00000000000000000000z" />))).toContain(
				'This admin does not exist or was removed.',
			);
			// Settings: one page, every section a card with its own Save (no tabs)
			const settingsRaw = ssr(<SettingsView {...await admin.loadSettings(ownerBrowser.api)} />);
			for (const title of ['E-mail sending', 'Branding', 'Support contact', 'Security', 'Billing rules'])
				expect(settingsRaw).toContain(`aria-label="${title}"`);
			expect(text(settingsRaw)).toContain('SMTP host');
			expect(text(settingsRaw)).toContain('Grace period (days)');
			expect(settingsRaw).not.toContain('role="tab"');
			expect(text(settingsRaw).match(/ Save /g)).toHaveLength(5);
			expect(text(ssr(<MyAccountView {...await admin.loadMyAccount(ownerBrowser.api)} />))).toContain(
				'10 recovery codes left',
			);
			const finance = await admin.loadBilling(ownerBrowser.api, { merchantId, by: 'merchant', method: 'Bank transfer' });
			expect(finance).toMatchObject({ ok: true, filter: { merchantId, by: 'merchant' } });
			const financeRaw = ssr(<FinanceView {...finance} admin={owner} />);
			// one page: needs attention, receipts and charges (no tabs); the charges switch keeps the receipt filter
			for (const word of ['Credits and billing', 'Needs attention', 'Receipts', 'Charges', 'By merchant'])
				expect(text(financeRaw)).toContain(word);
			expect(financeRaw).not.toContain('role="tab"');
			expect(financeRaw).toContain('name="by" value="merchant"');
			expect(financeRaw).toContain(
				`/admin/finance?merchantId=${merchantId}&amp;method=Bank+transfer&amp;by=day#billing-charges`,
			);
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
			const missing = await admin.loadMerchant(ownerBrowser.api, 'mer_0000000000000000000000000z', owner);
			expect(missing).toMatchObject({ ok: false, status: 404 });
			for (const View of [
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

	it('limits menus and actions to the admin role', async () => {
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

			// Support: the website cards with every admin action and Install and tokens; Products read-only
			const supportList = await admin.loadMerchants(supportBrowser.api, {});
			const supportDetail = await admin.loadMerchant(supportBrowser.api, merchantId, support);
			expect(supportDetail.ok && supportDetail.addable).toEqual([{ productId: 'notes', name: 'Notes' }]);
			const supportHtml = ssr(
				<MerchantsView {...supportList} detail={supportDetail} selectedId={merchantId} admin={support} />,
			);
			for (const word of [
				'Add product to shop.example.com',
				'aria-label="Actions for shop.example.com"',
				'Install and tokens',
				'Open Notes',
				'Add website',
			])
				expect(supportHtml).toContain(word);
			expect(supportHtml).not.toContain('Add credits');
			const supportProducts = await admin.loadProducts(supportBrowser.api);
			const supportProductsHtml = text(ssr(<ProductsView {...supportProducts} admin={support} />));
			expect(supportProductsHtml).toContain('Notes');
			expect(supportProductsHtml).not.toContain('Add product');
			const supportProduct = text(
				ssr(
					<ProductsView
						{...supportProducts}
						detail={await admin.loadProduct(supportBrowser.api, 'notes')}
						selectedId="notes"
						admin={support}
					/>,
				),
			);
			expect(supportProduct).toContain('Websites using it');
			for (const word of ['Open as admin', 'Set inactive', 'Reconnect']) expect(supportProduct).not.toContain(word);

			// Finance: products and usage only; no Install and tokens, no Open, no admin actions
			const financeDetail = await admin.loadMerchant(financeBrowser.api, merchantId, finance);
			if (!financeDetail.ok) throw new Error('finance merchant');
			expect(financeDetail.addable).toBeNull();
			const financeHtml = ssr(
				<MerchantsView
					{...await admin.loadMerchants(financeBrowser.api, {})}
					detail={financeDetail}
					selectedId={merchantId}
					admin={finance}
				/>,
			);
			expect(financeHtml).toContain('Notes');
			expect(financeHtml).toContain('Usage');
			expect(financeHtml).toContain('Add credits');
			for (const word of [
				'Install and tokens',
				'Add product',
				'Actions for shop.example.com',
				'Open Notes',
				'Add website',
				'Edit merchant',
			])
				expect(financeHtml).not.toContain(word);
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
		expect(adminRoutes.merchant('mer_1', { q: 'shop', status: null })).toBe('/admin/merchants/mer_1?q=shop');
		expect(adminRoutes.merchant('mer_1')).toBe('/admin/merchants/mer_1');
		expect(adminRoutes.website('mer_1', 'web_1')).toBe('/admin/merchants/mer_1#website-web_1');
		expect(adminRoutes.product('notes', { status: 'active' })).toBe('/admin/products/notes?status=active');
		expect(adminRoutes.product('notes')).toBe('/admin/products/notes');
		expect(adminRoutes.admin('adm_1')).toBe('/admin/admins/adm_1');
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
