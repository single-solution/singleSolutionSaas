/**
 * Server render of every admin page against a live in-process Portal: the first Owner turns two-step on, seeds a
 * merchant with a website, connects two fake products (one inactive), adds a product to the website and credits; then
 * every admin page renders without errors or React warnings (the list-and-detail screens with and without a selection),
 * and each role (Owner, Support, Finance) sees only the menu entries and actions it can use (PLAN 0.2, 0.6).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { sessionCookieName, totpCode } from '../../src/infra/auth.js';
import { closeMongoClients } from '../../src/testing.js';
import * as admin from '../../src/console/admin/loaders.js';
import { adminApi, adminRoutes } from '../../src/console/admin/paths.js';
import { query } from '../../src/console/paths.js';
import { AdminShell, adminSections } from '../../src/console/admin/views/shell.js';
import { MerchantsView } from '../../src/console/admin/views/merchants.js';
import { AdminWebsiteView } from '../../src/console/admin/views/website.js';
import { OverviewView } from '../../src/console/admin/views/overview.js';
import { creditDayBars } from '../../src/console/views/billing.js';
import { ActivityView } from '../../src/console/admin/views/activity.js';
import { AdminsView } from '../../src/console/admin/views/admins.js';
import { MyAccountView } from '../../src/console/admin/views/account.js';
import { SettingsView } from '../../src/console/admin/views/settings.js';
import { FinanceView, MerchantCredits } from '../../src/console/admin/views/finance.js';
import { ProductsView, featureNames } from '../../src/console/admin/views/products.js';
import { adminCan } from '../../src/console/admin/views/common.js';
import { startMongo } from '../helpers.js';
import { createWorld } from './merchant-harness.js';

vi.mock('next/navigation.js', async (importOriginal) => {
	const { testRouter } = await import('./router.js');
	return { .../** @type {object} */ (await importOriginal()), useRouter: () => testRouter };
});

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
		.replace(/<wbr\/?>/g, '') // soft line breaks inside a domain or email
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
			// inviting an admin asks for the Owner's password (and a code once two-step is on), so it comes first
			const invite = { email: 'help@ss.test', role: 'support', password: 'owner password 123!' };
			expect((await ownerBrowser.api.post(adminApi.admins(), invite)).ok).toBe(true);
			// two-step on for the Owner (My account shows the recovery codes left)
			const started = await ownerBrowser.api.post('/v1/me/two-step/start', { password: 'owner password 123!' });
			const confirmed = await ownerBrowser.api.post('/v1/me/two-step/confirm', {
				code: totpCode(started.ok ? started.data.secret : '', Date.now()),
			});
			expect(confirmed.ok && confirmed.data.recoveryCodes.length).toBe(10);
			// the admin cookie is separate from merchant sessions
			expect([...ownerBrowser.jar.keys()]).toEqual([sessionCookieName('admin', true)]);
			const session = await admin.loadAdminSession(ownerBrowser.api);
			if (!session.ok) throw new Error('no admin session');
			const owner = session.admin;

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
			for (const group of ['Operate', 'Money', 'Portal']) expect(shell).toContain(group);
			expect(shell).toContain('child');
			const pending = text(
				ssr(
					<AdminShell admin={owner} twoStepRequired branding={{ name: 'Single Solution', accent: '#4f46e5' }}>
						<p>hidden</p>
					</AdminShell>,
				),
			);
			expect(pending).toContain('Set up two-step sign-in');
			expect(pending).not.toContain('hidden');

			// ------------------------------------------------------------------ Overview: per-product numbers
			const overview = await admin.loadOverview(ownerBrowser.api);
			const overviewHtml = text(ssr(<OverviewView {...overview} admin={owner} />));
			// one page: what needs the admin first, then the month's numbers, the merchants and products as tables, activity
			expect(overviewHtml).toContain('Email sending is not set up');
			expect(overviewHtml).toContain('Merchants 1 Websites 1'); // the numbers in the header; the sentence is behind the (i)
			for (const section of ['Needs you', 'Credits', 'Merchants', 'Products', 'Recent activity'])
				expect(overviewHtml).toContain(section);
			expect(overviewHtml).toContain('Earned this month (UTC)'); // the products table
			// nothing repeated: the setup checklist asks for the first product, and no second "No product" need says it again
			const bare = text(ssr(<OverviewView ok overview={{ products: [] }} admin={owner} />));
			expect(bare).toContain('Connect a product');
			expect(bare).not.toContain('No product is connected yet');

			// ------------------------------------------------------------------ Merchants: the list, then a merchant selected
			const list = await admin.loadMerchants(ownerBrowser.api, {});
			// the list is a table page: the name opens the merchant, the balance of the first page is on the row
			const listRaw = ssr(<MerchantsView {...list} admin={owner} />);
			const listHtml = text(listRaw);
			expect(listHtml).toContain('Merchants');
			expect(listHtml).toContain('Shop & Co');
			expect(listHtml).toContain('250 credits'); // the balance on the row
			expect(listHtml).toContain('Add merchant');
			expect(listRaw).toContain(`href="/admin/merchants/${merchantId}"`);
			expect(listRaw).toContain('data-ss-page');
			expect(listRaw).not.toContain('role="tab"');
			const none = await admin.loadMerchants(ownerBrowser.api, { q: 'nobody-here' });
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
			const raw = ssr(<MerchantsView detail={detail} admin={owner} />);
			const detailHtml = text(raw);
			// the header with the actions; the parts are the inner navigation, each its own address, Websites first
			expect(raw).not.toContain('role="tab"');
			for (const word of [
				'Merchants',
				'Shop & Co',
				'shop.example.com',
				'Active',
				'250 credits',
				'Add website',
				'Add credits',
				'Edit merchant',
				'Websites',
				'Credits',
				'Details',
				'Activity',
			])
				expect(detailHtml).toContain(word);
			expect(raw).toContain(`href="/admin/merchants/${merchantId}/credits"`);
			expect(raw).toContain(`href="/admin/merchants/${merchantId}/details"`);
			expect(raw).toContain(`href="/admin/merchants/${merchantId}/activity"`);
			expect(detailHtml).not.toContain('Credit receipts');
			// the other actions (Suspend, setup link, two-step off, Delete) sit in the header's More menu
			expect(raw).toContain('aria-label="More actions"');
			expect(raw).not.toMatch(/>Suspend<\/button>/);
			expect(raw).toContain('aria-label="Actions for shop.example.com"');
			// a website is its own page: crumbs back to the merchant, its sections (status, products, changes, usage) all open
			const siteId = String(detail.rows[0]?.website.websiteId);
			expect(raw).toContain(`href="/admin/merchants/${merchantId}/websites/${siteId}"`);
			const siteDetail = await admin.loadAdminWebsite(ownerBrowser.api, merchantId, siteId, '', owner);
			const siteRaw = ssr(<AdminWebsiteView detail={siteDetail} admin={owner} />);
			expect(text(siteRaw)).toContain('Notes');
			expect(siteRaw).toContain(`href="/admin/merchants/${merchantId}"`);
			for (const word of ['Add product', 'Status and spend', 'Settings', 'Setup sheet', 'Usage details', 'Recent changes'])
				expect(text(siteRaw)).toContain(word);
			expect(siteRaw).toContain('id="product-notes"');
			expect(siteRaw).toContain('aria-label="Actions for Notes"');
			const unknownSite = await admin.loadAdminWebsite(ownerBrowser.api, merchantId, 'web_none', '', owner);
			expect(text(ssr(<AdminWebsiteView detail={unknownSite} admin={owner} />))).toContain('No such website.');
			// a part that is not a page of the website says so
			const nonsense = await admin.loadAdminWebsite(ownerBrowser.api, merchantId, siteId, 'nonsense', owner);
			expect(text(ssr(<AdminWebsiteView detail={nonsense} admin={owner} />))).toContain('This page does not exist.');
			// the other parts
			expect(text(ssr(<MerchantsView detail={detail} section="details" admin={owner} />))).toContain('Two-step sign-in');
			const missingMerchant = await admin.loadMerchant(ownerBrowser.api, 'mer_0000000000000000000000000z', owner);
			expect(text(ssr(<MerchantsView detail={missingMerchant} admin={owner} />))).toContain('Not found');

			// ------------------------------------------------------------------ Products: the list, then a product's page
			const products = await admin.loadProducts(ownerBrowser.api, { status: 'bogus' });
			expect(products.ok && products.filter).toEqual({ status: null });
			const productsRaw = ssr(<ProductsView {...products} admin={owner} />);
			const productsHtml = text(productsRaw);
			for (const word of ['Add product', 'Notes', 'Chatty', 'Earned this month', 'Websites'])
				expect(productsHtml).toContain(word);
			// a table: the rows open the product's page; by name: Chatty comes first
			expect(productsRaw).toContain('href="/admin/products/notes"');
			expect(productsHtml.indexOf('Chatty')).toBeLessThan(productsHtml.indexOf('Notes'));
			expect(products.ok && products.items.map((p) => p.name)).toEqual(['Chatty', 'Notes']);
			// nothing connected yet, and nothing found with a filter
			expect(text(ssr(<ProductsView {...products} items={[]} admin={owner} />))).toContain('No products connected yet.');
			expect(text(ssr(<ProductsView {...products} items={[]} filter={{ status: 'active' }} admin={owner} />))).toContain(
				'No products found.',
			);
			const active = await admin.loadProducts(ownerBrowser.api, { status: 'active' });
			expect(active.ok && active.items.map((p) => p.productId)).toEqual(['notes']);
			const product = await admin.loadProduct(ownerBrowser.api, 'notes');
			if (!product.ok) throw new Error('product');
			expect(product.websites.items).toMatchObject([
				{ domain: 'shop.example.com', merchantName: 'Shop & Co', featuresOn: ['notes'] },
			]);
			const productRaw = ssr(<ProductsView detail={product} admin={owner} />);
			const productHtml = text(productRaw);
			for (const word of ['Open as admin', 'Set inactive', 'Websites using it', 'Shop & Co', 'Earned this month'])
				expect(productHtml).toContain(word);
			// the product's parts are in the inner navigation, each its own address
			expect(productRaw).toContain('aria-label="Product sections"');
			expect(productRaw).toContain('href="/admin/products/notes/features"');
			expect(productRaw).toContain('href="/admin/products/notes/connection"');
			// two actions as buttons; Copy address and Reconnect in the header's More menu (PLAN 0.6 header actions)
			expect(productRaw).toContain('aria-label="More actions"');
			// the address only on the Connection part; no empty 30-day chart, the fact says why
			expect(productHtml).not.toContain(String(product.product.baseUrl));
			for (const word of ['Features and prices', 'Connection']) expect(productHtml).toContain(word);
			expect(productHtml).not.toContain('Product version');
			expect(productRaw).toContain('title="No credits earned in the last 30 UTC days."');
			expect(productHtml).not.toContain('Credits earned per UTC day (last 30 days)');
			expect(productRaw).toContain('title="shop.example.com"');
			expect(productRaw).toContain(`href="/admin/merchants/${merchantId}/websites/${websiteId}"`);
			const featuresHtml = text(ssr(<ProductsView detail={product} section="features" admin={owner} />));
			expect(featuresHtml).toContain('Per hour');
			expect(featuresHtml).not.toContain('Shop & Co');
			const connectionHtml = text(ssr(<ProductsView detail={product} section="connection" admin={owner} />));
			for (const word of ['Product version', 'Price list', String(product.product.baseUrl)])
				expect(connectionHtml).toContain(word);
			const chatty = await admin.loadProduct(ownerBrowser.api, 'chatty');
			const chattyHtml = text(ssr(<ProductsView detail={chatty} admin={owner} />));
			expect(chattyHtml).toContain('Set active');
			expect(chattyHtml).toContain('Inactive');
			const unknown = await admin.loadProduct(ownerBrowser.api, 'nothing-here');
			expect(unknown.ok).toBe(false);
			expect(text(ssr(<ProductsView detail={unknown} admin={owner} />))).toContain('Not found');

			// ------------------------------------------------------------------ the other pages
			const activity = await admin.loadActivity(ownerBrowser.api, { merchantId, adminId: '<bad>', from: 'x' });
			expect(activity.ok && activity.filter).toEqual({ merchantId, adminId: null, from: null, to: null });
			expect(text(ssr(<ActivityView {...activity} />))).toContain('Product added');
			const admins = await admin.loadAdmins(ownerBrowser.api, owner);
			const adminsHtml = text(ssr(<AdminsView {...admins} />));
			expect(adminsHtml).toContain('help@ss.test');
			expect(adminsHtml).toContain('Two-step');
			const invited = admins.ok ? admins.items.find((a) => a.email === 'help@ss.test') : null;
			const invitedId = String(invited?.adminId);
			const invitedRaw = ssr(
				<AdminsView {...await admin.loadAdmin(ownerBrowser.api, owner, invitedId)} selectedId={invitedId} />,
			);
			const invitedHtml = text(invitedRaw);
			for (const word of ['Invited', 'Resend invite', 'Copy invite link']) expect(invitedHtml).toContain(word);
			// Correct invite email, Change role and Remove sit in the More menu
			expect(invitedRaw).toContain('aria-label="More actions"');
			expect(invitedHtml).not.toContain('Change role');
			expect(invitedRaw).toContain(`href="/admin/admins/${invitedId}/activity"`);
			const meHtml = text(
				ssr(<AdminsView {...await admin.loadAdmin(ownerBrowser.api, owner, owner.adminId)} selectedId={owner.adminId} />),
			);
			expect(meHtml).toContain('you');
			expect(meHtml).not.toContain('Change role');
			const gone = 'adm_00000000000000000000z';
			expect(text(ssr(<AdminsView {...await admin.loadAdmin(ownerBrowser.api, owner, gone)} selectedId={gone} />))).toContain(
				'This admin does not exist or was removed.',
			);
			// Settings: one Page with all its parts at once (Branding first), each a named section with its own anchor
			// (the jump list scrolls to it); the save bar is hidden until something changes
			const settingsRaw = ssr(<SettingsView {...await admin.loadSettings(ownerBrowser.api)} />);
			for (const part of ['branding', 'support', 'mail', 'security', 'billing'])
				expect(settingsRaw).toContain(`<section id="${part}"`);
			expect(settingsRaw.indexOf('id="branding"')).toBeLessThan(settingsRaw.indexOf('id="support"'));
			expect(settingsRaw.indexOf('id="mail"')).toBeLessThan(settingsRaw.indexOf('id="security"'));
			expect(settingsRaw).toContain('aria-label="Branding"');
			for (const title of ['Email sending', 'Branding', 'Support contact', 'Security', 'Billing rules'])
				expect(text(settingsRaw)).toContain(title);
			// the fields of every part are there at once
			for (const field of ['Accent color', 'SMTP host', 'Session length (hours)', 'Grace period (days)'])
				expect(text(settingsRaw)).toContain(field);
			expect(text(settingsRaw)).toContain('Encryption key'); // the Advanced bar of Security, closed
			expect(text(settingsRaw)).not.toContain('Re-seal stored secrets');
			expect(text(settingsRaw)).not.toContain('Save changes');
			// My account: an inner sidebar (Your name first); the two-step section is a link
			expect(text(ssr(<MyAccountView {...await admin.loadMyAccount(ownerBrowser.api)} />))).toContain('Two-step sign-in');
			const finance = await admin.loadBilling(ownerBrowser.api, { merchantId, by: 'merchant', method: 'Bank transfer' });
			expect(finance).toMatchObject({ ok: true, filter: { merchantId, by: 'merchant' } });
			const financeRaw = ssr(<FinanceView {...finance} admin={owner} part="receipts" />);
			// an inner navigation: needs attention first, then receipts and charges, each its own address
			for (const word of ['Credits and billing', 'Needs attention', 'Receipts', 'Charges'])
				expect(text(financeRaw)).toContain(word);
			expect(financeRaw).toContain('href="/admin/finance/charges?');
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
			expect(creditsHtml).toContain('USD 10');
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
			// Credits and billing carries the number of merchants that need attention, and only then
			const billingItem = (/** @type {number | undefined} */ attention) =>
				adminSections(world.owner, '/admin', attention)
					.flatMap((s) => s.items)
					.find((i) => i.label === 'Credits and billing');
			expect(billingItem(2)?.badge).toEqual({ count: 2, tone: 'attention', label: '2 merchants need attention' });
			expect(billingItem(1)?.badge?.label).toBe('1 merchant needs attention');
			expect(billingItem(0)?.badge).toBeUndefined();
			expect(billingItem(undefined)?.badge).toBeUndefined();
			// the count comes from the same check as the Needs attention list
			expect(await admin.loadAttentionCount(world.ownerBrowser.api)).toBe(
				/** @type {any} */ (await admin.loadBilling(world.ownerBrowser.api)).attention.length,
			);

			// Support: the website cards with every admin action, the Setup sheet and Settings; Products read-only
			const supportDetail = await admin.loadMerchant(supportBrowser.api, merchantId, support);
			expect(supportDetail.ok && supportDetail.addable).toEqual([{ productId: 'notes', name: 'Notes' }]);
			if (!supportDetail.ok) throw new Error('support merchant');
			const supportSite = String(supportDetail.rows[0]?.website.websiteId);
			// the merchant's page has Add website; the website's own page has the products with their actions
			expect(ssr(<MerchantsView detail={supportDetail} admin={support} />)).toContain('Add website');
			const supportSiteDetail = await admin.loadAdminWebsite(supportBrowser.api, merchantId, supportSite, '', support);
			const supportHtml = ssr(<AdminWebsiteView detail={supportSiteDetail} admin={support} />);
			for (const word of ['Add product', 'aria-label="Actions for Notes"', 'Setup sheet', 'Settings', 'Recent changes'])
				expect(supportHtml).toContain(word);
			expect(supportHtml).not.toContain('Add credits');
			const supportProducts = await admin.loadProducts(supportBrowser.api);
			const supportProductsHtml = text(ssr(<ProductsView {...supportProducts} admin={support} />));
			expect(supportProductsHtml).toContain('Notes');
			expect(supportProductsHtml).not.toContain('Add product');
			const supportProductRaw = ssr(
				<ProductsView detail={await admin.loadProduct(supportBrowser.api, 'notes')} admin={support} />,
			);
			const supportProduct = text(supportProductRaw);
			expect(supportProduct).toContain('Websites using it');
			for (const word of ['Open as admin', 'Set inactive']) expect(supportProduct).not.toContain(word);
			expect(supportProductRaw).not.toContain('More actions'); // no Reconnect

			// Finance: products and usage only; no Install and tokens, no Open, no admin actions
			const financeDetail = await admin.loadMerchant(financeBrowser.api, merchantId, finance);
			if (!financeDetail.ok) throw new Error('finance merchant');
			expect(financeDetail.addable).toBeNull();
			const financeSite = String(financeDetail.rows[0]?.website.websiteId);
			const financeSiteDetail = await admin.loadAdminWebsite(financeBrowser.api, merchantId, financeSite, '', finance);
			const financeHtml = ssr(<AdminWebsiteView detail={financeSiteDetail} admin={finance} />);
			expect(financeHtml).toContain('Notes');
			expect(financeHtml).toContain('Usage'); // Usage stays
			expect(ssr(<MerchantsView detail={financeDetail} admin={finance} />)).toContain('Add credits');
			for (const word of ['Setup sheet', 'Settings', 'Recent changes', 'Add product', 'Add website', 'Edit merchant'])
				expect(financeHtml).not.toContain(word);
			// Activity filters: Support has no list of admins, so no Admin filter; the Owner picks a name
			const supportActivity = await admin.loadActivity(supportBrowser.api, {}, support);
			const supportActivityHtml = ssr(<ActivityView {...supportActivity} />);
			expect(supportActivityHtml).toContain('aria-label="Merchant"');
			expect(supportActivityHtml).not.toContain('aria-label="Admin"');
			const ownerActivity = await admin.loadActivity(world.ownerBrowser.api, {}, world.owner);
			expect(ssr(<ActivityView {...ownerActivity} />)).toContain('aria-label="Admin"');
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

	it('opens an old address of a Settings part at that part of the one Settings page', async () => {
		const { default: SettingsPart } = await import('../../app/(admin)/admin/_views/settings-part.js');
		const open = (/** @type {string} */ part) => SettingsPart({ params: Promise.resolve({ part }) });
		await expect(open('mail')).rejects.toMatchObject({ digest: expect.stringContaining('/admin/settings#mail') });
		await expect(open('billing')).rejects.toMatchObject({ digest: expect.stringContaining('/admin/settings#billing') });
		// a part that does not exist stays a 404
		await expect(open('nothing')).rejects.toMatchObject({ digest: expect.stringContaining('404') });
	});

	it('pure helpers of the admin views', () => {
		expect(query({ a: 'x', b: null, c: '', d: 2 })).toBe('?a=x&d=2');
		expect(query({})).toBe('');
		expect(adminRoutes.activity({ merchantId: 'mer_1' })).toBe('/admin/activity?merchantId=mer_1');
		expect(adminRoutes.login('/admin/x')).toBe('/login?next=%2Fadmin%2Fx');
		expect(adminRoutes.merchant('mer_1', { q: 'shop', status: null })).toBe('/admin/merchants/mer_1?q=shop');
		expect(adminRoutes.merchant('mer_1')).toBe('/admin/merchants/mer_1');
		expect(adminRoutes.website('mer_1', 'web_1')).toBe('/admin/merchants/mer_1/websites/web_1');
		expect(adminRoutes.merchantPart('mer_1', 'websites')).toBe('/admin/merchants/mer_1');
		expect(adminRoutes.merchantPart('mer_1', 'credits')).toBe('/admin/merchants/mer_1/credits');
		expect(adminRoutes.product('notes', { status: 'active' })).toBe('/admin/products/notes?status=active');
		expect(adminRoutes.product('notes')).toBe('/admin/products/notes');
		expect(adminRoutes.productPart('notes', 'websites')).toBe('/admin/products/notes');
		expect(adminRoutes.productPart('notes', 'features')).toBe('/admin/products/notes/features');
		expect(adminRoutes.admin('adm_1')).toBe('/admin/admins/adm_1');
		expect(adminRoutes.settingsPart('mail')).toBe('/admin/settings#mail');
		expect(adminRoutes.settingsPart('branding')).toBe('/admin/settings#branding');
		expect(adminRoutes.products({ status: 'active' })).toBe('/admin/products?status=active');
		expect(adminApi.productWebsites('notes', 'abc')).toBe('/v1/admin/products/notes/websites?cursor=abc');
		expect(adminApi.launch('notes')).toBe('/v1/admin/products/notes/launch');
		expect(creditDayBars([{ day: '2026-10-01', amount: 1500 }])).toEqual([{ label: '10-01', value: 1.5, hint: '2026-10-01' }]);
		expect(creditDayBars(undefined)).toEqual([]);
		const features = [{ key: 'notes', name: 'Notes' }];
		expect(featureNames(features, ['notes', 'gone'])).toBe('Notes, gone');
		expect(featureNames(features, [])).toBe('None');
		expect(featureNames(undefined, ['x'])).toBe('x');
	});
});
