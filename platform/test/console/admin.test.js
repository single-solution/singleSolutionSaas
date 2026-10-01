/**
 * End-to-end smoke of the Admin Console: boots the Portal in-process (every module, MongoMemory), bootstraps a
 * superadmin and signs in through the staff flow (password → TOTP enrolment, codes computed here → MFA verify on
 * the next sign-in), seeds a merchant with a website, a listed pack (and a breaking second version) and a
 * subscription with admin overrides, then server-renders every admin page (renderToString) and checks that each
 * renders without errors or React warnings. A second test covers impersonation: the merchant session carrying
 * `via`, the banner in the Merchant Console and the audit trail.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createSigner, generateSigningKey, signBundle } from '@ss/protocol';
import { sessionCookieName, totpCode } from '../../src/infra/auth.js';
import { closeMongoClients } from '../../src/infra/db.js';
import { COLLECTIONS } from '../../src/infra/schema.js';
import { createPortal } from '../../src/portal.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { createIdentityModule } from '../../src/modules/identity/index.js';
import { BUNDLE_FORMAT } from '../../src/modules/catalog/core/bundle.js';
import { createConsoleApi } from '../../src/console/api.js';
import * as loaders from '../../src/console/loaders.js';
import * as admin from '../../src/console/admin/loaders.js';
import { adminApi, adminRoutes, query } from '../../src/console/admin/paths.js';
import { ConsoleShell } from '../../src/console/views/shell.js';
import { AdminShell, adminSections } from '../../src/console/admin/views/shell.js';
import {
	StaffForgotPasswordView,
	StaffLoginView,
	StaffMfaEnrol,
	StaffMfaVerify,
	StaffResetPasswordView,
	safeAdminNext,
} from '../../src/console/admin/views/auth.js';
import { DashboardView, AuditChainLine } from '../../src/console/admin/views/dashboard.js';
import { MerchantView, MerchantsView } from '../../src/console/admin/views/merchants.js';
import { WebsitesView } from '../../src/console/admin/views/websites.js';
import {
	AppView,
	AppsView,
	ManifestDiffView,
	VersionView,
	healthLabel,
	parseJsonField,
} from '../../src/console/admin/views/apps.js';
import {
	PoliciesView,
	SubscriptionAdminView,
	SubscriptionLookupView,
	effectiveRows,
} from '../../src/console/admin/views/config.js';
import { FinanceView, LedgerView } from '../../src/console/admin/views/finance.js';
import { IntegrationView } from '../../src/console/admin/views/integration.js';
import { AuditView, ConnectorsAdminView, checkSummary } from '../../src/console/admin/views/operations.js';
import { StaffView } from '../../src/console/admin/views/staff.js';
import { ImpersonationBanner } from '../../src/console/admin/views/impersonation.js';
import { layerChange, layerValues } from '../../src/console/admin/views/layer.js';
import { parseSignedCredits, staffCan } from '../../src/console/admin/views/common.js';
import { PORTAL_URL, createClock, createTestLogger, startMongo, testConfig } from '../helpers.js';

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

/** @param {{ breaking?: boolean }} [options] */
const packManifest = ({ breaking = false } = {}) => ({
	ssps: '1',
	product: {
		slug: 'notice-bar',
		name: 'Notice bar',
		kind: 'pack',
		version: breaking ? '0.2.0' : '0.1.0',
		category: 'storefront',
		description: 'A bar on top.',
	},
	elements: [
		{
			key: 'bar',
			name: 'Notice bar',
			modes: ['A', 'B'],
			price: { hourly: breaking ? 2000 : 1250 },
			budget: { js: 3 },
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
		...(breaking
			? []
			: [
					{
						key: 'badge',
						name: 'Trust badge',
						modes: ['A', 'B'],
						price: { hourly: 500 },
						budget: { js: 2 },
						placement: true,
						headless: 'headless/badge.js#createBadge',
						renderer: 'ui/badge.js#render',
					},
				]),
	],
	plans: [{ code: 'basic', name: 'Basic', elements: ['bar'], ...(breaking ? {} : { addons: ['badge'] }) }],
	priceBook: { version: breaking ? '2' : '1', effectiveFrom: '2026-01-01T00:00:00.000Z' },
});

/** @param {boolean} [breaking] */
const descriptorOf = (breaking = false) =>
	/** @type {any} */ ({
		format: BUNDLE_FORMAT,
		manifest: packManifest({ breaking }),
		assets: [
			{ path: 'headless/bar.js', sha256: 'a'.repeat(64), size: 1200, contentType: 'text/javascript' },
			{ path: 'ui/bar.js', sha256: 'b'.repeat(64), size: 2400, contentType: 'text/javascript' },
			...(breaking
				? []
				: [
						{ path: 'headless/badge.js', sha256: 'c'.repeat(64), size: 900, contentType: 'text/javascript' },
						{ path: 'ui/badge.js', sha256: 'd'.repeat(64), size: 1000, contentType: 'text/javascript' },
					]),
		],
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
 * Boot a Portal with a capturing mailer, bootstrap a superadmin and sign in with TOTP (enrolment, then a second
 * sign-in with the MFA challenge); create a merchant with a website through the merchant API.
 * @param {string} name database name
 */
const setup = async (name) => {
	/** @type {Array<{ to: string, template: string, data: Record<string, any> }>} */
	const mail = [];
	const mailer = { available: true, send: async (/** @type {any} */ m) => void mail.push(m) };
	const modules = defaultModules.map((m) => (m.name === 'identity' ? createIdentityModule({ mailer }) : m));
	const { logger } = createTestLogger();
	const config = await testConfig();
	const db = mongo.db(name);
	// the Portal runs on an injected clock (starting at the wall time, so signed artefacts stay valid): time only moves
	// when a test advances it, and expiry assertions are exact
	const clock = createClock(Date.now());
	const portal = createPortal({ config, db, modules, logger, now: clock.now });
	await portal.ensureIndexes();
	/** @param {string} to @param {string} template */
	const tokenOf = (to, template) => {
		const message = [...mail].reverse().find((m) => m.to === to && m.template === template);
		return decodeURIComponent(String(message?.data.link).split('#token=')[1] ?? '');
	};

	// ------------------------------------------------------------------ staff: bootstrap, password, TOTP enrolment
	const staff = client(portal);
	const { link } = await /** @type {any} */ (portal.modules.service('identity')).bootstrapSuperadmin({
		email: 'root@ss.test',
	});
	expect(String(link)).toContain('/staff/reset-password#token=');
	const password = 'root password 123!';
	expect(
		(
			await staff.api.post(adminApi.passwordResetConfirm(), {
				token: decodeURIComponent(String(link).split('#token=')[1] ?? ''),
				password,
			})
		).ok,
	).toBe(true);
	const login = await staff.api.post(adminApi.login(), { email: 'root@ss.test', password });
	expect(login).toMatchObject({ ok: true, data: { status: 'mfa_enrolment_required' } });
	// a half-signed session (password only) is not a console session yet
	expect(await admin.loadStaffSession(staff.api)).toMatchObject({ ok: false, status: 401, problem: { code: 'mfa_pending' } });
	const enrol = await staff.api.post(adminApi.mfaEnrol());
	const secret = enrol.ok ? enrol.data.secret : '';
	const confirmed = await staff.api.post(adminApi.mfaConfirm(), { code: totpCode(secret, clock.now()) });
	expect(confirmed.ok && confirmed.data.recoveryCodes.length).toBe(10);
	expect((await admin.loadStaffSession(staff.api)).ok).toBe(true);
	// a second sign-in asks for the TOTP code (next 30 s step: codes are single use)
	expect((await staff.api.post(adminApi.logout())).ok).toBe(true);
	const again = await staff.api.post(adminApi.login(), { email: 'root@ss.test', password });
	expect(again).toMatchObject({ ok: true, data: { status: 'mfa_required' } });
	const verified = await staff.api.post(adminApi.mfaVerify(), { code: totpCode(secret, clock.now() + 30_000) });
	expect(verified.ok).toBe(true);
	const session = await admin.loadStaffSession(staff.api);
	if (!session.ok) throw new Error('no staff session');
	// the staff cookie is separate from merchant sessions
	expect([...staff.jar.keys()]).toEqual([sessionCookieName('staff', true)]);

	// ------------------------------------------------------------------ merchant with a website
	const merchant = client(portal);
	expect(
		(
			await merchant.api.post('/v1/auth/merchant/signup', {
				email: 'owner@shop.test',
				password: 'correct horse battery',
				merchantName: 'Shop & Co',
			})
		).ok,
	).toBe(true);
	expect(
		(await merchant.api.post('/v1/auth/merchant/verify-email', { token: tokenOf('owner@shop.test', 'verify_email') })).ok,
	).toBe(true);
	const me = await loaders.loadSession(merchant.api);
	if (!me.ok) throw new Error('no merchant session');
	const merchantId = /** @type {string} */ (me.merchantId);
	const added = await merchant.api.post(`/v1/merchants/${merchantId}/websites`, { domain: 'shop.example.com' });
	const websiteId = added.ok ? added.data.website.websiteId : '';
	return { portal, clock, config, db, mail, tokenOf, staff, staffMember: session.staff, merchant, me, merchantId, websiteId };
};

describe('admin console smoke', () => {
	it('signs staff in with TOTP and server-renders every admin page', async () => {
		const { portal, staff, staffMember, merchant, merchantId, websiteId } = await setup('admin_smoke');

		// ------------------------------------------------------------------ catalog: a pack, activated, then a breaking v2
		const key = await generateSigningKey({ kid: 'pack-1' });
		const descriptor = descriptorOf();
		const uploaded = await staff.api.post(adminApi.packs(), {
			descriptor,
			signature: await signBundle({ signer: createSigner(key.privateJwk), descriptor }),
			publicJwk: key.publicJwk,
		});
		expect(uploaded.ok).toBe(true);
		const appId = uploaded.ok ? uploaded.data.app.appId : '';
		expect((await staff.api.post(adminApi.lifecycle(appId), { action: 'activate' })).ok).toBe(true);
		const v2 = descriptorOf(true);
		const second = await staff.api.post(adminApi.packs(), {
			descriptor: v2,
			signature: await signBundle({ signer: createSigner(key.privateJwk), descriptor: v2 }),
		});
		expect(second).toMatchObject({ ok: true, data: { version: { version: 2, status: 'pending', breaking: true } } });

		// ------------------------------------------------------------------ money and a subscription with admin overrides
		expect(
			(
				await staff.api.post(adminApi.credit(merchantId, 'credits'), {
					amountMillicredits: 250_000,
					reference: 'bank-1',
					note: 'wire',
				})
			).ok,
		).toBe(true);
		const subscribed = await merchant.api.post(`/v1/merchants/${merchantId}/websites/${websiteId}/subscriptions`, {
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
		expect(
			(await staff.api.post(adminApi.staffList(), { email: 'help@ss.test', roles: ['support'], name: 'Help desk' })).ok,
		).toBe(true);

		// ------------------------------------------------------------------ frame
		const shell = text(
			ssr(
				<AdminShell staff={staffMember}>
					<p>child</p>
				</AdminShell>,
			),
		);
		expect(shell).toContain('Admin console');
		expect(shell).toContain('root@ss.test');
		expect(shell).toContain('Staff');
		expect(shell).toContain('child');

		// ------------------------------------------------------------------ every page
		const dashboard = await admin.loadDashboard(staff.api);
		const dashboardHtml = text(ssr(<DashboardView {...dashboard} />));
		expect(dashboardHtml).toContain('Platform health');
		expect(dashboardHtml).toContain('audit_verify');
		expect(dashboardHtml).toContain('not been verified yet');
		expect(dashboard.ok && dashboard.health.problem).toBeNull();

		const merchants = await admin.loadMerchants(staff.api, {});
		expect(text(ssr(<MerchantsView {...merchants} />))).toContain('Shop & Co');
		for (const q of [merchantId, 'shop.example.com', 'shop', 'nobody.example.com'])
			ssr(<MerchantsView {...await admin.loadMerchants(staff.api, { q, status: 'active' })} />);
		expect(await admin.loadMerchants(staff.api, { q: 'shop.example.com' })).toMatchObject({
			mode: 'domain',
			matches: [{ merchantId }],
		});
		const byName = await admin.loadMerchants(staff.api, { q: 'Shop' });
		expect(byName).toMatchObject({ mode: 'search' });
		expect(byName.ok && byName.page.items).toHaveLength(1);
		const byEmail = await admin.loadMerchants(staff.api, { q: 'owner@shop' });
		expect(byEmail.ok && byEmail.page.items.map((m) => m.merchantId)).toEqual([merchantId]);
		expect((await staff.api.post(adminApi.notes(merchantId), { body: 'VIP customer, call before suspending.' })).ok).toBe(true);

		const detail = await admin.loadMerchant(staff.api, merchantId);
		const detailHtml = text(ssr(<MerchantView {...detail} staff={staffMember} />));
		expect(detailHtml).toContain('shop.example.com');
		expect(detailHtml).toContain('owner@shop.test');
		expect(detailHtml).toContain('Impersonate');
		expect(detailHtml).toContain('250 credits');
		expect(detailHtml).toContain('notice-bar');
		expect(detailHtml).toContain('VIP customer, call before suspending.');
		expect(detailHtml).toContain('root@ss.test');

		expect(text(ssr(<WebsitesView {...await admin.loadWebsites(staff.api, {})} staff={staffMember} />))).toContain(
			'Enter a domain',
		);
		const sites = await admin.loadWebsites(staff.api, { domain: 'SHOP.example.com' });
		expect(text(ssr(<WebsitesView {...sites} staff={staffMember} />))).toContain('Shop & Co');
		ssr(
			<WebsitesView
				{...await admin.loadWebsites(staff.api, { domain: 'other.example.com', env: 'test' })}
				staff={staffMember}
			/>,
		);

		ssr(<SubscriptionLookupView {...await admin.loadSubscriptionLookup(staff.api, {})} />);
		expect(
			text(ssr(<SubscriptionLookupView {...await admin.loadSubscriptionLookup(staff.api, { id: subscriptionId })} />)),
		).toContain(merchantId);
		expect(text(ssr(<SubscriptionLookupView {...await admin.loadSubscriptionLookup(staff.api, { id: 'nope' })} />))).toContain(
			'Enter a subscription id',
		);
		const sub = await admin.loadSubscription(staff.api, subscriptionId);
		expect(sub.ok).toBe(true);
		const subHtml = text(ssr(<SubscriptionAdminView {...sub} staff={staffMember} />));
		expect(subHtml).toContain('Admin overrides and locks');
		expect(subHtml).toContain('Lock Max per day');
		expect(subHtml).toContain('not lockable');
		expect(subHtml).toContain('bar.maxPerDay');
		expect(subHtml).toContain('Locked');
		expect(subHtml).toContain('enterprise deal');
		// admin values may exceed the plan maximum (5 on basic)
		expect(sub.ok && sub.effective.features['bar.maxPerDay']).toMatchObject({ value: 50, locked: true });

		const apps = await admin.loadApps(staff.api, { kind: 'pack', status: 'active' });
		expect(text(ssr(<AppsView {...apps} staff={staffMember} />))).toContain('2 to review');
		const app = await admin.loadApp(staff.api, appId);
		const appHtml = text(ssr(<AppView {...app} staff={staffMember} />));
		expect(appHtml).toContain('Manifest versions');
		expect(appHtml).toContain('pack-1');
		expect(appHtml).toContain('Deprecate');
		const version = await admin.loadVersion(staff.api, appId, '2');
		const versionHtml = text(ssr(<VersionView {...version} staff={staffMember} />));
		expect(versionHtml).toContain('breaking change');
		expect(versionHtml).toContain('Element removed');
		expect(versionHtml).toContain('Approve');
		expect(text(ssr(<VersionView {...await admin.loadVersion(staff.api, appId, 'x')} staff={staffMember} />))).toContain(
			'Not found',
		);
		const policies = await admin.loadPolicies(staff.api, appId);
		const policiesHtml = text(ssr(<PoliciesView {...policies} staff={staffMember} />));
		expect(policiesHtml).toContain('Platform hello');
		expect(policiesHtml).toContain('default copy');

		const finance = await admin.loadFinance(staff.api);
		expect(text(ssr(<FinanceView {...finance} staff={staffMember} />))).toContain('Force settlement');
		const ledger = await admin.loadLedger(staff.api, merchantId);
		const ledgerHtml = text(ssr(<LedgerView {...ledger} staff={staffMember} />));
		expect(ledgerHtml).toContain('bank-1');
		expect(ledgerHtml).toContain('Credit operation');
		const chain = await staff.api.get(adminApi.ledgerVerification(merchantId));
		expect(chain).toMatchObject({ ok: true, data: { ok: true } });

		expect(text(ssr(<IntegrationView {...await admin.loadIntegration(staff.api, {})} staff={staffMember} />))).toContain(
			'Filter by website or app',
		);
		const scoped = await admin.loadIntegration(staff.api, { websiteId, status: 'dead', appId: 'bad' });
		expect(scoped.ok && scoped.filter).toEqual({ websiteId, appId: null, status: 'dead' });
		ssr(<IntegrationView {...scoped} staff={staffMember} />);

		expect(text(ssr(<ConnectorsAdminView {...await admin.loadConnectors(staff.api, { kind: 'database' })} />))).toContain(
			'No connectors match',
		);
		const audit = await admin.loadAudit(staff.api, { scope: `merchant:${merchantId}`, action: 'credits.added' });
		expect(audit.ok && audit.page.items.map((e) => e.action)).toEqual(['credits.added']);
		const auditHtml = text(ssr(<AuditView {...audit} />));
		expect(auditHtml).toContain('credits.added');
		expect(auditHtml).toContain('Verify a chain');

		const staffPage = await admin.loadStaff(staff.api, staffMember);
		const staffHtml = text(ssr(<StaffView {...staffPage} />));
		expect(staffHtml).toContain('help@ss.test');
		expect(staffHtml).toContain('Invite pending');
		expect(staffHtml).toContain('You');

		// public staff pages
		for (const view of [
			<StaffLoginView key="l" next="/admin/finance" expired reset />,
			<StaffForgotPasswordView key="f" />,
			<StaffResetPasswordView key="r" />,
			<StaffMfaVerify key="v" onDone={() => undefined} onRestart={() => undefined} />,
			<StaffMfaEnrol key="e" onDone={() => undefined} onRestart={() => undefined} />,
		])
			ssr(view);

		// ------------------------------------------------------------------ failures render friendly states
		const missing = await admin.loadMerchant(staff.api, 'mer_0000000000000000000000000z');
		expect(missing).toMatchObject({ ok: false, status: 404 });
		expect(text(ssr(<MerchantView {...missing} staff={staffMember} />))).toContain('Not found');
		const gone = await admin.loadSubscription(staff.api, 'sub_0000000000000000000000000z');
		expect(gone.ok).toBe(false);
		ssr(<SubscriptionAdminView {...gone} staff={staffMember} />);
		for (const [View, result] of /** @type {const} */ ([
			[DashboardView, gone],
			[MerchantsView, gone],
			[AppsView, gone],
			[AppView, gone],
			[PoliciesView, gone],
			[FinanceView, gone],
			[LedgerView, gone],
			[IntegrationView, gone],
			[ConnectorsAdminView, gone],
			[AuditView, gone],
			[StaffView, gone],
			[WebsitesView, gone],
			[SubscriptionLookupView, gone],
		]))
			expect(text(ssr(<View {...result} staff={staffMember} />))).toMatch(/not|could not|found/i);
		// a merchant session is not a staff session
		expect(await admin.loadStaffSession(merchant.api)).toMatchObject({ ok: false, status: 401 });
		// the dashboard degrades section by section when a read is refused (roles without platform.jobs.read, or here
		// an anonymous caller — the console layout redirects those before any page loads)
		const anonymous = await admin.loadDashboard(client(portal).api);
		expect(anonymous).toMatchObject({ ok: true, metrics: null, apps: [], alerts: [] });
		expect(anonymous.ok && anonymous.metricsProblem?.status).toBe(401);
		ssr(<DashboardView {...anonymous} />);
	});

	it('limits navigation and pages to the staff role', async () => {
		const { portal, clock, staff, tokenOf } = await setup('admin_roles');
		await staff.api.post(adminApi.staffList(), { email: 'help@ss.test', roles: ['support'] });
		const support = client(portal);
		const password = 'support password 123!';
		expect(
			(await support.api.post(adminApi.passwordResetConfirm(), { token: tokenOf('help@ss.test', 'staff_welcome'), password }))
				.ok,
		).toBe(true);
		await support.api.post(adminApi.login(), { email: 'help@ss.test', password });
		const enrol = await support.api.post(adminApi.mfaEnrol());
		await support.api.post(adminApi.mfaConfirm(), { code: totpCode(enrol.ok ? enrol.data.secret : '', clock.now()) });
		const session = await admin.loadStaffSession(support.api);
		if (!session.ok) throw new Error('no support session');
		const labels = adminSections(session.staff, '/admin/merchants').flatMap((s) => s.items.map((i) => i.label));
		expect(labels).toContain('Merchants');
		expect(labels).not.toContain('Staff');
		expect(labels).not.toContain('Finance');
		expect(
			adminSections(session.staff, '/admin/merchants')
				.flatMap((s) => s.items)
				.find((i) => i.current)?.label,
		).toBe('Merchants');
		const forbidden = await admin.loadStaff(support.api, session.staff);
		expect(forbidden).toMatchObject({ ok: false, status: 403 });
		expect(text(ssr(<StaffView {...forbidden} />))).toContain('Not permitted');
		expect(staffCan(session.staff, 'platform.launch.admin')).toBe(true);
		expect(staffCan(session.staff, 'platform.impersonate')).toBe(false);
		expect(staffCan(null, 'platform.merchants.read')).toBe(false);
	});

	it('impersonation: a time-boxed merchant session with via shows the banner and is audited as the staff member', async () => {
		const { portal, clock, db, staff, staffMember, me, merchantId, merchant, websiteId } = await setup('admin_impersonation');
		// an ordinary merchant session: no banner
		expect(await admin.loadImpersonation(merchant.api)).toBeNull();
		const plain = text(
			ssr(
				<ConsoleShell me={me.me} merchantId={merchantId} websites={[]} meter={null} impersonation={null}>
					<p>child</p>
				</ConsoleShell>,
			),
		);
		expect(plain).not.toContain('Staff impersonation');
		// staff side: the merchant's team lists the member to impersonate (superadmins may impersonate)
		const detail = await admin.loadMerchant(staff.api, merchantId);
		if (!detail.ok) throw new Error('merchant');
		const member = detail.members.find((m) => m.email === 'owner@shop.test');
		expect(staffCan(staffMember, 'platform.impersonate')).toBe(true);
		expect(text(ssr(<MerchantView {...detail} staff={staffMember} />))).toContain('Impersonate');

		// POST /v1/admin/merchants/:merchantId/impersonate mints a one-time token; the same staff browser exchanges it
		// for a merchant session carrying `via`, time-boxed to the minutes asked for
		const startedAt = clock.now();
		const started = await staff.api.post(adminApi.impersonate(merchantId), {
			userId: member.userId,
			minutes: 15,
			reason: 'ticket 42',
		});
		expect(started.ok).toBe(true);
		const exchanged = await staff.api.post(adminApi.impersonationExchange(), {
			token: started.ok ? started.data.exchangeToken : '',
		});
		expect(exchanged.ok).toBe(true);
		const merchantCookie = staff.jar.get(sessionCookieName('merchant', true));
		expect(merchantCookie).toBeTruthy();
		staff.jar.delete(sessionCookieName('merchant', true));
		const impersonated = createConsoleApi({
			handle: portal.handle,
			baseUrl: PORTAL_URL,
			cookie: `${sessionCookieName('merchant', true)}=${merchantCookie}`,
		});
		const state = await admin.loadImpersonation(impersonated);
		expect(state).toMatchObject({ staffId: staffMember.staffId, staffName: 'root@ss.test' });
		const ends = Date.parse(String(state?.expiresAt));
		expect(ends).toBeGreaterThan(startedAt);
		// time-boxed to exactly the 15 minutes asked for, from the moment of the exchange (injected clock)
		expect(ends).toBe(startedAt + 15 * 60_000);

		// the Merchant Console frame shows the banner on every page
		const session = await loaders.loadSession(impersonated);
		if (!session.ok) throw new Error('impersonated session');
		const frame = await loaders.loadFrame(impersonated, merchantId);
		const banner = text(
			ssr(
				<ConsoleShell
					me={session.me}
					merchantId={merchantId}
					websites={frame.websites}
					meter={frame.meter}
					impersonation={state}>
					<p>child</p>
				</ConsoleShell>,
			),
		);
		expect(banner).toContain('Staff impersonation of owner@shop.test');
		expect(banner).toContain(staffMember.staffId);
		expect(banner).toContain('End impersonation');
		expect(text(ssr(<ImpersonationBanner impersonation={{ staffId: 'stf_x', expiresAt: null }} />))).toContain('stf_x');
		expect(renderToString(<ImpersonationBanner impersonation={null} />)).toBe('');

		// actions taken while impersonating are recorded as the user, via the staff member
		const policy = await impersonated.post(`/v1/merchants/${merchantId}/spend-policies`, {
			scope: 'merchant',
			window: 'day',
			limit: 10_000,
		});
		expect(policy.ok).toBe(true);
		const renamed = await impersonated.request('PATCH', `/v1/merchants/${merchantId}`, { name: 'Shop & Co (fixed)' });
		expect(renamed.ok).toBe(true);
		const entries = await db.collection(COLLECTIONS.audit).find({ merchantId, 'actor.via.id': staffMember.staffId }).toArray();
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((e) => e.actor.id === member.userId)).toBe(true);
		void websiteId;

		// ending the impersonation signs the merchant session out; the staff session is untouched
		expect((await impersonated.post('/v1/auth/merchant/logout')).ok).toBe(true);
		expect(await admin.loadImpersonation(impersonated)).toBeNull();
		expect((await admin.loadStaffSession(staff.api)).ok).toBe(true);
		// the start and the end are on the staff (global) chain and on the merchant's chain, readable in the audit log
		const global = await admin.loadAudit(staff.api, { scope: 'global', action: 'staff.*' });
		expect(global.ok && global.page.items.map((e) => e.action)).toEqual(
			expect.arrayContaining(['staff.impersonation_started', 'staff.impersonation_ended']),
		);
		const local = await admin.loadAudit(staff.api, { scope: `merchant:${merchantId}`, action: 'merchant.*' });
		expect(local.ok && local.page.items.map((e) => e.action)).toEqual(
			expect.arrayContaining(['merchant.impersonation_started', 'merchant.impersonation_ended']),
		);
		expect(text(ssr(<AuditView {...local} />))).toContain(`via ${staffMember.staffId}`);
	});

	it('pure helpers of the admin views', () => {
		expect(safeAdminNext('/admin/finance')).toBe('/admin/finance');
		expect(safeAdminNext('/admin')).toBe('/admin');
		expect(safeAdminNext('/websites')).toBe('/admin');
		expect(safeAdminNext('//evil.example/admin')).toBe('/admin');
		expect(safeAdminNext('/administrator')).toBe('/admin');
		expect(safeAdminNext(null)).toBe('/admin');
		expect(parseSignedCredits('12.5')).toEqual({ ok: true, value: 12_500 });
		expect(parseSignedCredits('-1', { allowNegative: true })).toEqual({ ok: true, value: -1000 });
		expect(parseSignedCredits('-1').ok).toBe(false);
		expect(parseSignedCredits('0').ok).toBe(false);
		expect(parseSignedCredits('abc').ok).toBe(false);
		expect(query({ a: 'x', b: null, c: '', d: 2 })).toBe('?a=x&d=2');
		expect(query({})).toBe('');
		expect(adminRoutes.audit({ scope: 'merchant:mer_1' })).toBe('/admin/audit?scope=merchant%3Amer_1');
		expect(adminRoutes.login('/admin/x')).toBe('/admin/login?next=%2Fadmin%2Fx');
		expect(adminApi.auditVerification('global')).toBe('/v1/admin/audit/verification?scope=global');
		const service = { kind: 'service', status: 'active' };
		expect(
			admin
				.unhealthyApps([
					{ ...service, appId: 'a', health: { stale: true, status: null } },
					{ ...service, appId: 'b', health: { stale: false, status: 'degraded' } },
					{ ...service, appId: 'c', health: { stale: false, status: 'ok' } },
					{ kind: 'pack', status: 'active', appId: 'd', health: null },
					{ ...service, status: 'retired', appId: 'e', health: { stale: true } },
				])
				.map((a) => a.appId),
		).toEqual(['a', 'b']);
		expect(healthLabel({ kind: 'pack' })).toBeNull();
		expect(healthLabel({ kind: 'service', health: { stale: true, lastHeartbeatAt: null } })).toEqual({
			status: 'failing',
			label: 'No heartbeat',
		});
		expect(healthLabel({ kind: 'service', health: { stale: false, status: 'degraded' } })).toEqual({
			status: 'failing',
			label: 'Degraded',
		});
		expect(healthLabel({ kind: 'service', health: { stale: false, status: 'ok' } })).toEqual({
			status: 'ok',
			label: 'Healthy',
		});
		expect(parseJsonField('')).toMatchObject({ ok: false });
		expect(parseJsonField('', { optional: true })).toEqual({ ok: true, value: undefined });
		expect(parseJsonField('[1]')).toMatchObject({ ok: false, message: 'Must be a JSON object.' });
		expect(parseJsonField('{bad')).toMatchObject({ ok: false });
		expect(parseJsonField('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
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

		// presentational pieces
		expect(text(ssr(<AuditChainLine verification={null} />))).toContain('not been verified');
		expect(
			text(
				ssr(
					<AuditChainLine verification={{ at: '2026-10-01T00:00:00Z', scopes: 3, broken: [{ scope: 'global', seq: 4 }] }} />,
				),
			),
		).toContain('global (seq 4');
		expect(text(ssr(<ManifestDiffView diff={null} />))).toContain('No diff recorded');
		expect(text(ssr(<ManifestDiffView diff={{ changed: false }} />))).toContain('No changes');
		expect(
			text(
				ssr(
					<ManifestDiffView
						diff={{
							changed: true,
							breaking: [],
							version: { from: '1', to: '2' },
							elements: { added: ['x'], removed: [], changed: [{ key: 'bar', fields: ['price'] }] },
							prices: [{ element: 'bar', field: 'hourly', from: 1, to: 2, direction: 'increase' }],
							plans: {
								added: [],
								removed: [],
								changed: [{ code: 'p', elementsAdded: ['x'], elementsRemoved: [], addonsAdded: [], addonsRemoved: [] }],
							},
							features: [{ element: 'bar', feature: 'm', change: 'changed', fields: ['maxLength'] }],
							other: { priceBook: true, scopesAdded: ['graph.read'], scopesRemoved: [] },
						}}
					/>,
				),
			),
		).toContain('No breaking changes');
	});
});
