/**
 * End-to-end smoke of the Merchant Console: boots the Portal in-process (every module, MongoMemory), signs a
 * merchant up through the console API client (public API only), seeds a listed product as staff, adds a website,
 * subscribes and configures it, then server-renders every main console page (renderToString) and checks that each
 * renders without errors or React warnings.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { totpCode } from '../../src/infra/auth.js';
import { closeMongoClients } from '../../src/infra/db.js';
import { createPortal } from '../../src/portal.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { createIdentityModule } from '../../src/modules/identity/index.js';
import * as loaders from '../../src/console/loaders.js';
import { AccountView } from '../../src/console/views/account.js';
import {
	AcceptInviteView,
	ForgotPasswordView,
	LoginView,
	ResetPasswordView,
	SignupView,
	VerifyEmailView,
	safeNext,
} from '../../src/console/views/auth.js';
import { ConnectorsView, buildCredentials, credentialFields } from '../../src/console/views/connectors.js';
import { CreditsView, SpendCapView } from '../../src/console/views/credits.js';
import { KeysView } from '../../src/console/views/keys.js';
import { ProductsView, hourlyEstimate } from '../../src/console/views/products.js';
import { ConsoleShell, balanceState } from '../../src/console/views/shell.js';
import { SubscriptionView, availability, requestedOn } from '../../src/console/views/subscription.js';
import { ConfigurePanel, effectiveValues, featureLocks } from '../../src/console/views/configure.js';
import { TeamView } from '../../src/console/views/team.js';
import { UsageView, spendBreakdown } from '../../src/console/views/usage.js';
import { OnboardingView, WebsiteOverviewView, WebsitesView } from '../../src/console/views/websites.js';
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
		const portal = createPortal({ config: await testConfig(), db: mongo.db('console_smoke'), modules, logger });
		await portal.ensureIndexes();
		/** @param {string} to @param {string} template */
		const tokenOf = (to, template) => {
			const message = [...mail].reverse().find((m) => m.to === to && m.template === template);
			return decodeURIComponent(String(message?.data.link).split('#token=')[1] ?? '');
		};

		// ---------------------------------------------------------------- sign up through the API client
		const merchant = client(portal);
		const anonymous = await merchant.api.get('/v1/me');
		expect(anonymous).toMatchObject({ ok: false, status: 401 });
		expect(await loaders.loadSession(merchant.api)).toMatchObject({ ok: false, status: 401 });
		const signup = await merchant.api.post('/v1/auth/merchant/signup', {
			email: 'owner@shop.test',
			password: 'correct horse battery',
			merchantName: 'Shop & Co',
		});
		expect(signup).toMatchObject({ ok: true, status: 202 });
		const verified = await merchant.api.post('/v1/auth/merchant/verify-email', {
			token: tokenOf('owner@shop.test', 'verify_email'),
		});
		expect(verified.ok).toBe(true);
		const session = await loaders.loadSession(merchant.api);
		if (!session.ok) throw new Error('no session');
		const merchantId = /** @type {string} */ (session.merchantId);

		// onboarding before any website
		expect(text(ssr(<OnboardingView {...await loaders.loadOnboarding(merchant.api, merchantId, undefined)} />))).toContain(
			'Add your website',
		);
		expect(text(ssr(<WebsitesView {...await loaders.loadWebsites(merchant.api, merchantId)} />))).toContain(
			'Add your first website',
		);

		const added = await merchant.api.post(`/v1/merchants/${merchantId}/websites`, { domain: 'shop.example.com' });
		expect(added.ok).toBe(true);
		const websiteId = added.ok ? added.data.website.websiteId : '';
		const twinId = added.ok ? added.data.twin.websiteId : '';

		// ---------------------------------------------------------------- staff seeds a listed product and credits
		const staff = client(portal);
		// the first admin (created from the sign-in page), given an e-mail in Account settings
		const staffPassword = 'staff password 123!';
		await staff.api.post('/v1/auth/staff/first-admin', { password: staffPassword });
		await staff.api.request('PATCH', '/v1/me', { email: 'staff@ss.test' });
		expect((await staff.api.post('/v1/auth/staff/login', { email: 'staff@ss.test', password: staffPassword })).ok).toBe(true);
		const enrol = await staff.api.post('/v1/auth/staff/mfa/enrol');
		expect(
			(await staff.api.post('/v1/auth/staff/mfa/confirm', { code: totpCode(enrol.ok ? enrol.data.secret : '', Date.now()) }))
				.ok,
		).toBe(true);
		const appId = await uploadPack(staff.fetch);
		const credit = await staff.api.post(`/v1/admin/merchants/${merchantId}/credits`, {
			amountMillicredits: 250_000,
			reference: 'bank-1',
			note: 'wire',
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

		const subscribed = await merchant.api.post(`/v1/merchants/${merchantId}/websites/${websiteId}/subscriptions`, {
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
		expect((await merchant.api.request('PUT', `/v1/merchants/${merchantId}/spend-cap`, { limit: 50_000 })).ok).toBe(true);
		expect(
			(await merchant.api.post(`/v1/merchants/${merchantId}/team/invites`, { email: 'dev@shop.test', roles: ['developer'] }))
				.ok,
		).toBe(true);

		// ---------------------------------------------------------------- render the console
		const frame = await loaders.loadFrame(merchant.api, merchantId);
		expect(frame.websites.map((w) => w.websiteId).sort()).toEqual([websiteId, twinId].sort());
		const shell = text(
			ssr(
				<ConsoleShell me={session.me} merchantId={merchantId} websites={frame.websites} meter={frame.meter}>
					<p>child</p>
				</ConsoleShell>,
			),
		);
		expect(shell).toContain('Shop & Co');
		expect(shell).toContain('Websites');
		expect(shell).toContain('child');

		const websitesHtml = text(ssr(<WebsitesView {...await loaders.loadWebsites(merchant.api, merchantId)} />));
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
		expect(text(ssr(<UsageView {...usage} />))).toContain('Spend per day');

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
		).toContain('Statement');

		const cap = await loaders.loadSpendCap(merchant.api, merchantId);
		expect(text(ssr(<SpendCapView {...cap} />))).toContain('50 credits');

		const team = await loaders.loadTeam(merchant.api, merchantId, session.me);
		const teamHtml = text(ssr(<TeamView {...team} />));
		expect(teamHtml).toContain('owner@shop.test');
		expect(teamHtml).toContain('dev@shop.test');

		const account = await loaders.loadAccount(merchant.api, merchantId);
		expect(text(ssr(<AccountView {...account} />))).toContain('Two-factor authentication');

		const onboarding = await loaders.loadOnboarding(merchant.api, merchantId, websiteId);
		expect(text(ssr(<OnboardingView {...onboarding} />))).toContain('Connect resources for shop.example.com');

		// public pages
		for (const view of [
			<LoginView key="l" next="/credits" expired />,
			<SignupView key="s" />,
			<VerifyEmailView key="v" />,
			<ForgotPasswordView key="f" />,
			<ResetPasswordView key="r" />,
			<AcceptInviteView key="a" />,
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
		expect((await loaders.loadSession(staff.api)).ok).toBe(false);

		// the console client signs out like the browser does
		expect((await merchant.api.post('/v1/auth/merchant/logout')).ok).toBe(true);
		expect((await merchant.api.get('/v1/me')).status).toBe(401);
	});

	it('pure helpers of the views', () => {
		expect(safeNext('/credits')).toBe('/credits');
		expect(safeNext('//evil.example')).toBe('/websites');
		expect(safeNext('https://evil.example')).toBe('/websites');
		expect(safeNext(null)).toBe('/websites');
		expect(balanceState(null)).toBeNull();
		expect(balanceState({ balanceMillicredits: 0, burnRatePerHour: 1000, subscriptions: [] })).toBe('empty');
		expect(balanceState({ balanceMillicredits: 5000, burnRatePerHour: 1000, hoursRemaining: 5 })).toBe('low');
		expect(balanceState({ balanceMillicredits: 5000, burnRatePerHour: 0, hoursRemaining: null })).toBeNull();
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
		const spend = spendBreakdown([
			{
				type: 'settlement',
				amountMillicredits: -1750,
				periodStart: '2026-10-01T10:00:00.000Z',
				appId: 'app_1',
				details: {
					breakdown: [
						{ kind: 'base', amount: 0 },
						{ kind: 'element', element: 'bar', amount: 1250 },
						{ kind: 'element', element: 'badge', amount: 500 },
					],
				},
			},
			{
				type: 'metered',
				amountMillicredits: -30,
				at: '2026-10-02T00:00:00.000Z',
				appId: 'app_1',
				details: { lines: [{ unit: 'view', quantity: 3, amount: 30 }] },
			},
			{ type: 'deposit', amountMillicredits: 5000, at: '2026-10-01T00:00:00.000Z' },
		]);
		expect(spend.total).toBe(1780);
		expect([...spend.byDay]).toEqual([
			['2026-10-01', 1750],
			['2026-10-02', 30],
		]);
		expect(spend.byElement.get('app_1:bar')).toBe(1250);
		expect(spend.byUnit.get('app_1:view')).toEqual({ amount: 30, quantity: 3 });
	});
});
