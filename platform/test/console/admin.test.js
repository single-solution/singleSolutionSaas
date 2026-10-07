/**
 * End-to-end smoke of the Admin Console: boots the Portal in-process (every module, MongoMemory), creates the first
 * admin (an Owner) on the one sign-in page and signs in again with two-step, seeds a merchant with a website, an
 * active pack (descriptor + assets uploaded) and a product on the website with admin overrides, then server-renders
 * every admin page (renderToString) and checks that each renders without errors or React warnings.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createHash } from 'node:crypto';
import { sessionCookieName, totpCode } from '../../src/infra/auth.js';
import { closeMongoClients } from '../../src/infra/db.js';
import { createPortal } from '../../src/portal.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { createIdentityModule } from '../../src/modules/identity/index.js';
import { createConsoleApi } from '../../src/console/api.js';
import * as loaders from '../../src/console/loaders.js';
import * as admin from '../../src/console/admin/loaders.js';
import { adminApi, adminRoutes, query } from '../../src/console/admin/paths.js';
import { AdminShell, adminSections } from '../../src/console/admin/views/shell.js';
import { MerchantView, MerchantsView } from '../../src/console/admin/views/merchants.js';
import { OverviewView } from '../../src/console/admin/views/overview.js';
import { ActivityView } from '../../src/console/admin/views/activity.js';
import { AdminsView } from '../../src/console/admin/views/admins.js';
import { MyAccountView } from '../../src/console/admin/views/account.js';
import { SettingsView } from '../../src/console/admin/views/settings.js';
import { AppView, AppsView } from '../../src/console/admin/views/apps.js';
import {
	PoliciesView,
	SubscriptionAdminView,
	SubscriptionLookupView,
	effectiveRows,
} from '../../src/console/admin/views/config.js';
import { FinanceView, MerchantCredits } from '../../src/console/admin/views/finance.js';
import { ConnectorsAdminView, checkSummary } from '../../src/console/admin/views/operations.js';
import { layerChange, layerValues } from '../../src/console/admin/views/layer.js';
import { adminCan } from '../../src/console/admin/views/common.js';
import { createSystemStore } from '../../src/infra/system.js';
import { ENCRYPTION_KEY, PORTAL_URL, createClock, createTestLogger, startMongo, testConfig } from '../helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
});
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

/** A cookie-following console API client (a signed-in browser session). */
const client = (/** @type {import('../../src/portal.js').Portal} */ portal) => {
	/** @type {Map<string, string>} */
	const jar = new Map();
	const api = createConsoleApi({
		handle: portal.handle,
		baseUrl: PORTAL_URL,
		cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ') || null,
		onSetCookie: (list) => {
			for (const set of list) {
				const [pair = ''] = set.split(';');
				const i = pair.indexOf('=');
				const name = pair.slice(0, i);
				const value = pair.slice(i + 1);
				if (value) jar.set(name, value);
				else jar.delete(name);
			}
		},
	});
	return { api, jar };
};

const packManifest = () => ({
	ssps: '1',
	product: {
		slug: 'notice-bar',
		name: 'Notice bar',
		kind: 'pack',
		version: '0.1.0',
		category: 'storefront',
		description: 'A bar on top.',
	},
	elements: [
		{
			key: 'bar',
			name: 'Notice bar',
			modes: ['A', 'B'],
			price: { hourly: 1250 },
			placement: true,
			headless: 'headless/bar.js#createBar',
			renderer: 'ui/bar.js#render',
			features: {
				type: 'object',
				additionalProperties: false,
				properties: {
					message: {
						type: 'string',
						title: 'Message',
						default: 'Hello',
						maxLength: 140,
						'x-kind': 'config',
						'x-ui': { widget: 'textarea', group: 'Content', order: 1 },
					},
					maxPerDay: {
						type: 'integer',
						title: 'Max per day',
						default: 3,
						minimum: 1,
						maximum: 100,
						'x-kind': 'limit',
						'x-plan': { basic: { default: 2, max: 5 } },
						'x-lock': true,
					},
					tone: { type: 'string', title: 'Tone', default: 'info', enum: ['info', 'warning'], 'x-lock': false },
				},
			},
		},
		{
			key: 'badge',
			name: 'Trust badge',
			modes: ['A', 'B'],
			price: { hourly: 500 },
			placement: true,
			headless: 'headless/badge.js#createBadge',
			renderer: 'ui/badge.js#render',
		},
	],
	plans: [{ code: 'basic', name: 'Basic', elements: ['bar'], addons: ['badge'] }],
	priceBook: { version: '1', effectiveFrom: '2026-01-01T00:00:00.000Z' },
});

/** The pack's asset files (`ss pack build` output besides descriptor.json). */
const ASSETS = Object.freeze({
	'headless/bar.js': 'export const createBar = () => ({});',
	'ui/bar.js': 'export const render = () => null;',
	'headless/badge.js': 'export const createBadge = () => ({});',
	'ui/badge.js': 'export const render = () => null;',
});

const descriptorOf = () => ({
	format: 'ss-pack-bundle@1',
	manifest: packManifest(),
	assets: Object.entries(ASSETS).map(([path, body]) => ({
		path,
		sha256: createHash('sha256').update(body).digest('hex'),
		size: Buffer.byteLength(body),
		contentType: 'text/javascript',
	})),
});

/**
 * Upload the pack as the admin console does: the descriptor, then the raw bytes of every missing asset; activate it.
 * @param {import('../../src/portal.js').Portal} portal
 * @param {ReturnType<typeof client>} staff
 */
const uploadPack = async (portal, staff) => {
	const uploaded = await staff.api.post(adminApi.packs(), { descriptor: descriptorOf() });
	expect(uploaded).toMatchObject({ ok: true, data: { kind: 'pack', version: 1, status: 'uploading' } });
	const r = uploaded.ok ? uploaded.data : {};
	for (const path of r.missing) {
		const response = await portal.handle(
			new Request(new URL(`${r.uploadPath}${path}`, PORTAL_URL), {
				method: 'PUT',
				headers: {
					cookie: [...staff.jar].map(([k, v]) => `${k}=${v}`).join('; '),
					origin: PORTAL_URL,
					'sec-fetch-site': 'same-origin',
					'content-type': 'text/javascript',
				},
				body: /** @type {Record<string, string>} */ (ASSETS)[path],
			}),
		);
		expect(`${response.status} ${await response.clone().text()}`).toMatch(/^20/);
	}
	expect((await staff.api.post(adminApi.status(r.appId), { status: 'active' })).ok).toBe(true);
	return /** @type {string} */ (r.appId);
};

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
 * Boot a Portal with a capturing mailer, create the first admin (an Owner) on the sign-in page, turn two-step on and
 * sign in again with a code; create a merchant (setup link) with a website.
 * @param {string} name database name
 */
const setup = async (name) => {
	/** @type {Array<{ to: string, template: string, data: Record<string, any> }>} */
	const mail = [];
	const mailer = { available: true, send: async (/** @type {any} */ m) => void mail.push(m) };
	const modules = defaultModules.map((m) => (m.name === 'identity' ? createIdentityModule({ mailer }) : m));
	const { logger } = createTestLogger();
	const config = await testConfig({ STORAGE_DIR: ':memory:' });
	const db = mongo.db(name);
	// the Portal runs on an injected clock (starting at the wall time, so signed artefacts stay valid): time only moves
	// when a test advances it, and expiry assertions are exact
	const clock = createClock(Date.now());
	const portal = createPortal({
		config,
		db,
		modules,
		logger,
		now: clock.now,
		system: createSystemStore(db, { encryptionKey: ENCRYPTION_KEY, now: clock.now }),
		background: { mode: 'on', fallback: (task) => void task() },
	});
	await portal.ensureIndexes();
	/** @param {string} to @param {string} template */
	const tokenOf = (to, template) => {
		const message = [...mail].reverse().find((m) => m.to === to && m.template === template);
		return decodeURIComponent(String(message?.data.link).split('#token=')[1] ?? '');
	};

	// ------------------------------------------------------------------ the first admin, two-step, a second sign-in
	const staff = client(portal);
	const password = 'root password 123!';
	const first = { name: 'Rita Root', email: 'root@ss.test', password };
	const created = await staff.api.post('/v1/auth/first-admin', first);
	expect(created).toMatchObject({ ok: true, status: 201, data: { admin: { email: 'root@ss.test', role: 'owner' } } });
	expect((await staff.api.post('/v1/auth/first-admin', first)).status).toBe(409);
	const started = await staff.api.post('/v1/me/two-step/start');
	const secret = started.ok ? started.data.secret : '';
	const confirmed = await staff.api.post('/v1/me/two-step/confirm', { code: totpCode(secret, clock.now()) });
	expect(confirmed.ok && confirmed.data.recoveryCodes.length).toBe(10);
	expect((await staff.api.post(adminApi.signOut())).ok).toBe(true);
	const again = await staff.api.post('/v1/auth/sign-in', { email: 'root@ss.test', password });
	expect(again).toMatchObject({ ok: true, data: { status: 'two_step_required' } });
	const verified = await staff.api.post('/v1/auth/sign-in/two-step', {
		challenge: again.ok ? again.data.challenge : '',
		code: totpCode(secret, clock.now() + 30_000),
	});
	expect(verified.ok).toBe(true);
	const session = await admin.loadAdminSession(staff.api);
	if (!session.ok) throw new Error('no admin session');
	// the admin cookie is separate from merchant sessions
	expect([...staff.jar.keys()]).toEqual([sessionCookieName('admin', true)]);

	// ------------------------------------------------------------------ a merchant with a website
	const merchant = client(portal);
	expect(
		(await staff.api.post(adminApi.createMerchant(), { name: 'Shop & Co', ownerName: 'Sam Seller', email: 'owner@shop.test' }))
			.ok,
	).toBe(true);
	expect(
		(
			await merchant.api.post('/v1/auth/set-password', {
				token: tokenOf('owner@shop.test', 'merchant_setup'),
				password: 'correct horse battery',
			})
		).ok,
	).toBe(true);
	const me = await loaders.loadSession(merchant.api);
	if (!me.ok) throw new Error('no merchant session');
	const merchantId = /** @type {string} */ (me.merchantId);
	const added = await staff.api.post(`/v1/merchants/${merchantId}/websites`, { domain: 'shop.example.com' });
	const websiteId = added.ok ? added.data.website.websiteId : '';
	return { portal, clock, config, db, mail, tokenOf, staff, staffMember: session.admin, merchant, me, merchantId, websiteId };
};

describe('admin console smoke', () => {
	it('signs the Owner in with two-step and server-renders every admin page', async () => {
		const { portal, staff, staffMember, merchant, merchantId, websiteId } = await setup('admin_smoke');

		// ------------------------------------------------------------------ catalog: a pack, uploaded and activated
		const appId = await uploadPack(portal, staff);
		// the same build again changes nothing
		expect(await staff.api.post(adminApi.packs(), { descriptor: descriptorOf() })).toMatchObject({
			ok: true,
			data: { appId, changed: false, missing: [] },
		});

		// ------------------------------------------------------------------ money and a subscription with admin overrides
		expect(
			(
				await staff.api.post(adminApi.addReceipt(merchantId), {
					credits: 250,
					amountPaid: 'PKR 25,000',
					method: 'Bank transfer',
					reference: 'bank-1',
				})
			).ok,
		).toBe(true);
		const subscribed = await staff.api.post(`/v1/merchants/${merchantId}/websites/${websiteId}/subscriptions`, {
			appId,
			planCode: 'basic',
		});
		expect(subscribed.ok).toBe(true);
		const subscriptionId = subscribed.ok ? subscribed.data.subscription.subscriptionId : '';
		const override = await staff.api.request('PATCH', adminApi.adminConfig(subscriptionId), {
			features: { 'bar.maxPerDay': { value: 50, locked: true } },
			reason: 'enterprise deal',
		});
		expect(override.ok).toBe(true);
		const policy = await staff.api.request('PATCH', adminApi.platformPolicy(appId), {
			features: { 'bar.message': { value: 'Platform hello' } },
			reason: 'default copy',
		});
		expect(policy.ok).toBe(true);
		expect((await staff.api.post(adminApi.admins(), { email: 'help@ss.test', role: 'support' })).ok).toBe(true);

		// ------------------------------------------------------------------ frame
		const shell = text(
			ssr(
				<AdminShell admin={staffMember} branding={{ name: 'Single Solution', accent: '#4f46e5' }}>
					<p>child</p>
				</AdminShell>,
			),
		);
		expect(shell).toContain('Rita Root');
		expect(shell).toContain('Owner');
		for (const item of [
			'Overview',
			'Merchants',
			'Products',
			'Credits and billing',
			'Admins',
			'Settings',
			'Activity',
			'My account',
		])
			expect(shell).toContain(item);
		expect(shell).toContain('child');
		// Require two-step for admins: the frame shows only the setup
		const pending = text(
			ssr(
				<AdminShell admin={staffMember} twoStepRequired>
					<p>hidden</p>
				</AdminShell>,
			),
		);
		expect(pending).toContain('Set up two-step sign-in');
		expect(pending).not.toContain('hidden');

		const overview = await admin.loadOverview(staff.api);
		const overviewHtml = text(ssr(<OverviewView {...overview} admin={staffMember} />));
		expect(overviewHtml).toContain('E-mail sending is not set up');
		expect(overviewHtml).toContain('Recent activity');

		// ------------------------------------------------------------------ every page
		const merchants = await admin.loadMerchants(staff.api, {});
		expect(text(ssr(<MerchantsView {...merchants} admin={staffMember} />))).toContain('Shop & Co');
		for (const q of ['shop.example.com', 'shop', 'owner@shop', 'nobody.example.com'])
			ssr(<MerchantsView {...await admin.loadMerchants(staff.api, { q, status: 'active' })} admin={staffMember} />);
		const byDomain = await admin.loadMerchants(staff.api, { q: 'shop.example.com' });
		expect(byDomain.ok && byDomain.page.items.map((m) => m.merchantId)).toEqual([merchantId]);
		const byEmail = await admin.loadMerchants(staff.api, { q: 'owner@shop' });
		expect(byEmail.ok && byEmail.page.items.map((m) => m.merchantId)).toEqual([merchantId]);

		const detail = await admin.loadMerchant(staff.api, merchantId);
		const detailHtml = text(ssr(<MerchantView {...detail} admin={staffMember} />));
		expect(detailHtml).toContain('shop.example.com');
		expect(detailHtml).toContain('250 credits');
		expect(detailHtml).toContain('notice-bar');
		for (const tab of ['details', 'activity', 'credits'])
			expect(text(ssr(<MerchantView {...detail} admin={staffMember} tab={tab} />))).toMatch(
				/Owner name|Merchant created|250 credits/,
			);

		const activity = await admin.loadActivity(staff.api, { merchantId, adminId: '<bad>', from: 'x' });
		expect(activity.ok && activity.filter).toEqual({ merchantId, adminId: null, from: null, to: null });
		expect(text(ssr(<ActivityView {...activity} />))).toContain('Merchant created');

		const admins = await admin.loadAdmins(staff.api, staffMember);
		const adminsHtml = text(ssr(<AdminsView {...admins} />));
		expect(adminsHtml).toContain('help@ss.test');
		expect(adminsHtml).toContain('Invited');
		expect(adminsHtml).toContain('you');

		const settings = await admin.loadSettings(staff.api);
		const settingsHtml = text(ssr(<SettingsView {...settings} />));
		expect(settingsHtml).toContain('E-mail sending');
		expect(settingsHtml).toContain('SMTP host');

		const account = await admin.loadMyAccount(staff.api);
		const accountHtml = text(ssr(<MyAccountView {...account} />));
		expect(accountHtml).toContain('My account');
		expect(accountHtml).toContain('10 recovery codes left');

		ssr(<SubscriptionLookupView {...await admin.loadSubscriptionLookup(staff.api, {})} />);
		expect(
			text(ssr(<SubscriptionLookupView {...await admin.loadSubscriptionLookup(staff.api, { id: subscriptionId })} />)),
		).toContain(merchantId);
		expect(text(ssr(<SubscriptionLookupView {...await admin.loadSubscriptionLookup(staff.api, { id: 'nope' })} />))).toContain(
			'Enter a subscription id',
		);
		const sub = await admin.loadSubscription(staff.api, subscriptionId);
		expect(sub.ok).toBe(true);
		const subHtml = text(ssr(<SubscriptionAdminView {...sub} admin={staffMember} />));
		expect(subHtml).toContain('Admin overrides and locks');
		expect(subHtml).toContain('Lock Max per day');
		expect(subHtml).toContain('not lockable');
		expect(subHtml).toContain('bar.maxPerDay');
		expect(subHtml).toContain('Locked');
		expect(subHtml).toContain('enterprise deal');
		// admin values may exceed the plan maximum (5 on basic)
		expect(sub.ok && sub.effective.features['bar.maxPerDay']).toMatchObject({ value: 50, locked: true });

		const apps = await admin.loadApps(staff.api, { kind: 'pack', status: 'active' });
		expect(text(ssr(<AppsView {...apps} admin={staffMember} />))).toContain('notice-bar');
		const app = await admin.loadApp(staff.api, appId);
		expect(app.ok && app.manifest?.product.slug).toBe('notice-bar');
		const appHtml = text(ssr(<AppView {...app} admin={staffMember} />));
		expect(appHtml).toContain('Upload pack version');
		expect(appHtml).toContain('Active');
		expect(appHtml).toContain('v1 (0.1.0)');
		const policies = await admin.loadPolicies(staff.api, appId);
		const policiesHtml = text(ssr(<PoliciesView {...policies} admin={staffMember} />));
		expect(policiesHtml).toContain('Platform hello');
		expect(policiesHtml).toContain('default copy');

		const finance = await admin.loadBilling(staff.api, { merchantId, by: 'merchant', method: 'Bank transfer' });
		expect(finance).toMatchObject({ ok: true, filter: { merchantId, by: 'merchant' } });
		expect(text(ssr(<FinanceView {...finance} admin={staffMember} />))).toContain('Credits and billing');
		const page = await admin.loadMerchant(staff.api, merchantId);
		const creditsHtml = text(
			ssr(<MerchantCredits billing={page.ok ? page.billing : null} receipts={page.ok ? page.receipts : []} dayCharges={[]} />),
		);
		expect(creditsHtml).toContain('bank-1');
		expect(creditsHtml).toContain('PKR 25,000');

		expect(text(ssr(<ConnectorsAdminView {...await admin.loadConnectors(staff.api, { kind: 'database' })} />))).toContain(
			'No connectors match',
		);
		// ------------------------------------------------------------------ failures render friendly states
		const missing = await admin.loadMerchant(staff.api, 'mer_0000000000000000000000000z');
		expect(missing).toMatchObject({ ok: false, status: 404 });
		expect(text(ssr(<MerchantView {...missing} admin={staffMember} />))).toContain('Not found');
		const gone = await admin.loadSubscription(staff.api, 'sub_0000000000000000000000000z');
		expect(gone.ok).toBe(false);
		ssr(<SubscriptionAdminView {...gone} admin={staffMember} />);
		for (const [View, result] of /** @type {const} */ ([
			[MerchantsView, gone],
			[AppsView, gone],
			[AppView, gone],
			[PoliciesView, gone],
			[FinanceView, gone],
			[ConnectorsAdminView, gone],
			[ActivityView, gone],
			[AdminsView, gone],
			[SettingsView, gone],
			[MyAccountView, gone],
			[OverviewView, gone],
			[SubscriptionLookupView, gone],
		]))
			expect(text(ssr(<View {...result} admin={staffMember} />))).toMatch(/not|could not|found/i);
		// a merchant session is not an admin session
		expect(await admin.loadAdminSession(merchant.api)).toMatchObject({ ok: false, status: 403, merchant: true });
	});

	it('limits navigation and pages to the admin role', async () => {
		const { portal, staff, tokenOf } = await setup('admin_roles');
		await staff.api.post(adminApi.admins(), { email: 'help@ss.test', role: 'support' });
		const support = client(portal);
		expect(
			(
				await support.api.post('/v1/auth/set-password', {
					token: tokenOf('help@ss.test', 'admin_invite'),
					password: 'support password 123!',
					name: 'Help desk',
				})
			).ok,
		).toBe(true);
		const session = await admin.loadAdminSession(support.api);
		if (!session.ok) throw new Error('no support session');
		const labels = adminSections(session.admin, '/admin/merchants').flatMap((s) => s.items.map((i) => i.label));
		expect(labels).toEqual(['Overview', 'Merchants', 'Credits and billing', 'Activity']);
		expect(
			adminSections(session.admin, '/admin/merchants')
				.flatMap((s) => s.items)
				.find((i) => i.current)?.label,
		).toBe('Merchants');
		const forbidden = await admin.loadAdmins(support.api, session.admin);
		expect(forbidden).toMatchObject({ ok: false, status: 403 });
		expect(text(ssr(<AdminsView {...forbidden} />))).toContain('Not permitted');
		expect(adminCan(session.admin, 'dashboards.open')).toBe(true);
		expect(adminCan(session.admin, 'admins.manage')).toBe(false);
		expect(adminCan(null, 'merchants.read')).toBe(false);
	});

	it('pure helpers of the admin views', () => {
		expect(query({ a: 'x', b: null, c: '', d: 2 })).toBe('?a=x&d=2');
		expect(query({})).toBe('');
		expect(adminRoutes.activity({ merchantId: 'mer_1' })).toBe('/admin/activity?merchantId=mer_1');
		expect(adminRoutes.login('/admin/x')).toBe('/login?next=%2Fadmin%2Fx');
		expect(adminRoutes.merchant('mer_1', 'details')).toBe('/admin/merchants/mer_1?tab=details');
		expect(adminApi.status('app_1')).toBe('/v1/admin/apps/app_1/status');
		expect(checkSummary(null)).toBeNull();
		expect(
			checkSummary({
				checks: [
					{ name: 'reachability', ok: true },
					{ name: 'auth', ok: false, code: 'auth_failed' },
				],
				warnings: ['x'],
			}),
		).toEqual({ passed: 1, total: 2, failing: ['auth (auth_failed)'], warnings: ['x'] });
		expect(effectiveRows({ features: { 'b.x': { value: 1 }, 'a.y': { value: 2 } } }).map((r) => r.key)).toEqual(['a.y', 'b.x']);
		expect(effectiveRows(null)).toEqual([]);

		const element = packManifest().elements[0];
		const layer = { elements: { bar: { enabled: true } }, features: { 'bar.maxPerDay': { value: 9, locked: true } } };
		const values = layerValues(element, layer, { features: { 'bar.message': { value: 'Hi' } } });
		expect(values).toEqual({ message: 'Hi', maxPerDay: 9, tone: 'info' });
		expect(
			layerChange({
				element,
				layer,
				values,
				baseline: values,
				locks: {},
				removed: [],
				elementMode: 'on',
				elementLocked: false,
			}),
		).toEqual({});
		expect(
			layerChange({
				element,
				layer,
				values: { ...values, message: 'New' },
				baseline: values,
				locks: { maxPerDay: false, tone: false },
				removed: [],
				elementMode: 'off',
				elementLocked: true,
			}),
		).toEqual({
			features: { 'bar.message': { value: 'New' }, 'bar.maxPerDay': { value: 9 } },
			elements: { bar: { enabled: false, locked: true } },
		});
		expect(
			layerChange({
				element,
				layer,
				values,
				baseline: values,
				locks: {},
				removed: ['maxPerDay'],
				elementMode: 'inherit',
				elementLocked: false,
			}),
		).toEqual({ features: { 'bar.maxPerDay': null }, elements: { bar: null } });
		expect(
			layerChange({
				element,
				layer: { elements: {}, features: {} },
				values,
				baseline: values,
				locks: { message: true },
				removed: [],
				elementMode: 'inherit',
				elementLocked: false,
			}),
		).toEqual({ features: { 'bar.message': { value: 'Hi', locked: true } } });
	});
});
