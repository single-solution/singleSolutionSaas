// @vitest-environment jsdom
/**
 * The fuller screens (PLAN 0.8.2, 2026-10-10) against a live in-process Portal: the details, More menus, filters,
 * counts and quick actions the Portal API already had — admin Overview (attention, credits added, product menus, Add
 * merchant), the merchant page (details, warning, usage of all websites, its receipts and Activity), Products
 * (features and prices, connection, sort, Open docs, Copy address), Credits and billing (tiles, Add credits with a
 * merchant picker, Period), Activity (dropdowns, changes, name filters), Admins (details, role rights, recent
 * activity, role filter), own activity paging, and the merchant console (recent activity, latest receipts, website
 * spend, Period).
 * @module
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@ss/ui';
import { byLabel, cleanup, keydown, render, type } from '@ss/ui/testing';
import { closeMongoClients } from '../../src/testing.js';
import * as admin from '../../src/console/admin/loaders.js';
import * as loaders from '../../src/console/loaders.js';
import { adminApi } from '../../src/console/admin/paths.js';
import { MyAccountView } from '../../src/console/admin/views/account.js';
import { ActivityView } from '../../src/console/admin/views/activity.js';
import { AdminsView } from '../../src/console/admin/views/admins.js';
import { FinanceView } from '../../src/console/admin/views/finance.js';
import { MerchantsView } from '../../src/console/admin/views/merchants.js';
import { OverviewView } from '../../src/console/admin/views/overview.js';
import { ProductsView } from '../../src/console/admin/views/products.js';
import { CreditsView } from '../../src/console/views/credits.js';
import { presetOf, rangePresets } from '../../src/console/views/range.js';
import { OverviewView as MerchantOverview, WebsiteView } from '../../src/console/views/websites.js';
import { PORTAL_URL, startMongo } from '../helpers.js';
import {
	buttons,
	clickEl,
	createWorld,
	dialog,
	fillDialog,
	press,
	pressDialog,
	pressMenu,
	quiet,
	shows,
	until,
} from './merchant-harness.js';
import { testRouter } from './router.js';

vi.mock('next/navigation.js', async (importOriginal) => {
	const { testRouter: router } = await import('./router.js');
	return { .../** @type {object} */ (await importOriginal()), useRouter: () => router };
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
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** @param {import('react').ReactNode} node */
const withToasts = (node) => render(<ToastProvider durationMs={600_000}>{node}</ToastProvider>);

/** Open an actions menu by its accessible name. @param {string} label */
const menu = (label) => clickEl(/** @type {Element} */ (document.querySelector(`button[aria-label="${label}"]`)));

/** @param {string} label */
const menuItem = (label) =>
	/** @type {HTMLButtonElement} */ ([...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === label));

/** @param {string} snippet the last router push contains it */
const pushed = (snippet) => String(testRouter.push.mock.calls.at(-1)?.[0] ?? '').includes(snippet);

describe('Period presets', () => {
	it('are UTC day ranges, today included; other dates are custom', () => {
		const now = Date.UTC(2026, 9, 10, 12);
		const by = Object.fromEntries(rangePresets(now).map((p) => [p.value, [p.from, p.to]]));
		expect(by.last7).toEqual(['2026-10-04', '2026-10-10']);
		expect(by.last30).toEqual(['2026-09-11', '2026-10-10']);
		expect(by.last90).toEqual(['2026-07-13', '2026-10-10']);
		expect(by.thisMonth).toEqual(['2026-10-01', '2026-10-10']);
		expect(by.lastMonth).toEqual(['2026-09-01', '2026-09-30']);
		expect(presetOf(null, null, now)).toBe('');
		expect(presetOf('2026-10-01', '2026-10-10', now)).toBe('thisMonth');
		expect(presetOf('2026-01-01', null, now)).toBe('custom');
	});
});

describe('fuller Portal screens (jsdom)', () => {
	it('drives the details, menus, filters and quick actions of both consoles', async () => {
		const restore = quiet();
		const world = await createWorld({ db: mongo.db('fuller') });
		try {
			const { ownerBrowser, owner } = world;
			const shop = await world.signup('owner@shop.test', 'Shop & Co');
			const merchantId = shop.merchantId;
			const site = await world.addWebsite(merchantId, 'shop.example.com');
			const websiteId = String(site.websiteId);
			const notes = await world.connect();
			await world.addProduct(merchantId, websiteId, 'notes');
			// Notes costs 100 credits an hour (2,400 a day); Notes inbox needs Notes
			const priced = await world.portal.handle(
				new Request(`${PORTAL_URL}/v1/product/prices`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${await notes.assertion()}` },
					body: JSON.stringify({
						version: 5,
						features: [
							{
								key: 'notes',
								name: 'Notes',
								description: 'Visitors leave short notes.',
								dependsOn: [],
								millicreditsPerHour: 100_000,
							},
							{
								key: 'inbox',
								name: 'Notes inbox',
								description: 'Read the notes.',
								dependsOn: ['notes'],
								millicreditsPerHour: 0,
							},
						],
					}),
				}),
			);
			expect(priced.status).toBe(200);
			await world.switchFeatures(notes, websiteId, ['notes']);
			await world.credit(merchantId, 1_000_000, 'seed-1'); // 1,000 credits: less than a day at 2,400 a day
			const pending = await ownerBrowser.api.post(adminApi.createMerchant(), {
				name: 'Pending Ltd',
				ownerName: 'Pat',
				email: 'pat@pending.test',
			});
			expect(pending.ok).toBe(true);
			const open = vi.fn();
			vi.stubGlobal('open', open);
			const writeText = vi.fn(async () => undefined);
			vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
			ownerBrowser.use();

			// ---------------------------------------------------------------- Overview
			const overview = await admin.loadOverview(ownerBrowser.api);
			if (!overview.ok) throw new Error('overview');
			expect(overview.attention.map((m) => m.merchantId)).toEqual([merchantId]);
			expect(overview.creditsAdded).toBe(1_000_000);
			expect(overview.merchants.map((m) => m.name)).toContain('Shop & Co');
			expect(typeof overview.billing[merchantId]?.balance).toBe('number');
			withToasts(<OverviewView {...overview} admin={owner} />);
			// one page: what needs the admin (with what happens if it waits), the month's numbers, the first merchants and
			// the products as tables, the timeline; the greeting is behind the (i)
			for (const text of [
				'Needs you',
				'Credits are running low',
				'Email sending is not set up',
				'Credits added this month (UTC)',
				'Shop & Co',
				'View all',
			])
				expect(shows(text)).toBe(true);
			expect(shows('Welcome back')).toBe(false);
			await press('About this page');
			expect(shows('Welcome back')).toBe(true);
			expect(shows('Getting the platform ready')).toBe(false); // a product, a merchant and a website exist: nothing left to set up
			await menu('Actions for Notes');
			await clickEl(menuItem('View product'));
			expect(pushed('/admin/products/notes')).toBe(true);
			await menu('Actions for Notes');
			await clickEl(menuItem('Open as admin'));
			fillDialog('Your password', ownerBrowser.password);
			await pressDialog('Open configure');
			await until(() => open.mock.calls.length > 0);
			await press('Add credits');
			await until(() => shows('Add credits · Shop & Co'));
			keydown(document, 'Escape');
			await press('Add merchant');
			expect(dialog().textContent).toContain('Add merchant');
			cleanup();

			// ---------------------------------------------------------------- Merchants: Setup pending, the merchant page
			const pendingOnly = await admin.loadMerchants(ownerBrowser.api, { status: 'setup_pending' });
			expect(pendingOnly.ok && pendingOnly.page.items.map((m) => m.name)).toEqual(['Pending Ltd']);
			const detail = await admin.loadMerchant(ownerBrowser.api, merchantId, owner);
			/** @param {string} section */
			const showMerchant = (section) => {
				cleanup();
				withToasts(<MerchantsView detail={detail} section={section} admin={owner} />);
			};
			showMerchant('websites');
			// the merchant's parts are addresses: Websites first, then Credits, Details, Activity
			expect(shows('Low balance: about')).toBe(true);
			showMerchant('credits');
			expect(shows('Credit receipts')).toBe(true);
			showMerchant('details');
			expect(shows('Last sign-in')).toBe(true);
			expect(shows('Products on websites')).toBe(false); // the Websites part shows the count
			showMerchant('activity');
			expect(shows('Activity')).toBe(true);
			await clickEl(/** @type {HTMLElement} */ (document.querySelector('#activity [data-ss-row]')));
			expect(shows('Activity entry') && shows('Changes')).toBe(true);
			await press('Close');
			await menu('More actions');
			await clickEl(menuItem('Open in Activity'));
			expect(pushed(`/admin/activity?merchantId=${merchantId}`)).toBe(true);
			await menu('More actions');
			await clickEl(menuItem('Usage, all websites'));
			await until(() => shows('Usage · Shop & Co') && !dialog().querySelector('[aria-busy="true"]'));
			keydown(document, 'Escape');
			cleanup();

			// ---------------------------------------------------------------- Products: sort, features, connection, menu
			const products = await admin.loadProducts(ownerBrowser.api, {});
			if (!products.ok) throw new Error('products');
			withToasts(<ProductsView {...products} admin={owner} />);
			await press('Active');
			await press('All');
			cleanup();
			const oneProduct = await admin.loadProduct(ownerBrowser.api, String(products.items[0]?.productId));
			if (!oneProduct.ok) throw new Error('product');
			const baseUrl = String(oneProduct.product.baseUrl);
			withToasts(<ProductsView detail={oneProduct} section="features" admin={owner} />);
			expect(shows('Notes inbox')).toBe(true);
			expect(document.querySelector('#connection')).not.toBeNull();
			cleanup();
			withToasts(<ProductsView detail={oneProduct} section="connection" admin={owner} />);
			expect(shows('Version 5') && shows(`${baseUrl}/docs`)).toBe(true);
			await menu('More actions');
			await clickEl(menuItem('Copy address'));
			await until(() => shows('Copied.'));
			expect(writeText).toHaveBeenCalledWith(baseUrl);
			cleanup();

			// ---------------------------------------------------------------- Credits and billing
			const billing = await admin.loadBilling(ownerBrowser.api, {});
			if (!billing.ok) throw new Error('billing');
			expect(billing.merchants.map((m) => m.label)).toEqual(['Pending Ltd', 'Shop & Co']);
			withToasts(<FinanceView {...billing} admin={owner} part="attention" />);
			for (const text of ['Credits added', 'Credits charged', 'Receipts', 'Charges', 'Needs attention'])
				expect(shows(text)).toBe(true);
			// the parts are links with their own addresses (the filters stay in the query)
			expect(document.querySelector('nav a[href^="/admin/finance/receipts"]')).not.toBeNull();
			expect(document.querySelector('nav a[href^="/admin/finance/charges"]')).not.toBeNull();
			await clickEl(/** @type {Element} */ (buttons('Add credits')[0]));
			await until(() => shows('Choose the merchant who paid'));
			await type(byLabel(dialog(), 'Merchant'), merchantId);
			await pressDialog('Next');
			await until(() => shows('Add credits · Shop & Co'));
			keydown(document, 'Escape');
			cleanup();
			withToasts(<FinanceView {...billing} admin={owner} part="receipts" />);
			await pressMenu('Period', 'Last 7 days');
			expect(pushed('/admin/finance/receipts?') && pushed('from=')).toBe(true);
			cleanup();
			withToasts(<FinanceView {...billing} admin={owner} part="charges" />);
			await press('By merchant');
			expect(pushed('/admin/finance/charges?by=merchant')).toBe(true);
			cleanup();

			// ---------------------------------------------------------------- Activity
			const activity = await admin.loadActivity(ownerBrowser.api, {}, owner);
			if (!activity.ok) throw new Error('activity');
			expect(activity.admins?.map((a) => a.value)).toEqual([owner.adminId]);
			render(<ActivityView {...activity} />);
			// a row opens a drawer with what the entry changed
			await clickEl(/** @type {HTMLElement} */ (document.querySelector('[data-ss-row]')));
			expect(shows('Activity entry') && shows('Changes')).toBe(true);
			await press('Close');
			const only = /** @type {HTMLAnchorElement} */ (document.querySelector('a[title="Show only Shop & Co"]'));
			expect(only.getAttribute('href')).toBe(`/admin/activity?merchantId=${merchantId}`);
			await pressMenu('Admin', String(activity.admins?.[0]?.label));
			expect(pushed(`adminId=${owner.adminId}`)).toBe(true);
			await pressMenu('Period', 'This month (UTC)');
			expect(pushed('from=')).toBe(true);
			cleanup();
			const filtered = await admin.loadActivity(ownerBrowser.api, { merchantId }, owner);
			render(<ActivityView {...filtered} />);
			expect(shows('Clear filters')).toBe(true);
			cleanup();

			// ---------------------------------------------------------------- own activity pages
			const first = await ownerBrowser.api.get(`${adminApi.myActivity()}?limit=1`);
			if (!first.ok) throw new Error('my activity');
			const mine = await admin.loadMyAccount(ownerBrowser.api);
			withToasts(<MyAccountView {...mine} activity={first.data} part="activity" />);
			expect(document.querySelectorAll('[data-ss-row]').length).toBe(1);
			await press('Show more');
			await until(() => document.querySelectorAll('[data-ss-row]').length > 1);
			cleanup();

			// ---------------------------------------------------------------- Admins
			await world.adminOf('support');
			const admins = await admin.loadAdmins(ownerBrowser.api, owner);
			withToasts(<AdminsView {...admins} />);
			// the list is rows; the role filter keeps one role
			expect(shows('support admin')).toBe(true);
			await press('Owner');
			expect(shows('support admin')).toBe(false);
			await press('Support');
			expect(shows('support admin')).toBe(true);
			cleanup();
			// one admin's page: the details and what the role can do, then the Activity part
			const own = await admin.loadAdmin(ownerBrowser.api, owner, owner.adminId);
			withToasts(<AdminsView {...own} selectedId={owner.adminId} />);
			expect(shows('What this role can do') && shows('Everything in the Portal')).toBe(true);
			expect(document.querySelector('#activity')).not.toBeNull();
			cleanup();
			const ownActivity = await admin.loadAdmin(ownerBrowser.api, owner, owner.adminId);
			withToasts(<AdminsView {...ownActivity} selectedId={owner.adminId} section="activity" />);
			expect(document.querySelectorAll('[data-ss-row]').length).toBeGreaterThan(0);
			await pressMenu('More actions', 'Open in Activity');
			expect(pushed(`/admin/activity?adminId=${owner.adminId}`)).toBe(true);
			cleanup();

			// ---------------------------------------------------------------- merchant console
			shop.b.use();
			withToasts(<MerchantOverview {...await loaders.loadOverview(shop.b.api, merchantId)} />);
			for (const text of ['Recent activity', 'Latest credits added', 'seed-1']) expect(shows(text)).toBe(true);
			cleanup();
			withToasts(<WebsiteView {...await loaders.loadWebsitePage(shop.b.api, merchantId, websiteId, '')} />);
			expect(document.querySelector('#product-notes')).not.toBeNull();
			cleanup();
			// usage redirects to the website home (PLAN §1, §10 A1)
			withToasts(<WebsiteView {...await loaders.loadWebsitePage(shop.b.api, merchantId, websiteId, 'usage')} />);
			await until(() => pushed(`/websites/${websiteId}`));
			cleanup();
			withToasts(<CreditsView {...await loaders.loadCredits(shop.b.api, merchantId, {})} />);
			await pressMenu('Period', 'Last month (UTC)');
			expect(pushed('/credits?from=')).toBe(true);
		} finally {
			await world.close();
			restore();
		}
	});
});
