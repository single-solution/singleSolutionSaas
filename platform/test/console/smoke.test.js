/**
 * Server render of every merchant console page against a live in-process Portal: the Owner seeds a merchant with two
 * websites, connects two fake products, adds them to a website and switches features on; the merchant's pages
 * (Overview, the Websites screen with and without a website selected, Usage and credits, Account) render without
 * errors or React warnings and use the words of PLAN 0.0.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { closeMongoClients } from '../../src/testing.js';
import * as loaders from '../../src/console/loaders.js';
import { routes } from '../../src/console/paths.js';
import { adminApi, adminRoutes } from '../../src/console/admin/paths.js';
import { websitePartOf, sectionOf } from '../../src/console/website-parts.js';
import { ADMIN, CONSOLE, MORE, PRODUCTS, PROFILE, SETUP, WEBSITE, WEBSITE_SETTINGS } from '../../src/texts/console.js';
import { AccountView } from '../../src/console/views/account.js';
import { CreditsView } from '../../src/console/views/credits.js';
import { BillingBanner, DaysLeft, ProductStatusBadge, productStatusLabel, productTone } from '../../src/console/views/billing.js';
import { LocalTime } from '@ss/ui';
import { ConsoleShell, merchantSections } from '../../src/console/views/shell.js';
import { contactLine, homeOf } from '../../src/console/views/sign-in.js';
import { OverviewView, WebsiteView, WebsitesView } from '../../src/console/views/websites.js';
import { dailyCostOf, websiteDot } from '../../src/console/views/website.js';
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

const BRANDING = {
	name: 'Single Solution',
	accent: '#0f766e',
	logoUrl: null,
	support: { channels: [{ type: /** @type {const} */ ('email'), label: 'Email', url: 'mailto:help@ss.test' }] },
};

describe('merchant console smoke', () => {
	it('server-renders every merchant page', async () => {
		const world = await createWorld({ db: mongo.db('merchant_smoke') });
		try {
			const { b: merchant, me, merchantId } = await world.signup('owner@shop.test', 'Shop & Co');

			// no websites yet: the welcome with the support contact
			const empty = await loaders.loadOverview(merchant.api, merchantId);
			expect(text(ssr(<OverviewView {...empty} branding={BRANDING} />))).toContain(
				'Your admin will add your websites and products. Questions? Contact help@ss.test',
			);
			expect(
				text(ssr(<WebsitesView {...await loaders.loadWebsites(merchant.api, merchantId)} branding={BRANDING} />)),
			).toContain('Your admin will add your websites and products.');

			const site = await world.addWebsite(merchantId, 'shop.example.com');
			await world.addWebsite(merchantId, 'www.shop.example.com');
			const notes = await world.connect();
			await world.connect({ id: 'chatty', name: 'Chatty', widgets: false });
			await world.addProduct(merchantId, site.websiteId, 'notes');
			await world.addProduct(merchantId, site.websiteId, 'chatty');
			await world.credit(merchantId, 100_000, 'bank-1');
			await world.switchFeatures(notes, site.websiteId, ['notes']);

			// Overview: balance, the spend chart, websites with product chips and Open buttons
			const overview = await loaders.loadOverview(merchant.api, merchantId);
			const overviewText = text(ssr(<OverviewView {...overview} branding={BRANDING} />));
			// one page: the key numbers in the header, then the cards
			for (const section of ['Websites', 'Balance', 'Latest credits added']) expect(overviewText).toContain(section);
			expect(overviewText).toContain('shop.example.com');
			expect(overviewText).toContain('Notes');
			expect(overviewText).toContain('Chatty');
			expect(overviewText).toContain('No features on');
			expect(overviewText).toContain('Open');
			expect(overviewText).toContain('Your admin adds products to this website.'); // the second website

			// Websites with nothing in the URL: one list of rich rows (domain, status, products or what is left to do,
			// daily cost), each row a link to the website's own page, which stands beside it with its sections open
			const websitesRaw = ssr(<WebsitesView {...await loaders.loadWebsites(merchant.api, merchantId)} branding={BRANDING} />);
			const websitesText = text(websitesRaw);
			expect(websitesText).toContain('www.shop.example.com');
			expect(websitesRaw).toContain('data-ss-page');
			expect(websitesRaw).toContain(`href="/websites/${site.websiteId}"`);
			expect(websitesRaw).not.toContain('role="tab"');
			expect(websitesText).toContain('No products yet'); // the second website's row says what it lacks
			expect(websitesText).toContain('Chatty: no feature on yet');
			expect(websitesText).toContain('Open'); // the first website's page is open beside the list

			// a website: its own page, Websites › domain, the list beside it, its sections all open (status, products,
			// usage), no admin actions
			const selected = await loaders.loadWebsitePage(merchant.api, merchantId, String(site.websiteId), '');
			const selectedRaw = ssr(<WebsiteView {...selected} />);
			const selectedText = text(selectedRaw);
			expect(selectedRaw).toContain('aria-label="Breadcrumb"');
			expect(selectedRaw).toContain('href="/websites"');
			expect(selectedText).toContain('Notes');
			expect(selectedText).toContain('Chatty');
			expect(selectedText).toContain('No features on');
			for (const word of ['Settings', 'Share with developer', 'Add product', 'Daily cost', 'Open'])
				expect(selectedText).toContain(word);
			expect(selectedRaw).toContain(`href="/websites/${site.websiteId}"`); // its row in the list
			expect(selectedRaw).toContain('id="product-notes"');
			expect(selectedRaw).not.toContain('role="tab"');
			expect(selectedText).not.toContain('Remove website');
			// a part is its own address; one that does not exist says so
			const brand = await loaders.loadWebsitePage(merchant.api, merchantId, String(site.websiteId), 'settings/brand');
			expect(text(ssr(<WebsiteView {...brand} />))).toContain('Brand and look');
			const nonsense = await loaders.loadWebsitePage(merchant.api, merchantId, String(site.websiteId), 'nonsense/deeper');
			expect(text(ssr(<WebsiteView {...nonsense} />))).toContain('This page does not exist.');

			// another merchant's website is not found
			const other = await world.signup('else@else.test', 'Else Ltd');
			const foreign = await loaders.loadWebsitePage(other.b.api, other.merchantId, String(site.websiteId), '');
			expect(text(ssr(<WebsiteView {...foreign} />))).toContain('This website does not exist or was removed.');

			// Usage and credits, Account
			const credits = await loaders.loadCredits(merchant.api, merchantId, { from: '2026-01-01', websiteId: site.websiteId });
			const creditsRaw = ssr(<CreditsView {...credits} />);
			const creditsText = text(creditsRaw);
			// the page: Usage and credits with the money numbers in the header, Usage and Receipts as sections
			expect(creditsRaw).toContain('aria-label="Breadcrumb"');
			expect(creditsRaw).toContain('id="receipts"');
			expect(creditsText).toContain('Credit receipts');
			expect(creditsText).toContain('credits in total');
			expect(creditsText).not.toContain('Amount paid'); // admins only
			const receipts = text(ssr(<CreditsView {...await loaders.loadCredits(merchant.api, merchantId, {}, 'receipts')} />));
			expect(receipts).toContain('bank-1');
			expect(receipts).not.toContain('Amount paid'); // admins only
			expect(receipts).not.toContain('credits in total');
			expect(text(ssr(<AccountView {...await loaders.loadAccount(merchant.api, merchantId)} />))).toContain(
				'Business details',
			);

			// the frame
			const frame = await loaders.loadFrame(merchant.api, merchantId);
			const shell = text(
				ssr(
					<ConsoleShell me={me} websites={frame.websites} billing={frame.billing} branding={BRANDING}>
						<p>child</p>
					</ConsoleShell>,
				),
			);
			expect(shell).toContain('Usage and credits');
			expect(shell).toContain('www.shop.example.com');

			// failures render the page error
			expect(text(ssr(<OverviewView ok={false} problem={{ status: 500, title: 'Boom' }} />))).toContain(
				'This page could not be loaded',
			);
			expect(text(ssr(<WebsitesView ok={false} problem={{ status: 401, title: 'Unauthorized' }} />))).toContain('Sign in');
			expect(text(ssr(<CreditsView ok={false} problem={{ status: 404, title: 'Not found' }} />))).toContain('Not found');

			// the console client signs out like the browser does
			expect((await merchant.api.post('/v1/auth/sign-out')).ok).toBe(true);
			expect((await loaders.loadSession(merchant.api)).ok).toBe(false);
			expect((await loaders.loadOverview(merchant.api, merchantId)).ok).toBe(false);
			expect((await loaders.loadWebsites(merchant.api, merchantId)).ok).toBe(false);
			expect((await loaders.loadCredits(merchant.api, merchantId)).ok).toBe(false);
			expect((await loaders.loadAccount(merchant.api, merchantId)).ok).toBe(false);
			// an admin is not let into the merchant console
			expect(await loaders.loadSession(world.ownerBrowser.api)).toMatchObject({ ok: false, admin: true });
		} finally {
			await world.close();
		}
	});

	it('pure helpers of the views', () => {
		expect(homeOf('merchant', '/credits')).toBe('/credits');
		expect(homeOf('merchant', '//evil.example')).toBe('/overview');
		expect(homeOf('merchant', null)).toBe('/overview');
		expect(homeOf('merchant', '/admin/merchants')).toBe('/overview');
		expect(homeOf('admin', '/admin/merchants')).toBe('/admin/merchants');
		expect(homeOf('admin', '/credits')).toBe('/admin');
		expect(
			contactLine({
				channels: [
					{ type: 'email', label: 'Email', url: 'mailto:a@b.co' },
					{ type: 'link', label: 'WhatsApp', url: 'https://wa.me/15550100' },
				],
			}),
		).toBe('a@b.co (Email), https://wa.me/15550100 (WhatsApp)');
		expect(contactLine({ channels: [] })).toBe('support');
		expect(contactLine(null)).toBe('support');
		expect(routes.website('web_1')).toBe('/websites/web_1');
		expect(merchantSections('/websites/web_1')[0]?.items.map((i) => [i.label, i.current])).toEqual([
			['Overview', false],
			['Websites', true],
			['Usage and credits', false],
			['Account', false],
		]);
		// adaptability: Portal menus are platform jobs only — never a product id (PLAN §1 / §7)
		for (const id of ['accounts', 'chat', 'ecommerce', 'growth', 'notifications', 'notes', 'payments']) {
			expect(
				merchantSections('/overview')
					.flatMap((s) => s.items.map((i) => i.label))
					.join(' '),
			).not.toMatch(new RegExp(id, 'i'));
		}
		// status labels and colors (PLAN 0.6)
		expect(productTone({ status: 'active', featuresOn: [] })).toBe('neutral');
		expect(productTone({ status: 'active', featuresOn: ['a'] })).toBe('success');
		expect(productTone({ status: 'grace', featuresOn: ['a'] })).toBe('warning');
		expect(productTone({ status: 'stopped' })).toBe('danger');
		expect(productTone({ status: 'suspended', featuresOn: ['a'] })).toBe('danger');
		expect(productTone({ status: 'other', featuresOn: ['a'] })).toBe('neutral');
		expect(productStatusLabel({ status: 'grace', featuresOn: ['a'] })).toBe('In grace');
		expect(productStatusLabel({ status: 'other', featuresOn: ['a'] })).toBe('other');
		expect(text(ssr(<ProductStatusBadge status="active" />))).toContain('No features on');
		expect(text(ssr(<ProductStatusBadge status="stopped" featuresOn={['a']} />))).toContain('Stopped');
		// the status dot of a website in the list: the worst status of its products
		/** @param {string} status @param {string[]} [featuresOn] */
		const card = (status, featuresOn = ['a']) => ({ productId: status, name: status, status, featuresOn, dailyCost: 0 });
		expect(websiteDot([])).toBe('neutral');
		expect(websiteDot([card('active', [])])).toBe('neutral');
		expect(websiteDot([card('active')])).toBe('success');
		expect(websiteDot([card('active'), card('grace')])).toBe('warning');
		expect(websiteDot([card('grace'), card('stopped')])).toBe('danger');
		expect(dailyCostOf([{ productId: 'a', name: 'A', status: 'active', featuresOn: [], dailyCost: 24_000 }])).toBe(24_000);
		// billing banners and days left (PLAN 0.5.4)
		expect(ssr(<BillingBanner summary={null} contact="x" />)).toBe('');
		expect(ssr(<BillingBanner summary={{ status: 'active' }} contact="x" />)).toBe('');
		expect(text(ssr(<BillingBanner summary={{ status: 'low_balance', daysLeft: 2 }} contact="help@x" />))).toContain(
			'About 2 days left',
		);
		expect(text(ssr(<BillingBanner summary={{ status: 'low_balance', daysLeft: 0 }} contact="help@x" />))).toContain(
			'less than 1 day',
		);
		expect(
			text(ssr(<BillingBanner summary={{ status: 'grace', graceEnd: '2026-10-04T11:00:00.000Z' }} contact="help@x" />)),
		).toContain('Grace ends');
		expect(text(ssr(<BillingBanner summary={{ status: 'stopped' }} contact="help@x" />))).toContain('help@x');
		expect(text(ssr(<DaysLeft summary={{ stoppedAt: '2026-10-04T11:00:00.000Z' }} />))).toContain('Stopped since');
		expect(text(ssr(<DaysLeft summary={{ daysLeft: null }} />))).toContain('—');
		expect(text(ssr(<DaysLeft summary={{ daysLeft: 1 }} />))).toContain('1 day');
		// one date style (en-US): the server renders UTC; the browser then shows the viewer's own zone in the same style
		expect(text(ssr(<LocalTime value="2026-10-04T14:30:00.000Z" />)).trim()).toBe('Oct 4, 2026, 2:30 PM UTC');
		expect(ssr(<LocalTime value="2026-10-04T14:30:00.000Z" />)).toContain('dateTime="2026-10-04T14:30:00.000Z"');
		expect(text(ssr(<LocalTime value={null} />)).trim()).toBe('—');
		expect(
			text(ssr(<BillingBanner summary={{ status: 'grace', graceEnd: '2026-10-04T11:00:00.000Z' }} contact="help@x" />)),
		).toContain('Oct 4, 2026, 11:00 AM UTC');

		// website parts and address builders
		expect(websitePartOf('settings', 'business')).toBe('settings/business');
		expect(websitePartOf('install')).toBe('install');
		expect(sectionOf({ kind: 'product', id: 'notes' })).toBe('product-notes');
		expect(sectionOf(null)).toBeNull();
		expect(sectionOf({ kind: 'overview' })).toBeNull();
		expect(routes.websiteSetup('w1')).toBe('/websites/w1/setup');
		expect(routes.websiteSettings('w1', 'brand')).toBe('/websites/w1/settings/brand');
		expect(adminRoutes.websiteSetup('m1', 'w1')).toBe('/admin/merchants/m1/websites/w1/setup');
		expect(adminRoutes.websiteSettings('m1', 'w1', 'brand')).toBe('/admin/merchants/m1/websites/w1/settings/brand');
		expect(adminRoutes.adminPart('p1', 's1')).toBe('/admin/admins/p1/s1');
		expect(adminRoutes.account()).toBe('/admin/account');
		expect(adminApi.adminTwoStepOff('a1')).toBe('/v1/admin/admins/a1/two-step/off');
		expect(adminApi.settingsBilling()).toBe('/v1/admin/settings/billing');

		// console text helpers
		expect(CONSOLE.pageFailed('E-123')).toContain('E-123');
		expect(CONSOLE.pageFailed(undefined)).toContain('This page failed');
		expect(WEBSITE.productsCount(1)).toBe('1 product');
		expect(WEBSITE.productsCount(3)).toBe('3 products');
		expect(WEBSITE.productsOf('example.com')).toBe('Products on example.com');
		expect(WEBSITE.featuresOn(1)).toBe('1 feature on');
		expect(WEBSITE.featuresOn(2)).toBe('2 features on');
		expect(WEBSITE.productTrouble('Notes', 'unreachable')).toBe('Notes: unreachable');
		expect(SETUP.alsoSwitches('Core')).toContain('Core');
		expect(PROFILE.otherTooMany(5)).toContain('5');
		expect(PROFILE.otherTooLong(50)).toContain('50');
		expect(PRODUCTS.websitesCount(1)).toBe('1 website');
		expect(PRODUCTS.websitesCount(2)).toBe('2 websites');
		expect(ADMIN.productWebsites(1)).toBe('1 website');
		expect(ADMIN.productWebsites(2)).toBe('2 websites');
		expect(ADMIN.productEarned('50')).toContain('50 earned');
		expect(ADMIN.showing(1, 10, true)).toContain('1–10');
		expect(ADMIN.selectMerchant('Alice')).toContain('Alice');
		expect(ADMIN.moreActions('Alice')).toContain('Alice');
		expect(ADMIN.mail.testSent('test@example.com')).toContain('test@example.com');
		expect(MORE.productMenu('Notes')).toContain('Notes actions');
		expect(WEBSITE_SETTINGS.region.symbolsCount(1)).toBe('1 symbol');
		expect(WEBSITE_SETTINGS.region.symbolsCount(5)).toBe('5 symbols');
		expect(WEBSITE_SETTINGS.region.regionsCount(1)).toBe('1 country');
		expect(WEBSITE_SETTINGS.region.regionsCount(5)).toBe('5 countries');
	});
});
