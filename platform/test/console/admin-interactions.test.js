// @vitest-environment jsdom
/**
 * Admin Console in the browser (jsdom): the views are rendered client-side against a live in-process Portal —
 * `fetch` is routed to `portal.handle` with a cookie jar, as a same-origin browser would — and driven through
 * their forms and dialogs: Overview, Merchants (search, bulk actions, Add merchant), the merchant page (suspend and
 * resume, setup links, two-step off, Details, websites and products, delete), Admins, Settings, Activity, My
 * account, product connect and pack folder upload, the Active / Inactive switch, the admin launch, admin overrides
 * and locks, platform policies and rollback, credit operations and ledger verification.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { totpCode } from '../../src/infra/auth.js';
import { closeMongoClients } from '../../src/infra/db.js';
import { createSystemStore } from '../../src/infra/system.js';
import { createPortal } from '../../src/portal.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { createIdentityModule } from '../../src/modules/identity/index.js';
import { createConsoleApi } from '../../src/console/api.js';
import * as admin from '../../src/console/admin/loaders.js';
import { adminApi, adminRoutes } from '../../src/console/admin/paths.js';
import { adminFetch, adminSignInAgain, useAdminResource } from '../../src/console/admin/client.js';
import { AdminShell } from '../../src/console/admin/views/shell.js';
import { MyAccountView } from '../../src/console/admin/views/account.js';
import { ActivityView } from '../../src/console/admin/views/activity.js';
import { AdminsView } from '../../src/console/admin/views/admins.js';
import { OverviewView } from '../../src/console/admin/views/overview.js';
import { MerchantView, MerchantsView } from '../../src/console/admin/views/merchants.js';
import { AppView, AppsView } from '../../src/console/admin/views/apps.js';
import { PoliciesView, SubscriptionAdminView } from '../../src/console/admin/views/config.js';
import { FinanceView, LedgerView } from '../../src/console/admin/views/finance.js';
import { ConnectorsAdminView } from '../../src/console/admin/views/operations.js';
import { SettingsView } from '../../src/console/admin/views/settings.js';
import { IdChip } from '../../src/console/admin/views/common.js';
import { ToastProvider } from '@ss/ui';
import { act, byLabel, cleanup, render, type } from '@ss/ui/testing';
import { ENCRYPTION_KEY, PORTAL_URL, createTestLogger, startMongo, testConfig } from '../helpers.js';

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

/**
 * Pick a folder in the open pack dialog's folder input.
 * @param {unknown[]} files
 */
const pickFolder = async (files) => {
	const input = /** @type {HTMLInputElement} */ (document.querySelector('[role="dialog"] input[type="file"]'));
	Object.defineProperty(input, 'files', { value: files, configurable: true });
	await act(async () => {
		input.dispatchEvent(new Event('change', { bubbles: true }));
	});
};

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
			placement: true,
			headless: 'headless/badge.js#createBadge',
			renderer: 'ui/badge.js#render',
		},
	],
	plans: [{ code: 'basic', name: 'Basic', elements: ['bar'], addons: ['badge'] }],
	priceBook: { version: '1', effectiveFrom: '2026-01-01T00:00:00.000Z' },
});

/** @param {string} version asset files of a build (their content changes with the version) */
const assetsOf = (version) => ({
	'headless/bar.js': `export const createBar = () => ({ v: '${version}' });`,
	'ui/bar.js': `export const render = () => '${version}';`,
	'headless/badge.js': `export const createBadge = () => ({ v: '${version}' });`,
	'ui/badge.js': `export const render = () => 'badge ${version}';`,
});

/** @param {any} m */
const descriptorOf = (m) => ({
	format: 'ss-pack-bundle@1',
	manifest: m,
	assets: Object.entries(assetsOf(m.product.version)).map(([path, body]) => ({
		path,
		sha256: createHash('sha256').update(body).digest('hex'),
		size: Buffer.byteLength(body),
		contentType: 'text/javascript',
	})),
});

/**
 * The folder `ss pack build` writes, as picked files (Node Blobs carrying `webkitRelativePath`).
 * @param {any} m
 */
const folderOf = (m) =>
	Object.entries({ 'descriptor.json': JSON.stringify(descriptorOf(m)), ...assetsOf(m.product.version) }).map(([path, body]) =>
		Object.assign(new NodeBlob([body], { type: path.endsWith('.json') ? 'application/json' : 'text/javascript' }), {
			name: path.split('/').at(-1),
			webkitRelativePath: `pack/${path}`,
		}),
	);

describe('admin console interactions (jsdom)', () => {
	it('drives every admin page against a live Portal', async () => {
		/** @type {Array<{ to: string, template: string, data: Record<string, any> }>} */
		const mail = [];
		const mailer = { available: true, send: async (/** @type {any} */ m) => void mail.push(m) };
		const modules = defaultModules.map((m) => (m.name === 'identity' ? createIdentityModule({ mailer }) : m));
		const portal = createPortal({
			config: await testConfig({ STORAGE_DIR: ':memory:' }),
			db: mongo.db('admin_ui'),
			system: createSystemStore(mongo.db('admin_ui'), { encryptionKey: ENCRYPTION_KEY }),
			modules,
			logger: createTestLogger().logger,
			background: { mode: 'on', fallback: (task) => void task() },
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

		// ---------------------------------------------------------------- the first admin (an Owner)
		const staff = browserOf(portal);
		staff.use();
		const created = await staff.api.post('/v1/auth/first-admin', {
			name: 'Rita Root',
			email: 'root@ss.test',
			password: 'root password 123!',
		});
		expect(created.ok).toBe(true);
		const session = await admin.loadAdminSession(staff.api);
		if (!session.ok) throw new Error('admin session');
		const me = session.admin;

		// My account: the name
		render(
			<ToastProvider>
				<MyAccountView {...await admin.loadMyAccount(staff.api)} />
			</ToastProvider>,
		);
		await until(() => shows('Your activity'));
		fill('Name', 'Rita R.');
		await press('Save');
		await until(() => staff.calls.some((c) => c.method === 'PATCH' && c.path === adminApi.me() && c.status === 200));
		cleanup();

		// ---------------------------------------------------------------- seed: merchants, a pack, a product on a website
		const signup = async (/** @type {string} */ email, /** @type {string} */ name) => {
			const made = await staff.api.post(adminApi.createMerchant(), { name, ownerName: 'Owner', email });
			const b = browserOf(portal);
			await b.api.post('/v1/auth/set-password', {
				token: tokenOf(email, 'merchant_setup'),
				password: 'correct horse battery',
			});
			return { b, merchantId: made.ok ? made.data.merchant.merchantId : '' };
		};
		const owner = await signup('owner@shop.test', 'Shop & Co');
		const other = await signup('other@else.test', 'Else Ltd');
		const merchantId = owner.merchantId;
		const site = await staff.api.post(`/v1/merchants/${merchantId}/websites`, { domain: 'shop.example.com' });
		const websiteId = site.ok ? site.data.website.websiteId : '';
		// the pack: its folder uploaded through the Apps page ("Add pack"), then activated with the switch
		render(<AppsView {...await admin.loadApps(staff.api, {})} admin={me} />);
		await press('Add pack');
		await pickFolder(folderOf(manifest()));
		await press('Upload');
		await until(() => shows('Uploaded'));
		const posted = staff.calls.find((c) => c.path === adminApi.packs() && c.status < 300)?.body;
		const appId = String(posted?.appId);
		expect(staff.calls.filter((c) => c.method === 'PUT' && c.path.startsWith(posted.uploadPath))).toHaveLength(4);
		cleanup();
		render(
			<ToastProvider>
				<AppView {...await admin.loadApp(staff.api, appId)} admin={me} />
			</ToastProvider>,
		);
		await until(() => shows('Upload pack version'));
		await act(async () => {
			/** @type {HTMLElement} */ (document.querySelector('[role="switch"]')).click();
		});
		await until(() => staff.calls.some((c) => c.path === adminApi.status(appId) && c.status === 200));
		cleanup();
		await staff.api.post(adminApi.credit(merchantId, 'credits'), {
			amountMillicredits: 100_000,
			reference: 'seed-1',
			note: 'seed',
		});
		const sub = await staff.api.post(`/v1/merchants/${merchantId}/websites/${websiteId}/subscriptions`, {
			appId,
			planCode: 'basic',
		});
		const subscriptionId = sub.ok ? sub.data.subscription.subscriptionId : '';
		expect(subscriptionId).toMatch(/^sub_/);

		// ---------------------------------------------------------------- shell and Overview
		render(
			<AdminShell admin={me}>
				<p>child</p>
			</AdminShell>,
		);
		expect(shows('child')).toBe(true);
		cleanup();
		render(<OverviewView {...await admin.loadOverview(staff.api)} admin={me} />);
		expect(shows('E-mail sending is not set up') && shows('Set up e-mail sending')).toBe(true);
		cleanup();

		// ---------------------------------------------------------------- merchants: search, bulk, Add merchant
		render(
			<ToastProvider>
				<MerchantsView {...await admin.loadMerchants(staff.api, {})} admin={me} />
			</ToastProvider>,
		);
		expect(shows('Else Ltd') && shows('Shop & Co')).toBe(true);
		fill('Search name, owner e-mail or domain', 'else');
		await press('Filter');
		cleanup();
		render(
			<ToastProvider>
				<MerchantsView {...await admin.loadMerchants(staff.api, {})} admin={me} />
			</ToastProvider>,
		);
		await act(async () => {
			/** @type {HTMLInputElement} */ (document.querySelector('input[aria-label="Select Else Ltd"]')).click();
		});
		await press('Suspend');
		fillDialog('Reason', 'chargeback');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Suspend')
			).click();
		});
		await until(() => staff.calls.some((c) => c.path === adminApi.bulk() && c.status === 200));
		await until(() => shows('1 done.'));
		await act(async () => {
			/** @type {HTMLInputElement} */ (document.querySelector('input[aria-label="Select Else Ltd"]')).click();
		});
		await press('Resume');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Resume')
			).click();
		});
		await until(() => staff.calls.filter((c) => c.path === adminApi.bulk() && c.status === 200).length >= 2);
		await press('Add merchant');
		fillDialog('Business name', 'Ops Made Ltd');
		fillDialog('Owner name', 'Olga');
		fillDialog('Owner e-mail (login)', 'ops-owner@made.test');
		fillDialog('Phone', '+92 300 1111111');
		await act(async () => {
			type(byLabel(/** @type {HTMLElement} */ (document.querySelector('[role="dialog"]')), 'Country'), 'PK');
		});
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Add merchant')
			).click();
		});
		const made = /** @type {any} */ (
			await until(
				() => staff.calls.find((c) => c.method === 'POST' && c.path === adminApi.createMerchant() && c.status === 201)?.body,
			)
		);
		const madeId = String(made.merchant.merchantId);
		cleanup();

		// ---------------------------------------------------------------- the merchant page
		const writeText = vi.fn(async () => undefined);
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		staff.use();
		render(
			<ToastProvider>
				<MerchantView {...await admin.loadMerchant(staff.api, madeId)} admin={me} />
			</ToastProvider>,
		);
		await until(() => shows('Setup pending'));
		await press('Copy setup link');
		await until(() => shows('Copy this link now.'));
		await act(async () => {
			/** @type {HTMLButtonElement} */ (document.querySelector('[role="dialog"] button[aria-label="Close"]'))?.click();
		});
		await press('Resend setup link');
		await until(() => staff.calls.filter((c) => c.path === adminApi.setupLink(madeId) && c.status === 200).length >= 2);
		await press('Suspend');
		fillDialog('Reason', 'unpaid');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Suspend')
			).click();
		});
		await until(() => shows('Suspended: unpaid'));
		await press('Resume');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Resume')
			).click();
		});
		await until(() => staff.calls.some((c) => c.path === adminApi.resume(madeId) && c.status === 200));
		// websites: add one, add a product, remove the product first, then the website
		await press('Add website');
		fillDialog('Domain', 'made.example.com');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.includes('Add website'))
			).click();
		});
		const madeSite = String(
			await until(
				() =>
					staff.calls.find((c) => c.method === 'POST' && c.path === `/v1/merchants/${madeId}/websites` && c.status === 201)
						?.body.website.websiteId,
			),
		);
		await until(() => shows('made.example.com'));
		await press('Add product');
		await until(() => shows('Subscribe to Notice bar') || shows('Not enough credits'));
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Cancel')
			).click();
		});
		// Details: the fields, the login e-mail until the password is set
		await press('Details');
		fill('Address', 'Industrial area');
		fill('Owner e-mail (login)', 'olga@made.test');
		await press('Save');
		await until(() =>
			staff.calls.some((c) => c.method === 'PATCH' && c.path === adminApi.merchant(madeId) && c.status === 200),
		);
		await press('Activity');
		await until(() => shows('Merchant created'));
		await press('Websites');
		await press('Remove website');
		type(confirmInput(), 'made.example.com');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Remove website')
			).click();
		});
		await until(() =>
			staff.calls.some(
				(c) => c.method === 'DELETE' && c.path === `/v1/merchants/${madeId}/websites/${madeSite}` && c.status === 200,
			),
		);
		await until(() => !shows('made.example.com'));
		// delete the merchant (no websites left): typed business name
		await press('Delete');
		type(confirmInput(), 'Ops Made Ltd');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Delete')
			).click();
		});
		await until(() =>
			staff.calls.some((c) => c.method === 'DELETE' && c.path === adminApi.merchant(madeId) && c.status === 204),
		);
		cleanup();
		// two-step off for a merchant with two-step on
		// the bulk suspension ended the merchant's sessions: sign in again
		await other.b.api.post('/v1/auth/sign-in', { email: 'other@else.test', password: 'correct horse battery' });
		const started = await other.b.api.post('/v1/me/two-step/start');
		await other.b.api.post('/v1/me/two-step/confirm', { code: totpCode(started.ok ? started.data.secret : '', Date.now()) });
		render(
			<ToastProvider>
				<MerchantView {...await admin.loadMerchant(staff.api, other.merchantId)} admin={me} />
			</ToastProvider>,
		);
		await press('Turn off two-step');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Turn off two-step')
			).click();
		});
		await until(() => staff.calls.some((c) => c.path === adminApi.merchantTwoStepOff(other.merchantId) && c.status === 200));
		cleanup();
		vi.unstubAllGlobals();
		staff.use();

		// ---------------------------------------------------------------- apps: add (URL + connect secret), a new pack version, launch
		render(<AppsView {...await admin.loadApps(staff.api, { status: 'active' })} admin={me} />);
		expect(shows('notice-bar')).toBe(true);
		await press('Add product');
		fill('Product URL', 'https://product.example.com');
		fill('Connect secret', 'too-short');
		await press('Connect');
		await until(() => staff.calls.some((c) => c.path === adminApi.connect() && c.status === 422));
		await press('Cancel');
		cleanup();

		render(
			<ToastProvider>
				<AppView {...await admin.loadApp(staff.api, appId)} admin={me} />
			</ToastProvider>,
		);
		await press('Upload pack version');
		await pickFolder(folderOf(manifest({ version: '0.2.0', hourly: 1500 })));
		await press('Upload');
		await until(() => shows('Version v2 of notice-bar is uploaded'));
		await until(() => shows('v2 (0.2.0)'));
		cleanup();

		// a service app (presentation of the pack as a service): the admin launch (production)
		const loaded = await admin.loadApp(staff.api, appId);
		if (!loaded.ok) throw new Error('app');
		const serviceApp = { ...loaded.app, kind: 'service', baseUrl: 'https://svc.example.com' };
		render(<AppView {...loaded} app={serviceApp} manifest={manifest()} admin={me} />);
		expect(shows('Upload widgets')).toBe(true);
		fill('Merchant id', merchantId);
		await press(`Open ${serviceApp.name}`);
		await until(() => staff.calls.some((c) => c.path === adminApi.launch(appId) && c.method === 'POST'));
		cleanup();

		// ---------------------------------------------------------------- admin overrides, locks, history, rollback
		const subPage = await admin.loadSubscription(staff.api, subscriptionId);
		render(<SubscriptionAdminView {...subPage} admin={me} />);
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

		render(<PoliciesView {...await admin.loadPolicies(staff.api, appId)} admin={me} />);
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
		render(<FinanceView {...await admin.loadFinance(staff.api)} admin={me} />);
		fill('Merchant id', 'x');
		await press('Open');
		expect(shows('Enter a merchant id (mer_…).')).toBe(true);
		fill('Merchant id', merchantId);
		await press('Open');
		expect(shows('Force settlement') || shows('Run reconciliation')).toBe(false);
		cleanup();

		render(<LedgerView {...await admin.loadLedger(staff.api, merchantId)} admin={me} />);
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

		// ---------------------------------------------------------------- connectors (fabricated rows)
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

		// ---------------------------------------------------------------- Activity: filters
		render(<ActivityView {...await admin.loadActivity(staff.api, { merchantId })} />);
		await until(() => shows('Merchant created'));
		fill('Admin id', me.adminId);
		fill('From (UTC day)', '2026-01-01');
		await press('Filter');
		cleanup();

		// ---------------------------------------------------------------- Settings: e-mail sending, branding, support, security
		render(
			<ToastProvider>
				<SettingsView {...await admin.loadSettings(staff.api)} />
			</ToastProvider>,
		);
		fill('SMTP host', 'smtp.example.com');
		fill('Port', '587');
		fill('User', 'mailer');
		fill('Password', 'smtp secret');
		fill('Sender name', 'Portal');
		fill('Sender address', 'no-reply@example.com');
		await act(async () => {
			/** @type {HTMLInputElement} */ (byLabel(document, 'Implicit TLS (port 465)')).click();
		});
		await press('Save');
		await until(() => staff.calls.some((c) => c.path === adminApi.settingsMail() && c.status === 200));
		await until(() => shows('Send test e-mail'));
		await press('Send test e-mail');
		await until(() => staff.calls.some((c) => c.path === adminApi.settingsMailTest()));
		await press('Turn e-mail sending off');
		await until(() => staff.calls.filter((c) => c.path === adminApi.settingsMail() && c.status === 200).length >= 2);
		await press('Branding');
		fill('Name', 'Acme Portal');
		await press('Save');
		await until(() => staff.calls.some((c) => c.path === adminApi.settingsBranding() && c.status === 200));
		const logo = /** @type {HTMLInputElement} */ (document.querySelector('input[type="file"]'));
		const svg = Object.assign(new NodeBlob(['<svg/>'], { type: 'image/svg+xml' }), { name: 'logo.svg' });
		Object.defineProperty(logo, 'files', { value: [svg], configurable: true });
		await act(async () => {
			logo.dispatchEvent(new Event('change', { bubbles: true }));
		});
		await until(() => shows('Use a PNG, JPEG or WebP file.'));
		const png = Object.assign(
			new NodeBlob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: 'image/png' }),
			{ name: 'logo.png' },
		);
		Object.defineProperty(logo, 'files', { value: [png], configurable: true });
		await act(async () => {
			logo.dispatchEvent(new Event('change', { bubbles: true }));
		});
		await until(() => staff.calls.some((c) => c.path === adminApi.settingsLogo() && c.status === 200));
		await until(() => shows('Remove logo'));
		await press('Remove logo');
		await until(() => staff.calls.some((c) => c.method === 'DELETE' && c.path === adminApi.settingsLogo()));
		await press('Support contact');
		fill('E-mail', 'help@acme.test');
		fill('Phone', '+92 300 1234567');
		await press('Save');
		await until(() => staff.calls.some((c) => c.path === adminApi.settingsSupport() && c.status === 200));
		await press('Security');
		fill('Session length (hours)', '0');
		await press('Save');
		await until(() => staff.calls.some((c) => c.path === adminApi.settingsSecurity() && c.status === 422));
		fill('Session length (hours)', '24');
		await act(async () => {
			/** @type {HTMLElement} */ (document.querySelector('[role="switch"]')).click();
		});
		await press('Save');
		await until(() => staff.calls.some((c) => c.path === adminApi.settingsSecurity() && c.status === 200));
		cleanup();
		render(<SettingsView ok={false} problem={{ status: 403, title: 'Forbidden' }} />);
		expect(shows('Not permitted')).toBe(true);
		cleanup();
		// back to no two-step requirement for the rest of the flow
		await staff.api.request('PUT', adminApi.settingsSecurity(), { sessionHours: 24, requireTwoStepForAdmins: false });

		// ---------------------------------------------------------------- Admins
		render(
			<ToastProvider>
				<AdminsView {...await admin.loadAdmins(staff.api, me)} />
			</ToastProvider>,
		);
		await press('Invite');
		fillDialog('E-mail', 'help@ss.test');
		await act(async () => {
			type(byLabel(/** @type {HTMLElement} */ (document.querySelector('[role="dialog"]')), 'Role'), 'support');
		});
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Invite')
			).click();
		});
		await until(() => shows('help@ss.test') && staff.calls.some((c) => c.path === adminApi.admins() && c.status === 201));
		await press('Copy invite link');
		await until(() => shows('Copy this link now.'));
		await act(async () => {
			/** @type {HTMLButtonElement} */ (document.querySelector('[role="dialog"] button[aria-label="Close"]'))?.click();
		});
		await press('Resend invite');
		await press('Correct invite e-mail');
		fillDialog('E-mail', 'helpdesk@ss.test');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Correct invite e-mail')
			).click();
		});
		await until(() => shows('helpdesk@ss.test'));
		await press('Change role');
		await act(async () => {
			type(byLabel(/** @type {HTMLElement} */ (document.querySelector('[role="dialog"]')), 'Role'), 'finance');
		});
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Change role')
			).click();
		});
		await until(() =>
			staff.calls.some((c) => c.method === 'PATCH' && c.path.startsWith('/v1/admin/admins/') && c.status === 200),
		);
		await settle(2);
		await press('Remove');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Remove')
			).click();
		});
		await until(() =>
			staff.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/v1/admin/admins/') && c.status === 204),
		);
		cleanup();

		// ---------------------------------------------------------------- client helpers, sign out
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
		adminSignInAgain('/admin/x');
		staff.use();
		render(
			<AdminShell admin={me}>
				<p>x</p>
			</AdminShell>,
		);
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Sign out'))
			).click();
		});
		await until(() => staff.calls.some((c) => c.path === adminApi.signOut() && c.status === 204));
		expect((await admin.loadAdminSession(staff.api)).ok).toBe(false);
		expect(adminRoutes.policies(appId)).toBe(`/admin/apps/${appId}/policies`);
		errors.mockRestore();
		vi.unstubAllGlobals();
	});
});
