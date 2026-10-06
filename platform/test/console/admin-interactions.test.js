// @vitest-environment jsdom
/**
 * Admin Console in the browser (jsdom): the views are rendered client-side against a live in-process Portal —
 * `fetch` is routed to `portal.handle` with a cookie jar, as a same-origin browser would — and driven through
 * their forms and dialogs: staff sign-in with TOTP enrolment and verification, suspend / resume, impersonation,
 * website transfer, app registration and pack upload, lifecycle, version review, key revocation, admin overrides
 * and locks, platform policies and rollback, credit operations and chain verification, settlement and
 * reconciliation, replay, audit verification and staff management.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSigner, generateSigningKey, signBundle } from '@ss/protocol';
import { totpCode } from '../../src/infra/auth.js';
import { closeMongoClients } from '../../src/infra/db.js';
import { createPortal } from '../../src/portal.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { createIdentityModule } from '../../src/modules/identity/index.js';
import { BUNDLE_FORMAT } from '../../src/modules/catalog/core/bundle.js';
import { createConsoleApi } from '../../src/console/api.js';
import * as admin from '../../src/console/admin/loaders.js';
import { adminApi, adminRoutes } from '../../src/console/admin/paths.js';
import { adminFetch, staffSignInAgain, useAdminResource } from '../../src/console/admin/client.js';
import { AdminShell } from '../../src/console/admin/views/shell.js';
import {
	StaffForgotPasswordView,
	StaffLoginView,
	StaffMfaEnrol,
	StaffResetPasswordView,
} from '../../src/console/admin/views/auth.js';
import { AccountView } from '../../src/console/admin/views/account.js';
import { DashboardView } from '../../src/console/admin/views/dashboard.js';
import { MerchantView, MerchantsView } from '../../src/console/admin/views/merchants.js';
import { WebsitesView } from '../../src/console/admin/views/websites.js';
import { AppView, AppsView, VersionView } from '../../src/console/admin/views/apps.js';
import { PoliciesView, SubscriptionAdminView } from '../../src/console/admin/views/config.js';
import { FinanceView, LedgerView } from '../../src/console/admin/views/finance.js';
import { IntegrationView } from '../../src/console/admin/views/integration.js';
import { AuditView, ConnectorsAdminView } from '../../src/console/admin/views/operations.js';
import { StaffView } from '../../src/console/admin/views/staff.js';
import { ImpersonationBanner } from '../../src/console/admin/views/impersonation.js';
import { IdChip } from '../../src/console/admin/views/common.js';
import { ToastProvider } from '@ss/ui';
import { act, byLabel, cleanup, render, type } from '@ss/ui/testing';
import { PORTAL_URL, createTestLogger, startMongo, testConfig } from '../helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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
});

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Let pending fetches and state updates settle (inside act). */
const settle = async (rounds = 3) => {
	for (let i = 0; i < rounds; i += 1)
		await act(async () => {
			await sleep(15);
		});
};

/**
 * Wait until `check` passes (state updates applied inside act).
 * @param {() => unknown} check
 * @param {number} [timeoutMs]
 */
const until = async (check, timeoutMs = 10_000) => {
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			const value = check();
			if (value !== false && value !== null && value !== undefined) return value;
		} catch (error) {
			if (Date.now() > end) throw error;
		}
		if (Date.now() > end) throw new Error('timed out waiting for the UI');
		await act(async () => {
			await sleep(20);
		});
	}
};

/** @param {string} label */
const button = (label) => {
	const found = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('button')]).filter(
		(b) => b.textContent?.trim() === label,
	);
	const last = found.at(-1);
	if (!last) throw new Error(`no button “${label}”`);
	return last;
};

/** @param {string} label */
const press = async (label) => {
	await act(async () => {
		button(label).click();
	});
	await settle(1);
};

/** @param {string} label @param {string} value */
const fill = (label, value) => type(byLabel(document, label), value);

/** @param {string} label @param {string} value */
const fillDialog = (label, value) =>
	type(byLabel(/** @type {HTMLElement} */ (document.querySelector('[role="dialog"]')), label), value);

/** @param {string} snippet */
const shows = (snippet) => document.body.textContent?.replace(/\s+/g, ' ').includes(snippet) ?? false;

/** Typed confirmation input of the open dialog. */
const confirmInput = () => {
	const label = [...document.querySelectorAll('label')].find((l) => /^Type .* to confirm/.test(l.textContent ?? ''));
	if (!label) throw new Error('no typed confirmation');
	return /** @type {HTMLInputElement} */ (document.getElementById(/** @type {HTMLLabelElement} */ (label).htmlFor));
};

/**
 * A browser for one Portal: `fetch` goes to `portal.handle` with this browser's cookies (same origin).
 * @param {import('../../src/portal.js').Portal} portal
 */
const browserOf = (portal) => {
	/** @type {Map<string, string>} */
	const jar = new Map();
	/** @type {Array<{ method: string, path: string, status: number, body: any }>} */
	const calls = [];
	const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
	/** @param {string[]} list */
	const store = (list) => {
		for (const set of list) {
			const [pair = ''] = set.split(';');
			const i = pair.indexOf('=');
			const value = pair.slice(i + 1);
			if (value) jar.set(pair.slice(0, i), value);
			else jar.delete(pair.slice(0, i));
		}
	};
	/** @type {typeof fetch} */
	const fetchImpl = async (input, init = {}) => {
		const url = new URL(String(input), PORTAL_URL);
		const method = init.method ?? 'GET';
		const headers = new Headers(/** @type {any} */ (init.headers));
		if (jar.size > 0) headers.set('cookie', cookie());
		if (method !== 'GET') {
			headers.set('origin', PORTAL_URL);
			headers.set('sec-fetch-site', 'same-origin');
		}
		const response = await portal.handle(
			new Request(url, { method, headers, ...(init.body === undefined ? {} : { body: /** @type {any} */ (init.body) }) }),
		);
		store(response.headers.getSetCookie());
		const text = await response.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		calls.push({ method, path: `${url.pathname}${url.search}`, status: response.status, body });
		return new Response(text, { status: response.status, headers: response.headers });
	};
	const api = createConsoleApi({
		handle: portal.handle,
		baseUrl: PORTAL_URL,
		cookie: () => cookie() || null,
		onSetCookie: store,
	});
	return { jar, calls, fetch: fetchImpl, api, use: () => vi.stubGlobal('fetch', fetchImpl) };
};

const manifest = (/** @type {{ version?: string, hourly?: number }} */ { version = '0.1.0', hourly = 1250 } = {}) => ({
	ssps: '1',
	product: { slug: 'notice-bar', name: 'Notice bar', kind: 'pack', version, category: 'storefront', description: 'Bar.' },
	elements: [
		{
			key: 'bar',
			name: 'Notice bar',
			modes: ['A', 'B'],
			price: { hourly },
			budget: { js: 3 },
			placement: true,
			headless: 'headless/bar.js#createBar',
			renderer: 'ui/bar.js#render',
			features: {
				type: 'object',
				additionalProperties: false,
				properties: {
					message: { type: 'string', title: 'Message', default: 'Hello', maxLength: 140, 'x-kind': 'config' },
					maxPerDay: {
						type: 'integer',
						title: 'Max per day',
						default: 3,
						minimum: 1,
						maximum: 100,
						'x-kind': 'limit',
						'x-lock': true,
					},
				},
			},
		},
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
	],
	plans: [{ code: 'basic', name: 'Basic', elements: ['bar'], addons: ['badge'] }],
	priceBook: { version: '1', effectiveFrom: '2026-01-01T00:00:00.000Z' },
});

/** @param {any} m */
const descriptorOf = (m) => ({
	format: BUNDLE_FORMAT,
	manifest: m,
	assets: [
		{ path: 'headless/bar.js', sha256: 'a'.repeat(64), size: 1200, contentType: 'text/javascript' },
		{ path: 'ui/bar.js', sha256: 'b'.repeat(64), size: 2400, contentType: 'text/javascript' },
		{ path: 'headless/badge.js', sha256: 'c'.repeat(64), size: 900, contentType: 'text/javascript' },
		{ path: 'ui/badge.js', sha256: 'd'.repeat(64), size: 1000, contentType: 'text/javascript' },
	],
});

describe('admin console interactions (jsdom)', () => {
	it('drives every admin page against a live Portal', async () => {
		/** @type {Array<{ to: string, template: string, data: Record<string, any> }>} */
		const mail = [];
		const mailer = { available: true, send: async (/** @type {any} */ m) => void mail.push(m) };
		const modules = defaultModules.map((m) => (m.name === 'identity' ? createIdentityModule({ mailer }) : m));
		const portal = createPortal({
			config: await testConfig(),
			db: mongo.db('admin_ui'),
			modules,
			logger: createTestLogger().logger,
		});
		await portal.ensureIndexes();
		/** @param {string} to @param {string} template */
		const tokenOf = (to, template) => {
			const message = [...mail].reverse().find((m) => m.to === to && m.template === template);
			return decodeURIComponent(String(message?.data.link).split('#token=')[1] ?? '');
		};
		const open = vi.fn();
		vi.stubGlobal('open', open);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		// ---------------------------------------------------------------- staff sign-in in the browser
		const staff = browserOf(portal);
		staff.use();
		// first run: the sign-in page offers "Create admin"
		render(<StaffLoginView firstRun />);
		fill('Choose a password', 'short');
		await press('Create admin');
		expect(shows('Use at least 12 characters.')).toBe(true);
		fill('Choose a password', 'first password 123!');
		await press('Create admin');
		await until(() => staff.calls.some((c) => c.path === adminApi.firstAdmin() && c.status === 201));
		cleanup();

		// Account settings: e-mail and name (optional), password, two-factor sign-in
		const firstMe = await admin.loadStaffSession(staff.api);
		if (!firstMe.ok) throw new Error('first admin session');
		render(
			<ToastProvider>
				<AccountView staff={firstMe.staff} />
			</ToastProvider>,
		);
		fill('E-mail', 'root@ss.test');
		await press('Save profile');
		await until(() => staff.calls.some((c) => c.path === adminApi.me() && c.status === 200 && c.body?.email));
		fill('Current password', 'first password 123!');
		fill('New password', 'root password 123!');
		await press('Change password');
		await until(() => staff.calls.some((c) => c.path === adminApi.mePassword() && c.status === 204));
		cleanup();

		// password reset by e-mail (now that the admin has one)
		render(<StaffForgotPasswordView />);
		await press('Send the link');
		expect(shows('Enter your e-mail address.')).toBe(true);
		fill('E-mail', 'root@ss.test');
		await press('Send the link');
		await until(() => shows('Check your inbox'));
		cleanup();
		window.location.hash = `#token=${encodeURIComponent(tokenOf('root@ss.test', 'password_reset'))}`;
		render(<StaffResetPasswordView />);
		await until(() => shows('New password'));
		fill('New password', 'short');
		await press('Save password');
		expect(shows('Use at least 12 characters.')).toBe(true);
		fill('New password', 'root password 123!');
		fill('Repeat the password', 'root password 123!');
		await press('Save password');
		await until(() => staff.calls.some((c) => c.path === adminApi.passwordResetConfirm() && c.status === 204));
		cleanup();
		render(<StaffResetPasswordView />);
		await until(() => shows('This link is incomplete'));
		cleanup();

		render(<StaffLoginView next="/admin/staff" />);
		await press('Continue');
		expect(shows('Enter your e-mail address, or admin.')).toBe(true);
		fill('E-mail or admin', 'admin');
		fill('Password', 'wrong password!!');
		await press('Continue');
		await until(() => staff.calls.some((c) => c.path === adminApi.login() && c.status >= 400));
		fill('Password', 'root password 123!');
		await press('Continue');
		await until(() => staff.calls.some((c) => c.path === adminApi.login() && c.status === 200));
		cleanup();

		// two-factor sign-in is optional until enrolled
		const onEnrolled = vi.fn();
		render(<StaffMfaEnrol onDone={onEnrolled} onRestart={() => undefined} />);
		await press('Set up the authenticator');
		const secret = String(
			await until(() => staff.calls.find((c) => c.path === adminApi.mfaEnrol() && c.status === 200)?.body.secret),
		);
		await until(() => shows('Code from the app'));
		fill('Code from the app', '12');
		await press('Confirm');
		expect(shows('Enter the 6-digit code from your app.')).toBe(true);
		fill('Code from the app', totpCode(secret, Date.now()));
		await press('Confirm');
		await until(() => shows('Save your recovery codes now'));
		expect(button('Done').disabled).toBe(true);
		await act(async () => {
			/** @type {HTMLInputElement} */ (document.querySelector('input[type="checkbox"]')).click();
		});
		await press('Done');
		expect(onEnrolled).toHaveBeenCalled();
		cleanup();
		// sign in again: TOTP verification (and the recovery-code toggle)
		await staff.api.post(adminApi.logout());
		render(<StaffLoginView />);
		fill('E-mail or admin', 'root@ss.test');
		fill('Password', 'root password 123!');
		await press('Continue');
		await until(() => shows('Authentication code'));
		await press('Use a recovery code instead');
		fill('Recovery code', 'nope');
		await press('Verify');
		expect(shows('Enter a recovery code like abcde-fghij.')).toBe(true);
		await press('Use the authenticator app instead');
		fill('Authentication code', '000000');
		await press('Verify');
		await until(() => staff.calls.some((c) => c.path === adminApi.mfaVerify() && c.status >= 400));
		fill('Authentication code', totpCode(secret, Date.now() + 30_000));
		await press('Verify');
		await until(() => staff.calls.some((c) => c.path === adminApi.mfaVerify() && c.status === 200));
		cleanup();
		const session = await admin.loadStaffSession(staff.api);
		if (!session.ok) throw new Error('staff session');
		const me = session.staff;

		// ---------------------------------------------------------------- seed: merchants, a pack, a subscription
		const signup = async (/** @type {string} */ email, /** @type {string} */ name) => {
			const b = browserOf(portal);
			await b.api.post('/v1/auth/merchant/signup', { email, password: 'correct horse battery', merchantName: name });
			await b.api.post('/v1/auth/merchant/verify-email', { token: tokenOf(email, 'verify_email') });
			const who = await b.api.get('/v1/me');
			return { b, merchantId: who.ok ? who.data.merchantId : '' };
		};
		const owner = await signup('owner@shop.test', 'Shop & Co');
		const other = await signup('other@else.test', 'Else Ltd');
		const merchantId = owner.merchantId;
		const site = await owner.b.api.post(`/v1/merchants/${merchantId}/websites`, { domain: 'shop.example.com' });
		const websiteId = site.ok ? site.data.website.websiteId : '';
		const key = await generateSigningKey({ kid: 'pack-1' });
		const d1 = descriptorOf(manifest());
		const up = await staff.api.post(adminApi.packs(), {
			descriptor: d1,
			signature: await signBundle({ signer: createSigner(key.privateJwk), descriptor: d1 }),
			publicJwk: key.publicJwk,
		});
		const appId = up.ok ? up.data.app.appId : '';
		await staff.api.post(adminApi.lifecycle(appId), { action: 'activate' });
		await staff.api.post(adminApi.credit(merchantId, 'credits'), {
			amountMillicredits: 100_000,
			reference: 'seed-1',
			note: 'seed',
		});
		const sub = await owner.b.api.post(`/v1/merchants/${merchantId}/websites/${websiteId}/subscriptions`, {
			appId,
			planCode: 'basic',
		});
		const subscriptionId = sub.ok ? sub.data.subscription.subscriptionId : '';
		expect(subscriptionId).toMatch(/^sub_/);

		// ---------------------------------------------------------------- shell
		render(
			<AdminShell staff={me}>
				<p>child</p>
			</AdminShell>,
		);
		expect(shows('child')).toBe(true);
		cleanup();

		// ---------------------------------------------------------------- merchants: list, suspend / resume, impersonation
		render(<MerchantsView {...await admin.loadMerchants(staff.api, {})} />);
		expect(shows('Else Ltd')).toBe(true);
		cleanup();
		render(<MerchantView {...await admin.loadMerchant(staff.api, merchantId)} staff={me} />);
		await press('Suspend');
		expect(button('Suspend merchant').disabled).toBe(true);
		type(confirmInput(), 'Shop & Co');
		fill('Reason (audited, shown to staff)', 'chargeback fraud');
		await press('Suspend merchant');
		await until(() => shows('Suspended') && shows('chargeback fraud'));
		await press('Resume');
		type(confirmInput(), 'Shop & Co');
		fill('Reason (audited, shown to staff)', 'cleared');
		await press('Resume merchant');
		await until(() => staff.calls.some((c) => c.path === adminApi.resume(merchantId) && c.status === 200));
		await press('Impersonate');
		await press('Start impersonation');
		expect(shows('It is audited.')).toBe(true);
		fill('Reason', 'ticket 42');
		await press('Start impersonation');
		await until(() => staff.calls.some((c) => c.path === adminApi.impersonationExchange() && c.status === 200));
		// the merchant session cookie now sits in this browser next to the staff cookie
		expect([...staff.jar.keys()].sort()).toEqual(['__Host-ss_merchant', '__Host-ss_staff']);
		staff.jar.delete('__Host-ss_merchant');
		await press('Impersonate');
		fill('Reason', 'ticket 43');
		await act(async () => {
			/** @type {HTMLInputElement} */ (
				[...document.querySelectorAll('input[type="radio"]')].find((r) => r.getAttribute('value') === 'product')
			).click();
		});
		await settle(1);
		await press('Start impersonation');
		expect(shows('Choose a product.')).toBe(true);
		type(byLabel(document, 'Product'), appId);
		await press('Start impersonation');
		await until(() => staff.calls.some((c) => c.path === adminApi.launch(appId)));
		await press('Cancel');
		fill('New note', 'Prefers e-mail over phone.');
		await press('Add note');
		await until(() => shows('Prefers e-mail over phone.') && shows('root@ss.test ·'));
		cleanup();

		// ---------------------------------------------------------------- websites: transfer
		render(<WebsitesView {...await admin.loadWebsites(staff.api, { domain: 'shop.example.com' })} staff={me} />);
		await press('Transfer');
		fill('Target merchant id', 'nope');
		await press('Continue');
		expect(shows('Enter the target merchant id')).toBe(true);
		fill('Target merchant id', merchantId);
		await press('Continue');
		expect(shows('already belongs')).toBe(true);
		fill('Target merchant id', other.merchantId);
		await press('Continue');
		type(confirmInput(), 'shop.example.com');
		fill('Reason (audited)', 'acquisition');
		await press('Transfer website');
		await until(() => staff.calls.some((c) => c.path === adminApi.transfer(websiteId) && c.status === 200));
		cleanup();
		// and back, so the rest of the flow uses the original owner
		await staff.api.post(adminApi.transfer(websiteId), { toMerchantId: merchantId, reason: 'undo' });

		// ---------------------------------------------------------------- apps: add (URL + connect secret), upload, lifecycle, keys, review
		render(<AppsView {...await admin.loadApps(staff.api, {})} staff={me} />);
		await press('Add product');
		fill('Product URL', 'https://product.example.com');
		fill('Connect secret', 'too-short');
		await press('Connect');
		await until(() => staff.calls.some((c) => c.path === adminApi.connect() && c.status === 422));
		expect(shows('at least 32 characters')).toBe(true);
		await press('Cancel');
		await press('Upload pack');
		await press('Upload');
		expect(shows('Paste the JSON here.')).toBe(true);
		fill('Bundle descriptor (JSON)', '{oops');
		fill('Signature (JSON: kid, alg, sig)', '[]');
		await press('Upload');
		expect(shows('Must be a JSON object.')).toBe(true);
		const d2 = descriptorOf(manifest({ version: '0.2.0', hourly: 1500 }));
		fill('Bundle descriptor (JSON)', JSON.stringify(d2));
		fill(
			'Signature (JSON: kid, alg, sig)',
			JSON.stringify(await signBundle({ signer: createSigner(key.privateJwk), descriptor: d2 })),
		);
		await press('Upload');
		await until(() => shows('Pack uploaded'));
		cleanup();

		render(<AppView {...await admin.loadApp(staff.api, appId)} staff={me} />);
		await press('Deprecate');
		type(confirmInput(), 'notice-bar');
		fill('Reason (shown to merchants with the sunset date)', 'replaced');
		await press('Deprecate');
		expect(shows('Choose a sunset date') || shows('Pick the day')).toBe(true);
		fill('Sunset date (UTC)', new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
		await press('Deprecate');
		await until(() =>
			staff.calls.some((c) => c.path === adminApi.lifecycle(appId) && c.status === 200 && c.body?.status === 'deprecated'),
		);
		await until(() => shows('Deprecated — retires'));
		await press('Activate');
		await until(() => button('Activate').closest('[role="dialog"]'));
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Activate')
			).click();
		});
		await until(() => staff.calls.some((c) => c.path === adminApi.lifecycle(appId) && c.body?.status === 'active'));
		await press('Load more').catch(() => undefined);
		cleanup();

		const v2 = await admin.loadVersion(staff.api, appId, '2');
		render(<VersionView {...v2} staff={me} />);
		await press('Reject');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Reject')
			).click();
		});
		await settle(1);
		expect(shows('Say why the version is rejected')).toBe(true);
		await press('Cancel');
		await press('Approve');
		fill('Note (optional)', 'looks good');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Approve')
			).click();
		});
		await until(() => shows('Reviewed by'));
		cleanup();

		// a service app (presentation of a pack as a service: the service-only actions answer with problems)
		const loaded = await admin.loadApp(staff.api, appId);
		if (!loaded.ok) throw new Error('app');
		const serviceApp = {
			...loaded.app,
			kind: 'service',
			endpoints: { base: 'https://svc.example.com' },
			environments: { production: 'https://svc.example.com', staging: 'https://staging.svc.example.com' },
			health: {
				lastHeartbeatAt: new Date().toISOString(),
				version: '1.0.0',
				status: 'degraded',
				queues: { jobs: 3 },
				stale: false,
			},
		};
		render(<AppView {...loaded} app={serviceApp} staff={me} />);
		expect(shows('Degraded')).toBe(true);
		await press('Refresh manifest');
		await until(() => staff.calls.some((c) => c.path === adminApi.refresh(appId)));
		await press('Save environments');
		await until(() => staff.calls.some((c) => c.path === adminApi.environments(appId)));
		await press(`Open ${serviceApp.name}`);
		expect(shows('Enter a merchant id (mer_…).')).toBe(true);
		fill('Merchant id', merchantId);
		fill('Website id (optional)', 'bad');
		await press(`Open ${serviceApp.name}`);
		expect(shows('Enter a website id')).toBe(true);
		fill('Website id (optional)', websiteId);
		await press(`Open ${serviceApp.name}`);
		await until(() => staff.calls.some((c) => c.path === adminApi.launch(appId) && c.method === 'POST'));
		await act(async () => {
			/** @type {HTMLInputElement} */ (
				[...document.querySelectorAll('input[type="radio"]')].find((r) => r.getAttribute('value') === 'all')
			).click();
		});
		await press(`Open ${serviceApp.name}`);
		await settle(2);
		await press('Revoke');
		type(confirmInput(), 'pack-1');
		fill('Reason', 'leaked');
		await press('Revoke key');
		await until(() => staff.calls.some((c) => c.path === adminApi.revokeAppKey(appId, 'pack-1') && c.status === 200));
		cleanup();

		// ---------------------------------------------------------------- admin overrides, locks, history, rollback
		const subPage = await admin.loadSubscription(staff.api, subscriptionId);
		render(<SubscriptionAdminView {...subPage} staff={me} />);
		type(byLabel(document, 'Message'), 'Admin says hi');
		await press('Save version');
		expect(shows('Give a reason')).toBe(true);
		fill('Reason', 'support ticket');
		await press('Save version');
		await until(() =>
			staff.calls.some((c) => c.path === adminApi.adminConfig(subscriptionId) && c.method === 'PATCH' && c.status === 200),
		);
		// the page refreshes (layers, histories, effective preview) and remounts the editor at the new version
		const patched = staff.calls.findIndex((c) => c.path === adminApi.adminConfig(subscriptionId) && c.method === 'PATCH');
		await until(() => staff.calls.slice(patched).some((c) => c.path.endsWith('/config/preview')));
		await settle(3);
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="switch"]')].find((s) => s.textContent?.includes('Lock Max per day')) ??
					document.querySelector('[role="switch"]')
			).click();
		});
		type(byLabel(document, 'Element switch'), 'on');
		fill('Reason', 'lock it');
		await press('Save version');

		await until(
			() => staff.calls.filter((c) => c.path === adminApi.adminConfig(subscriptionId) && c.method === 'PATCH').length >= 2,
		);
		await settle(2);
		await press('Discard');
		type(byLabel(document, 'Element'), 'badge');
		await settle(1);
		type(byLabel(document, 'Element'), 'bar');
		await settle(1);
		const resetLink = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Reset');
		if (resetLink)
			await act(async () => {
				resetLink.click();
			});
		await settle(1);
		const rollbacks = [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Roll back');
		expect(rollbacks.length).toBeGreaterThan(0);
		await act(async () => {
			/** @type {HTMLButtonElement} */ (rollbacks[0]).click();
		});
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Roll back')
			).click();
		});
		await settle(1);
		expect(shows('Say why you roll back')).toBe(true);
		fillDialog('Reason', 'undo');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Roll back')
			).click();
		});
		await until(() => staff.calls.some((c) => c.path === adminApi.adminRollback(subscriptionId) && c.status === 200));
		cleanup();

		render(<PoliciesView {...await admin.loadPolicies(staff.api, appId)} staff={me} />);
		type(byLabel(document, 'Message'), 'Platform says hi');
		fill('Reason', 'brand copy');
		await press('Save version');
		await until(() =>
			staff.calls.some((c) => c.path === adminApi.platformPolicy(appId) && c.method === 'PATCH' && c.status === 200),
		);
		const policyPatched = staff.calls.findIndex((c) => c.path === adminApi.platformPolicy(appId) && c.method === 'PATCH');
		await until(() => staff.calls.slice(policyPatched).some((c) => c.path === adminApi.platformHistory(appId)));
		await settle(3);
		type(byLabel(document, 'Message'), 'Second copy');
		fill('Reason', 'brand copy 2');
		await press('Save version');
		await until(() => staff.calls.filter((c) => c.path === adminApi.platformPolicy(appId) && c.method === 'PATCH').length >= 2);
		await until(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Roll back'));
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('button')].find((b) => b.textContent === 'Roll back')
			).click();
		});
		fillDialog('Reason', 'revert');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Roll back')
			).click();
		});
		await until(() => staff.calls.some((c) => c.path === adminApi.platformRollback(appId) && c.status === 200));
		cleanup();

		// ---------------------------------------------------------------- finance
		render(<FinanceView {...await admin.loadFinance(staff.api)} staff={me} />);
		fill('Merchant id', 'x');
		await press('Open');
		expect(shows('Enter a merchant id (mer_…).')).toBe(true);
		fill('Merchant id', merchantId);
		await press('Open');
		expect(shows('Force settlement') || shows('Run reconciliation')).toBe(false);
		cleanup();

		render(<LedgerView {...await admin.loadLedger(staff.api, merchantId)} staff={me} />);
		await press('Review');
		expect(shows('Enter an amount in credits')).toBe(true);
		fill('Amount (credits)', '12.5');
		fill('Reference', 'bank-2');
		fill('Note', 'second wire');
		await press('Review');
		await press('Add credits');
		await until(() => staff.calls.some((c) => c.path === adminApi.credit(merchantId, 'credits') && c.status === 201));
		await act(async () => {
			/** @type {HTMLInputElement} */ (
				[...document.querySelectorAll('input[type="radio"]')].find((r) => r.getAttribute('value') === 'adjustments')
			).click();
		});
		fill('Amount (credits)', '-2');
		fill('Reference', 'adj-1');
		fill('Note', 'correction');
		await press('Review');
		await press('Adjust credits');
		await until(() => staff.calls.some((c) => c.path === adminApi.credit(merchantId, 'adjustments') && c.status === 201));
		await act(async () => {
			/** @type {HTMLInputElement} */ (
				[...document.querySelectorAll('input[type="radio"]')].find((r) => r.getAttribute('value') === 'credits')
			).click();
		});
		fill('Amount (credits)', '12.5');
		fill('Reference', 'bank-2');
		fill('Note', 'again');
		await press('Review');
		await press('Add credits');
		await until(
			() =>
				shows('Already booked') || staff.calls.filter((c) => c.path === adminApi.credit(merchantId, 'credits')).length >= 2,
		);
		await press('Verify chain');
		await until(() => shows('Ledger chain intact'));
		cleanup();

		// ---------------------------------------------------------------- integration, connectors, audit (fabricated rows)
		const integration = await admin.loadIntegration(staff.api, { websiteId });
		if (!integration.ok) throw new Error('integration');
		const deadRow = {
			deliveryId: 'dlv_0000000000000000000000000z',
			eventId: 'evt_1',
			type: 'order.placed@1',
			websiteId,
			appId,
			attempts: 8,
			lastErrorCode: 'http_500',
			deadAt: new Date().toISOString(),
			expiresAt: new Date().toISOString(),
		};
		render(
			<IntegrationView
				{...integration}
				deadLetters={{ items: [deadRow], nextCursor: null }}
				deliveries={{
					items: [
						{
							...deadRow,
							kind: 'control',
							status: 'dead',
							replays: 1,
							lastHttpStatus: 500,
							createdAt: new Date().toISOString(),
						},
					],
					nextCursor: null,
				}}
				staff={me}
			/>,
		);
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('button')].find((b) => b.textContent === 'Replay')
			).click();
		});
		await until(() => staff.calls.some((c) => c.path === adminApi.replay(deadRow.deliveryId)));
		await until(() => shows('Unknown delivery'));
		cleanup();

		const connectors = await admin.loadConnectors(staff.api, {});
		render(
			<ConnectorsAdminView
				{...connectors}
				page={{
					items: [
						{
							connectorId: 'con_1',
							merchantId,
							kind: 'database',
							provider: 'mongodb',
							label: null,
							websiteIds: [websiteId],
							status: 'failing',
							lastCheckAt: new Date().toISOString(),
							lastCheckReport: { checks: [{ name: 'auth', ok: false, code: 'auth_failed' }], warnings: [] },
						},
					],
					nextCursor: null,
				}}
			/>,
		);
		expect(shows('0/1 checks passed · auth (auth_failed)')).toBe(true);
		cleanup();

		render(
			<AuditView
				ok
				available
				filter={{ scope: 'global' }}
				page={{
					items: [
						{
							auditId: 'aud_1',
							at: new Date().toISOString(),
							action: 'merchant.suspended',
							actor: { type: 'staff', id: me.staffId, via: null },
							target: { type: 'merchant', id: merchantId },
							reason: 'fraud',
							scope: 'global',
							seq: 3,
							hash: 'abc',
						},
						{
							auditId: 'aud_2',
							at: new Date().toISOString(),
							action: 'website.updated',
							actor: { type: 'merchant_user', id: 'usr_1', via: { type: 'staff', id: me.staffId } },
							target: { type: 'website', id: websiteId },
							scope: `merchant:${merchantId}`,
							seq: 9,
							hash: 'def',
						},
					],
					nextCursor: null,
				}}
			/>,
		);
		expect(shows('merchant.suspended')).toBe(true);
		expect(shows(`via ${me.staffId}`)).toBe(true);
		await press('Verify');
		await until(() => shows('Chain intact'));
		cleanup();

		render(
			<DashboardView
				ok
				staff={me}
				health={{
					available: true,
					problem: null,
					data: { jobs: { queued: 1, leased: 0, retrying: 2, dead: 0 } },
				}}
				metrics={{ deliveries: { pending: 1, retrying: 2, delivered: 3, dead: 1 }, deadLetters: 1 }}
				metricsProblem={{ status: 403, title: 'Forbidden' }}
				deadLetters={[deadRow]}
				apps={[]}
				unhealthy={[{ ...serviceApp, health: { ...serviceApp.health, stale: true } }]}
				alerts={[{ alertId: 'alr_1', kind: 'unpriced', at: new Date().toISOString(), merchantId, subscriptionId: null }]}
			/>,
		);
		expect(shows('Job queue')).toBe(true);
		expect(shows('unpriced') || shows('Unpriced')).toBe(true);
		cleanup();
		render(
			<DashboardView
				ok
				health={{ available: true, problem: { status: 500, title: 'Boom' }, data: null }}
				metrics={null}
				metricsProblem={null}
				deadLetters={[]}
				apps={[]}
				unhealthy={[]}
				alerts={[]}
			/>,
		);
		expect(shows('No finance alert.')).toBe(true);
		cleanup();

		// ---------------------------------------------------------------- staff management
		render(<StaffView {...await admin.loadStaff(staff.api, me)} />);
		await press('Invite staff');
		await press('Send invitation');
		expect(shows('Enter an e-mail address.')).toBe(true);
		fill('E-mail', 'help@ss.test');
		fill('Name (optional)', 'Help');
		await press('Send invitation');
		await until(() => shows('help@ss.test') && staff.calls.some((c) => c.path === adminApi.staffList() && c.status === 201));
		await press('Roles');
		await act(async () => {
			/** @type {HTMLInputElement} */ ([...document.querySelectorAll('[role="dialog"] input[type="checkbox"]')][0]).click();
		});
		await press('Save roles');
		await until(() => staff.calls.some((c) => c.method === 'PATCH' && c.path.startsWith('/v1/admin/staff/')));
		await settle(2);
		await press('Deactivate');
		type(confirmInput(), 'help@ss.test');
		await press('Deactivate');
		await until(() => shows('Reactivate'));
		await press('Reactivate');
		type(confirmInput(), 'help@ss.test');
		await press('Reactivate');
		await until(() => staff.calls.filter((c) => c.method === 'PATCH' && c.path.startsWith('/v1/admin/staff/')).length >= 3);
		cleanup();

		// ---------------------------------------------------------------- client helpers, banner, sign out
		function Probe() {
			const r = useAdminResource('/v1/admin/merchants/mer_0000000000000000000000000z', null);
			return (
				<div>
					<button type="button" onClick={() => void r.reload()}>
						reload
					</button>
					<span>{r.problem ? 'problem' : 'none'}</span>
					<IdChip id="mer_x" />
					<IdChip id={null} />
				</div>
			);
		}
		render(<Probe />);
		await press('reload');
		await until(() => shows('problem'));
		await act(async () => {
			/** @type {HTMLButtonElement} */ (document.querySelector('[aria-label="Copy id"]')).click();
		});
		cleanup();
		const anonymous = browserOf(portal);
		vi.stubGlobal('fetch', anonymous.fetch);
		expect((await adminFetch(adminApi.merchants())).status).toBe(401);
		staffSignInAgain('/admin/x');
		render(
			<ImpersonationBanner
				impersonation={{ staffId: me.staffId, expiresAt: new Date().toISOString() }}
				userEmail="a@b.test"
			/>,
		);
		await press('End impersonation');
		await until(() => anonymous.calls.some((c) => c.path === '/v1/auth/merchant/logout'));
		cleanup();
		staff.use();
		render(
			<AdminShell staff={me}>
				<p>x</p>
			</AdminShell>,
		);
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Sign out'))
			).click();
		});
		await until(() => staff.calls.some((c) => c.path === adminApi.logout() && c.status === 204));
		expect((await admin.loadStaffSession(staff.api)).ok).toBe(false);
		expect(adminRoutes.policies(appId)).toBe(`/admin/apps/${appId}/policies`);
		errors.mockRestore();
		vi.unstubAllGlobals();
	});
});
