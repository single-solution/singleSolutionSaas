/**
 * Server render of every merchant console page against a live in-process Portal: the Owner seeds a merchant with two
 * websites, connects two fake products, adds them to a website and switches features on; the merchant's pages
 * (Overview, Websites, the website page with each tab, Usage and credits, Account) render without errors or React
 * warnings and use the words of PLAN 0.0.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { closeMongoClients } from '../../src/infra/db.js';
import * as loaders from '../../src/console/loaders.js';
import { routes, websiteTab } from '../../src/console/paths.js';
import { AccountView } from '../../src/console/views/account.js';
import { CreditsView } from '../../src/console/views/credits.js';
import { BillingBanner, DaysLeft, ProductStatusBadge, productStatusLabel, productTone } from '../../src/console/views/billing.js';
import { ConsoleShell, merchantSections } from '../../src/console/views/shell.js';
import { contactLine, homeOf } from '../../src/console/views/sign-in.js';
import { OverviewView, WebsiteView, WebsitesView } from '../../src/console/views/websites.js';
import { ProductChips, dailyCostOf, scriptTag } from '../../src/console/views/website.js';
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

const BRANDING = {
	name: 'Single Solution',
	accent: '#4f46e5',
	logoUrl: null,
	support: { email: 'help@ss.test', phone: null, whatsapp: null },
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
			expect(overviewText).toContain('Spend per UTC day (last 30 days)');
			expect(overviewText).toContain('shop.example.com');
			expect(overviewText).toContain('Notes');
			expect(overviewText).toContain('Chatty');
			expect(overviewText).toContain('No features on');
			expect(overviewText).toContain('Open');
			expect(overviewText).toContain('Your admin adds products to this website.'); // the second website

			// Websites: domain, product chips, daily cost
			const websitesText = text(
				ssr(<WebsitesView {...await loaders.loadWebsites(merchant.api, merchantId)} branding={BRANDING} />),
			);
			expect(websitesText).toContain('www.shop.example.com');
			expect(websitesText).toContain('Notes ( Active )');
			expect(websitesText).toContain('Chatty ( No features on )');

			// the website page: Products (cards, Open; no admin actions), Install and tokens, Usage
			for (const tab of ['products', 'install', 'usage']) {
				const page = await loaders.loadWebsite(merchant.api, merchantId, site.websiteId, tab);
				const html = text(ssr(<WebsiteView {...page} />));
				expect(html).toContain('shop.example.com');
				expect(html).toContain('Shop & Co');
				expect(html).toContain('Install and tokens');
				expect(html).not.toContain('Add product');
				expect(html).not.toContain('Website actions');
			}
			const install = await loaders.loadWebsite(merchant.api, merchantId, site.websiteId, 'install');
			if (!install.ok) throw new Error('install');
			expect(install.tokens?.map((t) => t.productId)).toEqual(['chatty', 'notes']);
			const installText = text(ssr(<WebsiteView {...install} />));
			const notesToken = /** @type {any} */ (install.tokens?.find((t) => t.productId === 'notes'));
			expect(installText).toContain(scriptTag(notesToken.widgetScriptUrl, notesToken.browserToken));
			expect(installText).toContain('Browser token');
			expect(installText).toContain('Server token');
			expect(installText).toContain('Docs');
			// a product without widgets has no script tag
			expect(installText.match(/data-token=/g)).toHaveLength(1);
			const usage = await loaders.loadWebsite(merchant.api, merchantId, site.websiteId, 'usage');
			expect(text(ssr(<WebsiteView {...usage} />))).toContain('Spend per UTC day');

			// another merchant's website is not found
			const other = await world.signup('else@else.test', 'Else Ltd');
			const foreign = await loaders.loadWebsite(other.b.api, other.merchantId, site.websiteId);
			expect(foreign.ok).toBe(false);
			expect(text(ssr(<WebsiteView {...foreign} />))).toContain('Back to websites');

			// Usage and credits, Account
			const credits = await loaders.loadCredits(merchant.api, merchantId, { from: '2026-01-01', websiteId: site.websiteId });
			const creditsText = text(ssr(<CreditsView {...credits} />));
			expect(creditsText).toContain('Credit receipts');
			expect(creditsText).not.toContain('Amount paid'); // admins only
			expect(text(ssr(<AccountView {...await loaders.loadAccount(merchant.api, merchantId)} />))).toContain(
				'Business details',
			);

			// the frame
			const frame = await loaders.loadFrame(merchant.api, merchantId);
			const shell = text(
				ssr(
					<ConsoleShell
						me={me}
						merchantId={merchantId}
						websites={frame.websites}
						billing={frame.billing}
						branding={BRANDING}>
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
		expect(contactLine({ email: 'a@b.co', phone: '+1', whatsapp: '+2' })).toBe('a@b.co, +1, WhatsApp +2');
		expect(contactLine(null)).toBe('support');
		expect(routes.website('web_1', 'install')).toBe('/websites/web_1?tab=install');
		expect(routes.website('web_1', 'products')).toBe('/websites/web_1');
		expect(websiteTab('usage')).toBe('usage');
		expect(websiteTab('keys')).toBe('products');
		expect(merchantSections('/websites/web_1')[0]?.items.map((i) => [i.label, i.current])).toEqual([
			['Overview', false],
			['Websites', true],
			['Usage and credits', false],
			['Account', false],
		]);
		// status labels and colours (PLAN 0.6)
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
		expect(text(ssr(<ProductChips cards={[]} />))).toContain('—');
		expect(dailyCostOf([{ productId: 'a', name: 'A', status: 'active', featuresOn: [], dailyCost: 24_000 }])).toBe(24_000);
		expect(scriptTag('https://p.example/widget.js', 'tok')).toBe(
			'<script src="https://p.example/widget.js" data-token="tok" async></script>',
		);
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
	});
});
