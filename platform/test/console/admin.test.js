/**
 * End-to-end smoke of the Admin Console: boots the Portal in-process (every module, MongoMemory), creates the first
 * admin and signs in through the staff flow (password → optional TOTP enrolment, codes computed here → MFA verify on
 * the next sign-in), seeds a merchant with a website, an active pack (descriptor + assets uploaded) and a
 * subscription with admin overrides, then server-renders every admin page (renderToString) and checks that each
 * renders without errors or React warnings.
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
import {
	StaffForgotPasswordView,
	StaffLoginView,
	StaffMfaEnrol,
	StaffMfaVerify,
	StaffResetPasswordView,
	safeAdminNext,
} from '../../src/console/admin/views/auth.js';
import { MerchantView, MerchantsView } from '../../src/console/admin/views/merchants.js';
import { WebsitesView } from '../../src/console/admin/views/websites.js';
import { AppView, AppsView } from '../../src/console/admin/views/apps.js';
import {
	PoliciesView,
	SubscriptionAdminView,
	SubscriptionLookupView,
	effectiveRows,
} from '../../src/console/admin/views/config.js';
import { FinanceView, LedgerView } from '../../src/console/admin/views/finance.js';
import { AuditView, ConnectorsAdminView, checkSummary } from '../../src/console/admin/views/operations.js';
import { StaffView } from '../../src/console/admin/views/staff.js';
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
 * Boot a Portal with a capturing mailer, create the first admin and sign in with TOTP (enrolment, then a second
 * sign-in with the MFA challenge); create a merchant with a website through the merchant API.
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
	const portal = createPortal({ config, db, modules, logger, now: clock.now });
	await portal.ensureIndexes();
	/** @param {string} to @param {string} template */
	const tokenOf = (to, template) => {
		const message = [...mail].reverse().find((m) => m.to === to && m.template === template);
		return decodeURIComponent(String(message?.data.link).split('#token=')[1] ?? '');
	};

	// ------------------------------------------------------------------ staff: first admin, e-mail, TOTP enrolment
	const staff = client(portal);
	const password = 'root password 123!';
	const created = await staff.api.post(adminApi.firstAdmin(), { password });
	expect(created).toMatchObject({ ok: true, status: 201, data: { staff: { login: 'admin', email: null } } });
	expect((await staff.api.post(adminApi.firstAdmin(), { password })).status).toBe(409);
	expect((await staff.api.request('PATCH', adminApi.me(), { email: 'root@ss.test' })).ok).toBe(true);
	const login = await staff.api.post(adminApi.login(), { email: 'admin', password });
	// no MFA until enrolled: the console works at once (and asks to turn two-factor sign-in on)
	expect(login).toMatchObject({ ok: true, data: { status: 'ok' } });
	expect(await admin.loadStaffSession(staff.api)).toMatchObject({ ok: true, staff: { mfa: { enabled: false } } });
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
		expect(text(ssr(<AppsView {...apps} staff={staffMember} />))).toContain('notice-bar');
		const app = await admin.loadApp(staff.api, appId);
		expect(app.ok && app.manifest?.product.slug).toBe('notice-bar');
		const appHtml = text(ssr(<AppView {...app} staff={staffMember} />));
		expect(appHtml).toContain('Upload pack version');
		expect(appHtml).toContain('Active');
		expect(appHtml).toContain('v1 (0.1.0)');
		const policies = await admin.loadPolicies(staff.api, appId);
		const policiesHtml = text(ssr(<PoliciesView {...policies} staff={staffMember} />));
		expect(policiesHtml).toContain('Platform hello');
		expect(policiesHtml).toContain('default copy');

		const finance = await admin.loadFinance(staff.api);
		expect(text(ssr(<FinanceView {...finance} staff={staffMember} />))).toContain('Finance alerts');
		const ledger = await admin.loadLedger(staff.api, merchantId);
		const ledgerHtml = text(ssr(<LedgerView {...ledger} staff={staffMember} />));
		expect(ledgerHtml).toContain('bank-1');
		expect(ledgerHtml).toContain('Credit operation');
		const chain = await staff.api.get(adminApi.ledgerVerification(merchantId));
		expect(chain).toMatchObject({ ok: true, data: { ok: true } });

		expect(text(ssr(<ConnectorsAdminView {...await admin.loadConnectors(staff.api, { kind: 'database' })} />))).toContain(
			'No connectors match',
		);
		const audit = await admin.loadAudit(staff.api, { action: 'credits.added', actorId: '<bad>' });
		expect(audit.ok && audit.filter).toEqual({ actorId: null, targetId: null, action: 'credits.added' });
		expect(audit.ok && audit.page.items.map((e) => e.action)).toEqual(['credits.added']);
		expect(text(ssr(<AuditView {...audit} />))).toContain('credits.added');

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
			[MerchantsView, gone],
			[AppsView, gone],
			[AppView, gone],
			[PoliciesView, gone],
			[FinanceView, gone],
			[LedgerView, gone],
			[ConnectorsAdminView, gone],
			[AuditView, gone],
			[StaffView, gone],
			[WebsitesView, gone],
			[SubscriptionLookupView, gone],
		]))
			expect(text(ssr(<View {...result} staff={staffMember} />))).toMatch(/not|could not|found/i);
		// a merchant session is not a staff session
		expect(await admin.loadStaffSession(merchant.api)).toMatchObject({ ok: false, status: 401 });
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
		expect(staffCan(null, 'platform.merchants.read')).toBe(false);
	});

	it('pure helpers of the admin views', () => {
		expect(safeAdminNext('/admin/finance')).toBe('/admin/finance');
		expect(safeAdminNext('/admin')).toBe('/admin');
		expect(safeAdminNext('/websites')).toBe('/admin/merchants');
		expect(safeAdminNext('//evil.example/admin')).toBe('/admin/merchants');
		expect(safeAdminNext('/administrator')).toBe('/admin/merchants');
		expect(safeAdminNext(null)).toBe('/admin/merchants');
		expect(parseSignedCredits('12.5')).toEqual({ ok: true, value: 12_500 });
		expect(parseSignedCredits('-1', { allowNegative: true })).toEqual({ ok: true, value: -1000 });
		expect(parseSignedCredits('-1').ok).toBe(false);
		expect(parseSignedCredits('0').ok).toBe(false);
		expect(parseSignedCredits('abc').ok).toBe(false);
		expect(query({ a: 'x', b: null, c: '', d: 2 })).toBe('?a=x&d=2');
		expect(query({})).toBe('');
		expect(adminRoutes.audit({ action: 'credits.*' })).toBe('/admin/audit?action=credits.*');
		expect(adminRoutes.login('/admin/x')).toBe('/admin/login?next=%2Fadmin%2Fx');
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
