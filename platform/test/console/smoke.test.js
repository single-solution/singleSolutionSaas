/**
 * End-to-end smoke of the Merchant Console: boots the Portal in-process (every module, MongoMemory), creates the
 * first admin and a merchant (setup link) through the console API client (public API only), seeds a listed product,
 * adds a website and a product as the admin, configures it as the merchant, then server-renders every main console
 * page (renderToString) and checks that each renders without errors or React warnings.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { closeMongoClients } from '../../src/infra/db.js';
import { createPortal } from '../../src/portal.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { createIdentityModule } from '../../src/modules/identity/index.js';
import * as loaders from '../../src/console/loaders.js';
import { AccountView } from '../../src/console/views/account.js';
import {
	ConfirmEmailView,
	ForgotPasswordView,
	ResetPasswordView,
	SetPasswordView,
	SignInView,
	contactLine,
	homeOf,
} from '../../src/console/views/sign-in.js';
import { ConnectorsView, buildCredentials, credentialFields } from '../../src/console/views/connectors.js';
import { CreditsView } from '../../src/console/views/credits.js';
import { BillingBanner, DaysLeft, ProductStatusBadge } from '../../src/console/views/billing.js';
import { KeysView } from '../../src/console/views/keys.js';
import { ProductsView, hourlyEstimate } from '../../src/console/views/products.js';
import { ConsoleShell } from '../../src/console/views/shell.js';
import { SubscriptionView, availability, requestedOn } from '../../src/console/views/subscription.js';
import { ConfigurePanel, effectiveValues, featureLocks } from '../../src/console/views/configure.js';
import { UsageView } from '../../src/console/views/usage.js';
import { WebsiteOverviewView, WebsitesView } from '../../src/console/views/websites.js';
import { createTestLogger, startMongo, testConfig } from '../helpers.js';
import { browserOf as client, uploadPack, withMemoryStorage } from './merchant-harness.js';

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
		.replace(/\s+/g, ' ');

describe('merchant console smoke', () => {
	it('signs up, adds a website, subscribes and server-renders every console page', async () => {
		/** @type {Array<{ to: string, template: string, data: Record<string, any> }>} */
		const mail = [];
		const mailer = { available: true, send: async (/** @type {any} */ m) => void mail.push(m) };
		const modules = withMemoryStorage(
			defaultModules.map((m) => (m.name === 'identity' ? createIdentityModule({ mailer }) : m)),
		);
		const { logger } = createTestLogger();
		const portal = createPortal({
			config: await testConfig(),
			db: mongo.db('console_smoke'),
			modules,
			logger,
			background: { mode: 'on', fallback: (task) => void task() },
		});
		await portal.ensureIndexes();
		/** @param {string} to @param {string} template */
		const tokenOf = (to, template) => {
			const message = [...mail].reverse().find((m) => m.to === to && m.template === template);
			return decodeURIComponent(String(message?.data.link).split('#token=')[1] ?? '');
		};

		// ---------------------------------------------------------------- the first admin, then a merchant (setup link)
		const staff = client(portal);
		const staffPassword = 'staff password 123!';
		expect(
			(await staff.api.post('/v1/auth/first-admin', { name: 'Olivia Owner', email: 'staff@ss.test', password: staffPassword }))
				.ok,
		).toBe(true);
		const merchant = client(portal);
		const anonymous = await merchant.api.get('/v1/me');
		expect(anonymous).toMatchObject({ ok: false, status: 401 });
		expect(await loaders.loadSession(merchant.api)).toMatchObject({ ok: false, status: 401 });
		expect(await loaders.loadSession(staff.api)).toMatchObject({ ok: false, status: 403, admin: true });
		const created = await staff.api.post('/v1/admin/merchants', {
			name: 'Shop & Co',
			ownerName: 'Sam',
			email: 'owner@shop.test',
		});
		expect(created.ok).toBe(true);
		const set = await merchant.api.post('/v1/auth/set-password', {
			token: tokenOf('owner@shop.test', 'merchant_setup'),
			password: 'correct horse battery',
		});
		expect(set.ok).toBe(true);
		const session = await loaders.loadSession(merchant.api);
		if (!session.ok) throw new Error('no session');
		const merchantId = /** @type {string} */ (session.merchantId);

		// before any website: the welcome with the support contact
		const branding = {
			name: 'Single Solution',
			accent: '#4f46e5',
			logoUrl: null,
			support: { email: 'help@ss.test', phone: null, whatsapp: null },
		};
		const welcome = text(ssr(<WebsitesView {...await loaders.loadWebsites(merchant.api, merchantId)} branding={branding} />));
		expect(welcome).toContain('Your admin will add your websites and products.');
		expect(welcome).toContain('help@ss.test');

		const added = await staff.api.post(`/v1/merchants/${merchantId}/websites`, { domain: 'shop.example.com' });
		expect(added.ok).toBe(true);
		const websiteId = added.ok ? added.data.website.websiteId : '';
		const twinId = added.ok ? added.data.twin.websiteId : '';

		// ---------------------------------------------------------------- the admin seeds a listed product and credits
		const appId = await uploadPack(staff.fetch);
		const credit = await staff.api.post(`/v1/admin/merchants/${merchantId}/receipts`, {
			credits: 250,
			amountPaid: 'PKR 25,000',
			method: 'Bank transfer',
			reference: 'bank-1',
		});
		expect(credit.ok).toBe(true);

		// ---------------------------------------------------------------- merchant: subscribe, configure, keys, team
		const products = await loaders.loadProducts(merchant.api, merchantId, websiteId);
		expect(products.ok).toBe(true);
		const productsHtml = text(ssr(<ProductsView {...products} />));
		expect(productsHtml).toContain('Notice bar');
		expect(productsHtml).toContain('1.25 credits/h');
		const catalogEntry = products.ok ? products.catalog[0] : null;
		expect(hourlyEstimate(catalogEntry, 'plus')).toBe(1750);
		expect(hourlyEstimate(catalogEntry, null)).toBe(1750);

		const subscribed = await staff.api.post(`/v1/merchants/${merchantId}/websites/${websiteId}/subscriptions`, {
			appId,
			planCode: 'basic',
		});
		expect(subscribed.ok).toBe(true);
		const subscriptionId = subscribed.ok ? subscribed.data.subscription.subscriptionId : '';
		const configPath = `/v1/merchants/${merchantId}/websites/${websiteId}/subscriptions/${subscriptionId}/config`;
		const patched = await merchant.api.request('PATCH', configPath, {
			features: { 'bar.message': { value: 'Free shipping' }, 'bar.maxPerDay': { value: 99 } },
		});
		expect(patched.ok).toBe(true);
		expect(
			(
				await merchant.api.post(`/v1/merchants/${merchantId}/websites/${websiteId}/keys`, {
					kind: 'pk',
					scopes: ['events.write'],
				})
			).ok,
		).toBe(true);

		// ---------------------------------------------------------------- render the console
		const frame = await loaders.loadFrame(merchant.api, merchantId);
		expect(frame.websites.map((w) => w.websiteId).sort()).toEqual([websiteId, twinId].sort());
		const shell = text(
			ssr(
				<ConsoleShell me={session.me} merchantId={merchantId} websites={frame.websites} billing={frame.billing}>
					<p>child</p>
				</ConsoleShell>,
			),
		);
		expect(shell).toContain('Shop & Co');
		expect(shell).toContain('Websites');
		expect(shell).toContain('child');

		const websitesHtml = text(
			ssr(<WebsitesView {...await loaders.loadWebsites(merchant.api, merchantId)} branding={branding} />),
		);
		expect(websitesHtml).toContain('shop.example.com');

		const overview = await loaders.loadWebsiteOverview(merchant.api, merchantId, websiteId);
		expect(text(ssr(<WebsiteOverviewView {...overview} />))).toContain('Notice bar');
		expect(
			text(ssr(<WebsiteOverviewView {...await loaders.loadWebsiteOverview(merchant.api, merchantId, twinId)} />)),
		).toContain('test twin');

		const detail = await loaders.loadSubscription(merchant.api, merchantId, websiteId, subscriptionId);
		expect(detail.ok).toBe(true);
		if (!detail.ok) throw new Error('subscription');
		expect(detail.effective?.features?.['bar.maxPerDay']).toMatchObject({ value: 5, reason: 'clamped' });
		const element = detail.product.elements.find((/** @type {any} */ e) => e.key === 'bar');
		expect(effectiveValues(element, detail.effective)).toMatchObject({ message: 'Free shipping', maxPerDay: 5, tone: 'info' });
		expect(featureLocks(element, detail.effective, detail.overview?.layers)).toEqual({});
		expect(
			featureLocks(element, { features: { 'bar.tone': { value: 'info', source: 'admin_override', locked: true } } }, null),
		).toEqual({ tone: { label: 'Set by admin' } });
		expect(requestedOn(detail.subscription, detail.product, 'bar')).toBe(true);
		expect(requestedOn(detail.subscription, detail.product, 'badge')).toBe(false);
		expect(availability(detail.subscription, detail.product, 'badge')).toBe('addon');
		const subHtml = text(ssr(<SubscriptionView {...detail} />));
		expect(subHtml).toContain('Notice bar');
		expect(subHtml).toContain('Trust badge');
		expect(subHtml).toContain('Add-on');
		const panelProps = { merchantId, website: detail.website, subscription: detail.subscription, product: detail.product };
		const configureHtml = text(
			ssr(
				<ConfigurePanel {...panelProps} overview={detail.overview} effective={detail.effective} onSaved={() => undefined} />,
			),
		);
		expect(configureHtml).toContain('Free shipping');
		expect(configureHtml).toContain('Plan max 5');
		expect(configureHtml).toContain('limited by your plan');
		expect(configureHtml).toContain('Advanced settings (1)');
		expect(
			text(
				ssr(
					<ConfigurePanel
						{...panelProps}
						product={{ elements: [] }}
						overview={null}
						effective={null}
						onSaved={() => undefined}
					/>,
				),
			),
		).toContain('Nothing to configure');

		const usage = await loaders.loadUsage(merchant.api, merchantId, websiteId, { from: '2026-01-01', to: '2026-12-31' });
		expect(usage.ok).toBe(true);
		expect(text(ssr(<UsageView {...usage} />))).toContain('Spend per UTC day');

		const keys = await loaders.loadKeys(merchant.api, merchantId, websiteId);
		const keysHtml = text(ssr(<KeysView {...keys} />));
		expect(keysHtml).toContain('pk_live_');
		// a key is never re-displayed: only its hint is listed
		expect(keys.ok && keys.keys.every((/** @type {any} */ k) => !('key' in k))).toBe(true);

		const resources = await loaders.loadResources(merchant.api, merchantId, websiteId);
		expect(text(ssr(<ConnectorsView {...resources} />))).toContain('What this website uses');

		const credits = await loaders.loadCredits(merchant.api, merchantId, { websiteId: 'not-an-id' });
		const creditsHtml = text(ssr(<CreditsView {...credits} />));
		expect(creditsHtml).toContain('250 credits');
		expect(
			text(
				ssr(
					<CreditsView
						{...await loaders.loadCredits(merchant.api, merchantId, { from: '2026-01-01', to: '2026-12-31', websiteId })}
					/>,
				),
			),
		).toContain('Credit receipts');

		const account = await loaders.loadAccount(merchant.api, merchantId);
		const accountHtml = text(ssr(<AccountView {...account} />));
		expect(accountHtml).toContain('Business details');
		expect(accountHtml).toContain('Two-step sign-in');
		expect(accountHtml).toContain('Your activity');

		// public pages
		for (const view of [
			<SignInView key="l" branding={branding} firstAdmin={false} next="/credits" notice="expired" />,
			<SignInView key="r" branding={branding} firstAdmin={false} notice="reset" />,
			<SignInView key="e" branding={{ ...branding, logoUrl: '/branding/logo' }} firstAdmin={false} notice="email" />,
			<SignInView key="c" branding={branding} firstAdmin />,
			<ForgotPasswordView key="f" branding={branding} />,
			<ResetPasswordView key="p" branding={branding} />,
			<SetPasswordView key="s" branding={branding} />,
			<ConfirmEmailView key="m" branding={branding} />,
		])
			ssr(view);

		// ---------------------------------------------------------------- failures render friendly states
		const missing = await loaders.loadKeys(merchant.api, merchantId, 'web_0000000000000000000000000z');
		expect(missing).toMatchObject({ ok: false, status: 404 });
		expect(text(ssr(<KeysView {...missing} />))).toContain('Not found');
		const foreign = await loaders.loadSubscription(merchant.api, merchantId, twinId, subscriptionId);
		expect(foreign).toMatchObject({ ok: false, status: 404 });
		expect(text(ssr(<SubscriptionView {...foreign} />))).toContain('another website');
		const otherMerchant = await loaders.loadWebsites(merchant.api, 'mer_0123456789abcdefghjkmnpq');
		expect(otherMerchant).toMatchObject({ ok: false, status: 403 });
		expect(text(ssr(<WebsitesView {...otherMerchant} />))).toContain('No access');

		// the console client signs out like the browser does
		expect((await merchant.api.post('/v1/auth/sign-out')).ok).toBe(true);
		expect((await merchant.api.get('/v1/me')).status).toBe(401);
	});

	it('pure helpers of the views', () => {
		expect(homeOf('merchant', '/credits')).toBe('/credits');
		expect(homeOf('merchant', '//evil.example')).toBe('/websites');
		expect(homeOf('merchant', 'https://evil.example')).toBe('/websites');
		expect(homeOf('merchant', null)).toBe('/websites');
		expect(homeOf('merchant', '/admin/merchants')).toBe('/websites');
		expect(homeOf('admin', '/admin/merchants')).toBe('/admin/merchants');
		expect(homeOf('admin', '/credits')).toBe('/admin');
		expect(contactLine({ email: 'a@b.co', phone: '+1', whatsapp: '+2' })).toBe('a@b.co, +1, WhatsApp +2');
		expect(contactLine(null)).toBe('support');
		// billing banners, status labels and days left (PLAN 0.5.4, 0.6)
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
		expect(text(ssr(<ProductStatusBadge status="active" />))).toContain('No features on');
		expect(text(ssr(<ProductStatusBadge status="grace" featuresOn={['a']} />))).toContain('In grace');
		const fields = credentialFields('database', 'mongodb');
		expect(buildCredentials('database', fields, { uri: ' mongodb+srv://u:p@h/db ' })).toEqual({
			credentials: { uri: ' mongodb+srv://u:p@h/db ' },
			errors: {},
		});
		expect(buildCredentials('database', fields, {}).errors).toEqual({ uri: 'Connection string is required.' });
		expect(
			buildCredentials('payments', credentialFields('payments', 'stripe'), { _pairs: 'publishableKey=pk\nsecretKey=sk' })
				.credentials,
		).toEqual({
			publishableKey: 'pk',
			secretKey: 'sk',
		});
		expect(buildCredentials('payments', credentialFields('payments', 'stripe'), { _pairs: 'bad line' }).errors._pairs).toMatch(
			/NAME=value/,
		);
		expect(
			buildCredentials('messaging', credentialFields('messaging', 'smtp'), {
				host: 'h',
				username: 'u',
				password: 'p',
				port: 'x',
				secure: true,
			}),
		).toEqual({
			credentials: { host: 'h', username: 'u', password: 'p', secure: true },
			errors: { port: 'Enter a whole number.' },
		});
		for (const [kind, provider] of /** @type {const} */ ([
			['storage', 'r2'],
			['ai', 'generic'],
			['messaging', 'generic-http'],
		]))
			expect(credentialFields(kind, provider).length).toBeGreaterThan(2);
		expect(credentialFields('other', 'x')).toEqual([]);
	});
});
