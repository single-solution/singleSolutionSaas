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
import { ActivityView } from '../../src/console/admin/views/activity.js';
import { AdminsView } from '../../src/console/admin/views/admins.js';
import { FinanceView } from '../../src/console/admin/views/finance.js';
import { MerchantsView } from '../../src/console/admin/views/merchants.js';
import { OverviewView } from '../../src/console/admin/views/overview.js';
import { ProductsView } from '../../src/console/admin/views/products.js';
import { CreditsView } from '../../src/console/views/credits.js';
import { OwnActivity } from '../../src/console/views/login-settings.js';
import { presetOf, rangePresets } from '../../src/console/views/range.js';
import { OverviewView as MerchantOverview, WebsitesView } from '../../src/console/views/websites.js';
import { PORTAL_URL, startMongo } from '../helpers.js';
import {
	buttons,
	clickEl,
	createWorld,
	dialog,
	openSection,
	openTab,
	press,
	pressDialog,
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

/** Open the header's More menu (⋯) and choose an action. @param {string} name @param {string} label */
const choose = async (name, label) => {
	await menu(`More actions for ${name}`);
	await clickEl(menuItem(label));
};

/** @param {string} label @param {string} value */
const pick = (label, value) => type(byLabel(document, label), value);

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
			// an inner sidebar, one view at a time: what needs the admin (with what happens if it waits) and the setup
			// checklist first; the month's numbers, the first merchants, the products and the timeline are links
			for (const text of ['Welcome back', 'Needs you', 'Credits are running low', 'Email sending is not set up'])
				expect(shows(text)).toBe(true);
			expect(shows('Getting the platform ready')).toBe(false); // a product, a merchant and a website exist: nothing left to set up
			await openSection('Credits');
			expect(shows('Credits added this month (UTC)')).toBe(true);
			await openSection('Merchants');
			expect(shows('Shop & Co') && shows('View all')).toBe(true);
			await openSection('Products');
			await menu('Notes actions');
			await clickEl(menuItem('View product'));
			expect(pushed('/admin/products/notes')).toBe(true);
			await menu('Notes actions');
			await clickEl(menuItem('Open as admin'));
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
			const list = await admin.loadMerchants(ownerBrowser.api, {});
			const detail = await admin.loadMerchant(ownerBrowser.api, merchantId, owner);
			withToasts(<MerchantsView {...list} detail={detail} selectedId={merchantId} admin={owner} />);
			// the merchant's parts are tabs: Websites first, then Credits, Details, Activity
			expect(shows('Low balance: about')).toBe(true);
			await openTab('Credits');
			expect(shows('Credit receipts')).toBe(true);
			await openTab('Details');
			expect(shows('Last sign-in')).toBe(true);
			expect(shows('Products on websites')).toBe(false); // the Websites tab shows the count
			await openTab('Activity');
			expect(shows('Changes')).toBe(true);
			await press('Open in Activity');
			expect(pushed(`/admin/activity?merchantId=${merchantId}`)).toBe(true);
			await choose('Shop & Co', 'Usage, all websites');
			await until(() => shows('Usage · Shop & Co') && !dialog().querySelector('[aria-busy="true"]'));
			keydown(document, 'Escape');
			cleanup();

			// ---------------------------------------------------------------- Products: features, connection, sort, menu
			const products = await admin.loadProductsScreen(ownerBrowser.api, {});
			if (!products.ok || !('detail' in products) || !products.detail.ok) throw new Error('products');
			const baseUrl = String(products.detail.product.baseUrl);
			withToasts(<ProductsView {...products} admin={owner} />);
			await openTab('Features and prices');
			expect(shows('Notes inbox')).toBe(true);
			await openTab('Connection');
			expect(shows('Version 5') && shows(`${baseUrl}/docs`)).toBe(true);
			await pick('Sort', 'earned');
			await pick('Sort', 'websites');
			await choose('Notes', 'Copy address');
			await until(() => shows('Copied.'));
			expect(writeText).toHaveBeenCalledWith(baseUrl);
			cleanup();

			// ---------------------------------------------------------------- Credits and billing
			const billing = await admin.loadBilling(ownerBrowser.api, {});
			if (!billing.ok) throw new Error('billing');
			expect(billing.merchants.map((m) => m.label)).toEqual(['Pending Ltd', 'Shop & Co']);
			withToasts(<FinanceView {...billing} admin={owner} />);
			for (const text of ['Credits added', 'Receipts', 'Credits charged', 'Needs attention']) expect(shows(text)).toBe(true);
			await clickEl(/** @type {Element} */ (buttons('Add credits')[0]));
			await until(() => shows('Choose the merchant who paid'));
			await type(byLabel(dialog(), 'Merchant'), merchantId);
			await pressDialog('Next');
			await until(() => shows('Add credits · Shop & Co'));
			keydown(document, 'Escape');
			await openSection('Receipts');
			await pick('Period', 'last7');
			expect(pushed('/admin/finance?') && pushed('from=')).toBe(true);
			await openSection('Charges');
			expect(shows('By merchant')).toBe(true);
			cleanup();

			// ---------------------------------------------------------------- Activity
			const activity = await admin.loadActivity(ownerBrowser.api, {}, owner);
			if (!activity.ok) throw new Error('activity');
			expect(activity.admins?.map((a) => a.value)).toEqual([owner.adminId]);
			render(<ActivityView {...activity} />);
			expect(shows('Changes')).toBe(true);
			const only = /** @type {HTMLAnchorElement} */ (document.querySelector('a[title="Show only Shop & Co"]'));
			expect(only.getAttribute('href')).toBe(`/admin/activity?merchantId=${merchantId}`);
			await pick('Admin', owner.adminId);
			await press('Filter');
			expect(pushed(`adminId=${owner.adminId}`)).toBe(true);
			await pick('Period', 'thisMonth');
			expect(pushed('from=')).toBe(true);
			cleanup();
			const filtered = await admin.loadActivity(ownerBrowser.api, { merchantId }, owner);
			render(<ActivityView {...filtered} />);
			expect(shows('Clear filters')).toBe(true);
			cleanup();

			// ---------------------------------------------------------------- own activity pages
			const first = await ownerBrowser.api.get(`${adminApi.myActivity()}?limit=1`);
			if (!first.ok) throw new Error('my activity');
			withToasts(<OwnActivity path={adminApi.myActivity()} initial={first.data} />);
			await press('Load more');
			await until(() => document.querySelectorAll('tbody tr').length > 1);
			cleanup();

			// ---------------------------------------------------------------- Admins
			await world.adminOf('support');
			const admins = await admin.loadAdmins(ownerBrowser.api, owner);
			withToasts(<AdminsView {...admins} />);
			expect(shows('What this role can do') && shows('Everything in the Portal')).toBe(true);
			await openTab('Recent activity');
			await until(() =>
				ownerBrowser.calls.some((c) => c.path === `/v1/admin/activity?adminId=${owner.adminId}&limit=10` && c.status === 200),
			);
			await pick('Role', 'support');
			expect(shows('support admin')).toBe(true);
			await press('Open in Activity');
			expect(pushed(`/admin/activity?adminId=${owner.adminId}`)).toBe(true);
			cleanup();

			// ---------------------------------------------------------------- merchant console
			shop.b.use();
			withToasts(<MerchantOverview {...await loaders.loadOverview(shop.b.api, merchantId)} />);
			await openSection('Latest');
			for (const text of ['Recent activity', 'Latest credits added', 'seed-1']) expect(shows(text)).toBe(true);
			cleanup();
			withToasts(<WebsitesView {...await loaders.loadWebsites(shop.b.api, merchantId, websiteId)} />);
			await until(() =>
				shop.b.calls.some((c) => c.path.startsWith(`/v1/merchants/${merchantId}/usage?websiteId=`) && c.status === 200),
			);
			cleanup();
			withToasts(<CreditsView {...await loaders.loadCredits(shop.b.api, merchantId, {})} />);
			await pick('Period', 'lastMonth');
			expect(pushed('/credits?from=')).toBe(true);
		} finally {
			await world.close();
			restore();
		}
	});
});
