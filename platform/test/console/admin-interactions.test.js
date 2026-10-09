// @vitest-environment jsdom
/**
 * Admin Console in the browser (jsdom): the views are rendered client-side against a live in-process Portal —
 * `fetch` is routed to `portal.handle` with a cookie jar, as a same-origin browser would — and driven through
 * their forms and dialogs: the first admin, My account, Overview, the Merchants screen (search, bulk actions, Add
 * merchant; a selected merchant: suspend and resume, setup links, two-step off, Edit merchant, websites, delete), Credits
 * and billing, Activity, Settings and the Admins screen.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { totpCode } from '../../src/infra/auth.js';
import { closeMongoClients } from '../../src/infra/db.js';
import { createSystemStore } from '../../src/infra/system.js';
import { createPortal } from '../../src/portal.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { createIdentityModule } from '../../src/modules/identity/index.js';
import { createConsoleApi } from '../../src/console/api.js';
import * as admin from '../../src/console/admin/loaders.js';
import { adminApi } from '../../src/console/admin/paths.js';
import { adminFetch, adminSignInAgain, useAdminResource } from '../../src/console/admin/client.js';
import { AdminShell } from '../../src/console/admin/views/shell.js';
import { MyAccountView } from '../../src/console/admin/views/account.js';
import { ActivityView } from '../../src/console/admin/views/activity.js';
import { AdminsView } from '../../src/console/admin/views/admins.js';
import { OverviewView } from '../../src/console/admin/views/overview.js';
import { MerchantsView } from '../../src/console/admin/views/merchants.js';
import { AddCreditsDialog, FinanceView } from '../../src/console/admin/views/finance.js';
import { SettingsView } from '../../src/console/admin/views/settings.js';
import { ToastProvider } from '@ss/ui';
import { act, byLabel, cleanup, render, type } from '@ss/ui/testing';
import { ENCRYPTION_KEY, PORTAL_URL, createTestLogger, startMongo, testConfig } from '../helpers.js';

vi.mock('next/navigation.js', async (importOriginal) => {
	const { testRouter } = await import('./router.js');
	return { .../** @type {object} */ (await importOriginal()), useRouter: () => testRouter };
});

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

/**
 * Press the Save button of one settings card.
 * @param {string} title the card's title
 */
const saveIn = async (title) => {
	await act(async () => {
		/** @type {HTMLButtonElement} */ (
			[...document.querySelectorAll(`section[aria-label="${title}"] button`)].find((b) => b.textContent === 'Save')
		).click();
	});
	await settle(1);
};

/**
 * Open a header's More menu (⋯), then choose one of its actions.
 * @param {string} label
 */
const choose = async (label) => {
	await act(async () => {
		/** @type {HTMLButtonElement} */ (
			document.querySelector('button[aria-haspopup="menu"][aria-label^="More actions for"]')
		).click();
	});
	await press(label);
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

describe('admin console interactions (jsdom)', () => {
	it('drives every admin page against a live Portal', async () => {
		/** @type {Array<{ to: string, template: string, data: Record<string, any> }>} */
		const mail = [];
		const mailer = { available: true, send: async (/** @type {any} */ m) => void mail.push(m) };
		const modules = defaultModules.map((m) => (m.name === 'identity' ? createIdentityModule({ mailer }) : m));
		const portal = createPortal({
			config: await testConfig(),
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
		const ownerBrowser = browserOf(portal);
		ownerBrowser.use();
		const created = await ownerBrowser.api.post('/v1/auth/first-admin', {
			name: 'Rita Root',
			email: 'root@ss.test',
			password: 'root password 123!',
		});
		expect(created.ok).toBe(true);
		const session = await admin.loadAdminSession(ownerBrowser.api);
		if (!session.ok) throw new Error('admin session');
		const me = session.admin;

		// My account: the name
		render(
			<ToastProvider>
				<MyAccountView {...await admin.loadMyAccount(ownerBrowser.api)} />
			</ToastProvider>,
		);
		await until(() => shows('Your activity'));
		fill('Name', 'Rita R.');
		await press('Save');
		await until(() => ownerBrowser.calls.some((c) => c.method === 'PATCH' && c.path === adminApi.me() && c.status === 200));
		cleanup();

		// ---------------------------------------------------------------- seed: merchants, a website, credits
		const signup = async (/** @type {string} */ email, /** @type {string} */ name) => {
			const made = await ownerBrowser.api.post(adminApi.createMerchant(), { name, ownerName: 'Owner', email });
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
		expect((await ownerBrowser.api.post(`/v1/merchants/${merchantId}/websites`, { domain: 'shop.example.com' })).ok).toBe(true);
		await ownerBrowser.api.post(adminApi.addReceipt(merchantId), {
			credits: 100,
			amountPaid: 'PKR 10,000',
			method: 'Cash',
			reference: 'seed-1',
		});

		// ---------------------------------------------------------------- shell and Overview
		render(
			<AdminShell admin={me}>
				<p>child</p>
			</AdminShell>,
		);
		expect(shows('child')).toBe(true);
		cleanup();
		render(<OverviewView {...await admin.loadOverview(ownerBrowser.api)} admin={me} />);
		expect(shows('E-mail sending is not set up') && shows('Set up e-mail sending')).toBe(true);
		cleanup();

		// ---------------------------------------------------------------- merchants: search, bulk, Add merchant
		render(
			<ToastProvider>
				<MerchantsView {...await admin.loadMerchants(ownerBrowser.api, {})} admin={me} />
			</ToastProvider>,
		);
		expect(shows('Else Ltd') && shows('Shop & Co')).toBe(true);
		fill('Search name, owner e-mail or domain', 'else');
		await press('Filter');
		cleanup();
		render(
			<ToastProvider>
				<MerchantsView {...await admin.loadMerchants(ownerBrowser.api, {})} admin={me} />
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
		await until(() => ownerBrowser.calls.some((c) => c.path === adminApi.bulk() && c.status === 200));
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
		await until(() => ownerBrowser.calls.filter((c) => c.path === adminApi.bulk() && c.status === 200).length >= 2);
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
				() =>
					ownerBrowser.calls.find((c) => c.method === 'POST' && c.path === adminApi.createMerchant() && c.status === 201)
						?.body,
			)
		);
		const madeId = String(made.merchant.merchantId);
		cleanup();

		// ---------------------------------------------------------------- a merchant selected: one page, actions as dialogs
		const writeText = vi.fn(async () => undefined);
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		ownerBrowser.use();
		render(
			<ToastProvider>
				<MerchantsView
					{...await admin.loadMerchants(ownerBrowser.api, {})}
					detail={await admin.loadMerchant(ownerBrowser.api, madeId, me)}
					selectedId={madeId}
					admin={me}
				/>
			</ToastProvider>,
		);
		await until(() => shows('Setup pending'));
		await choose('Copy setup link');
		await until(() => shows('Copy this link now.'));
		await act(async () => {
			/** @type {HTMLButtonElement} */ (document.querySelector('[role="dialog"] button[aria-label="Close"]'))?.click();
		});
		await choose('Resend setup link');
		await until(() => ownerBrowser.calls.filter((c) => c.path === adminApi.setupLink(madeId) && c.status === 200).length >= 2);
		await choose('Suspend');
		fillDialog('Reason', 'unpaid');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Suspend')
			).click();
		});
		await until(() => shows('Suspended: unpaid'));
		await choose('Resume');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Resume')
			).click();
		});
		await until(() => ownerBrowser.calls.some((c) => c.path === adminApi.resume(madeId) && c.status === 200));
		// websites: add one (the exact domain); it shows as a card
		await press('Add website');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.includes('Add website'))
			).click();
		});
		await until(() => shows('Enter the domain, for example shop.com.'));
		fillDialog('Domain', 'made.example.com');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.includes('Add website'))
			).click();
		});
		const madeSite = String(
			await until(
				() =>
					ownerBrowser.calls.find(
						(c) => c.method === 'POST' && c.path === `/v1/merchants/${madeId}/websites` && c.status === 201,
					)?.body.website.websiteId,
			),
		);
		await until(() => document.getElementById(`website-${madeSite}`)?.textContent?.includes('made.example.com'));
		expect(document.querySelector(`button[aria-label="Add product to made.example.com"]`)).not.toBeNull();
		// Edit merchant: the fields in a dialog, the login e-mail until the password is set
		await press('Edit merchant');
		fillDialog('Address', 'Industrial area');
		fillDialog('Owner e-mail (login)', 'olga@made.test');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Save')
			).click();
		});
		await until(() =>
			ownerBrowser.calls.some((c) => c.method === 'PATCH' && c.path === adminApi.merchant(madeId) && c.status === 200),
		);
		await until(() => !document.querySelector('[role="dialog"]') && shows('olga@made.test'));
		// credits and activity are sections of the same page
		expect(shows('Credit receipts') && shows('Merchant created')).toBe(true);
		// a merchant with a website cannot be deleted: Delete is last in the More menu, disabled, with the reason
		await act(async () => {
			/** @type {HTMLButtonElement} */ (document.querySelector('button[aria-label^="More actions for"]')).click();
		});
		const items = [...document.querySelectorAll('[role="menuitem"]')];
		expect(items.at(-1)?.textContent).toBe('Delete');
		expect(/** @type {HTMLButtonElement} */ (items.at(-1)).disabled).toBe(true);
		expect(shows('Remove the websites of this merchant first.')).toBe(true);
		await ownerBrowser.api.request('DELETE', `/v1/merchants/${madeId}/websites/${madeSite}`, { confirm: 'made.example.com' });
		cleanup();
		render(
			<ToastProvider>
				<MerchantsView
					{...await admin.loadMerchants(ownerBrowser.api, {})}
					detail={await admin.loadMerchant(ownerBrowser.api, madeId, me)}
					selectedId={madeId}
					admin={me}
				/>
			</ToastProvider>,
		);
		// delete the merchant (no websites left): typed business name
		await choose('Delete');
		type(confirmInput(), 'Ops Made Ltd');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Delete')
			).click();
		});
		await until(() =>
			ownerBrowser.calls.some((c) => c.method === 'DELETE' && c.path === adminApi.merchant(madeId) && c.status === 204),
		);
		cleanup();
		// two-step off for a merchant with two-step on
		// the bulk suspension ended the merchant's sessions: sign in again
		await other.b.api.post('/v1/auth/sign-in', { email: 'other@else.test', password: 'correct horse battery' });
		const started = await other.b.api.post('/v1/me/two-step/start');
		await other.b.api.post('/v1/me/two-step/confirm', { code: totpCode(started.ok ? started.data.secret : '', Date.now()) });
		render(
			<ToastProvider>
				<MerchantsView
					{...await admin.loadMerchants(ownerBrowser.api, {})}
					detail={await admin.loadMerchant(ownerBrowser.api, other.merchantId, me)}
					selectedId={other.merchantId}
					admin={me}
				/>
			</ToastProvider>,
		);
		await choose('Turn off two-step');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Turn off two-step')
			).click();
		});
		await until(() =>
			ownerBrowser.calls.some((c) => c.path === adminApi.merchantTwoStepOff(other.merchantId) && c.status === 200),
		);
		cleanup();
		vi.unstubAllGlobals();
		ownerBrowser.use();

		// ---------------------------------------------------------------- credits and billing
		render(
			<ToastProvider>
				<FinanceView {...await admin.loadBilling(ownerBrowser.api, { merchantId })} admin={me} />
			</ToastProvider>,
		);
		expect(shows('No merchant is low, in grace or stopped.')).toBe(true);
		cleanup();

		let added = 0;
		render(
			<ToastProvider>
				<AddCreditsDialog
					merchant={{ merchantId, name: 'Shop' }}
					balance={100_000}
					onClose={() => {}}
					onAdded={() => void (added += 1)}
				/>
			</ToastProvider>,
		);
		await press('Review');
		expect(shows('A whole number of 1 or more.')).toBe(true);
		fill('Credits', '25');
		fill('Amount paid', 'PKR 2,500');
		fill('Payment method', 'Bank transfer');
		fill('Reference (optional)', 'bank-2');
		await press('Review');
		expect(shows('Confirm the receipt')).toBe(true);
		expect(shows('125 credits')).toBe(true); // the new balance
		await press('Back');
		await press('Review');
		await press('Add credits');
		await until(() => added === 1);
		expect(ownerBrowser.calls.filter((c) => c.path === adminApi.addReceipt(merchantId) && c.status === 201)).toHaveLength(1);
		cleanup();

		// ---------------------------------------------------------------- Activity: filters
		render(<ActivityView {...await admin.loadActivity(ownerBrowser.api, { merchantId })} />);
		await until(() => shows('Merchant created'));
		fill('Admin id', me.adminId);
		fill('From (UTC day)', '2026-01-01');
		await press('Filter');
		cleanup();

		// ---------------------------------------------------------------- Settings: e-mail sending, branding, support, security
		render(
			<ToastProvider>
				<SettingsView {...await admin.loadSettings(ownerBrowser.api)} />
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
		// one page: every section is a card with its own Save
		expect(document.querySelector('[role="tablist"]')).toBeNull();
		await saveIn('E-mail sending');
		await until(() => ownerBrowser.calls.some((c) => c.path === adminApi.settingsMail() && c.status === 200));
		await until(() => shows('Send test e-mail'));
		await press('Send test e-mail');
		await until(() => ownerBrowser.calls.some((c) => c.path === adminApi.settingsMailTest()));
		await press('Turn e-mail sending off');
		await until(() => ownerBrowser.calls.filter((c) => c.path === adminApi.settingsMail() && c.status === 200).length >= 2);
		fill('Name', 'Acme Portal');
		await saveIn('Branding');
		await until(() => ownerBrowser.calls.some((c) => c.path === adminApi.settingsBranding() && c.status === 200));
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
		await until(() => ownerBrowser.calls.some((c) => c.path === adminApi.settingsLogo() && c.status === 200));
		await until(() => shows('Remove logo'));
		await press('Remove logo');
		await until(() => ownerBrowser.calls.some((c) => c.method === 'DELETE' && c.path === adminApi.settingsLogo()));
		fill('E-mail', 'help@acme.test');
		fill('Phone', '+92 300 1234567');
		await saveIn('Support contact');
		await until(() => ownerBrowser.calls.some((c) => c.path === adminApi.settingsSupport() && c.status === 200));
		fill('Session length (hours)', '0');
		await saveIn('Security');
		await until(() => ownerBrowser.calls.some((c) => c.path === adminApi.settingsSecurity() && c.status === 422));
		fill('Session length (hours)', '24');
		await act(async () => {
			/** @type {HTMLElement} */ (document.querySelector('[role="switch"]')).click();
		});
		await saveIn('Security');
		await until(() => ownerBrowser.calls.some((c) => c.path === adminApi.settingsSecurity() && c.status === 200));
		cleanup();
		render(<SettingsView ok={false} problem={{ status: 403, title: 'Forbidden' }} />);
		expect(shows('Not permitted')).toBe(true);
		cleanup();
		// back to no two-step requirement for the rest of the flow
		await ownerBrowser.api.request('PUT', adminApi.settingsSecurity(), { sessionHours: 24, requireTwoStepForAdmins: false });

		// ---------------------------------------------------------------- Admins
		render(
			<ToastProvider>
				<AdminsView {...await admin.loadAdmins(ownerBrowser.api, me)} />
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
		const invited = /** @type {any} */ (
			await until(
				() =>
					shows('help@ss.test') &&
					ownerBrowser.calls.find((c) => c.method === 'POST' && c.path === adminApi.admins() && c.status === 201)?.body,
			)
		);
		cleanup();
		// the invited admin selected: the actions sit on its detail
		render(
			<ToastProvider>
				<AdminsView {...await admin.loadAdmins(ownerBrowser.api, me)} selectedId={invited.admin.adminId} />
			</ToastProvider>,
		);
		await press('Copy invite link');
		await until(() => shows('Copy this link now.'));
		await act(async () => {
			/** @type {HTMLButtonElement} */ (document.querySelector('[role="dialog"] button[aria-label="Close"]'))?.click();
		});
		await press('Resend invite');
		await choose('Correct invite e-mail');
		fillDialog('E-mail', 'helpdesk@ss.test');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Correct invite e-mail')
			).click();
		});
		await until(() => shows('helpdesk@ss.test'));
		await choose('Change role');
		await act(async () => {
			type(byLabel(/** @type {HTMLElement} */ (document.querySelector('[role="dialog"]')), 'Role'), 'finance');
		});
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Change role')
			).click();
		});
		await until(() =>
			ownerBrowser.calls.some((c) => c.method === 'PATCH' && c.path.startsWith('/v1/admin/admins/') && c.status === 200),
		);
		await settle(2);
		await choose('Remove');
		await act(async () => {
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Remove')
			).click();
		});
		await until(() =>
			ownerBrowser.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/v1/admin/admins/') && c.status === 204),
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
				</div>
			);
		}
		render(<Probe />);
		await press('reload');
		await until(() => shows('problem'));
		cleanup();
		const anonymous = browserOf(portal);
		vi.stubGlobal('fetch', anonymous.fetch);
		expect((await adminFetch(adminApi.merchants())).status).toBe(401);
		adminSignInAgain('/admin/x');
		ownerBrowser.use();
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
		await until(() => ownerBrowser.calls.some((c) => c.path === adminApi.signOut() && c.status === 204));
		expect((await admin.loadAdminSession(ownerBrowser.api)).ok).toBe(false);
		errors.mockRestore();
		vi.unstubAllGlobals();
	});
});
