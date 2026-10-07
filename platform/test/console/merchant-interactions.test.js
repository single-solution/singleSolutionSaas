// @vitest-environment jsdom
/**
 * Merchant Console in the browser (jsdom), part 1 — the public account pages, Account, websites and the frame: the
 * views are rendered client-side against a live in-process Portal (`fetch` routed to `portal.handle` with a cookie jar)
 * and driven through their forms and dialogs: the one sign-in page (with two-step, Create admin and the suspended
 * message), Forgot password, reset and setup links, the e-mail confirmation, Account (details, sign-in e-mail,
 * password, two-step with a QR code and recovery codes), the welcome, the website's install code, the frame and the
 * client helpers.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as hooks from 'next/dist/shared/lib/hooks-client-context.shared-runtime.js';
import { ToastProvider } from '@ss/ui';
import { totpCode } from '../../src/infra/auth.js';
import { closeMongoClients } from '../../src/infra/db.js';
import * as loaders from '../../src/console/loaders.js';
import { apiFetch, signInAgain, takeFragmentToken, useAction, useResource } from '../../src/console/client.js';
import { AccountView } from '../../src/console/views/account.js';
import { QrCode } from '../../src/console/views/login-settings.js';
import {
	ConfirmEmailView,
	ForgotPasswordView,
	ResetPasswordView,
	SetPasswordView,
	SignInView,
} from '../../src/console/views/sign-in.js';
import { ConsoleShell } from '../../src/console/views/shell.js';
import { InstallCodeCard, WebsiteOverviewView, WebsitesView } from '../../src/console/views/websites.js';
import { act, byLabel, cleanup, render, type } from '@ss/ui/testing';
import { startMongo } from '../helpers.js';
import { browserOf, button, clickEl, createWorld, fill, press, quiet, settle, shows, until } from './merchant-harness.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const PathnameContext = /** @type {import('react').Context<string | null>} */ (
	/** @type {any} */ (hooks).PathnameContext ?? /** @type {any} */ (hooks).default.PathnameContext
);

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
	vi.unstubAllGlobals();
});

/** @param {import('react').ReactNode} node */
const withToasts = (node) => render(<ToastProvider durationMs={600_000}>{node}</ToastProvider>);

/** @param {string} token */
const setToken = (token) => {
	window.location.hash = token ? `#token=${encodeURIComponent(token)}` : '';
};

const PASSWORD = 'correct horse battery';
const BRANDING = {
	name: 'Single Solution',
	accent: '#4f46e5',
	logoUrl: null,
	support: { email: 'help@ss.test', phone: '+92 300 1234567', whatsapp: null },
};

/** Two-step code of a secret now. @param {string} secret */
const code = (secret) => totpCode(secret, Date.now());

describe('merchant console interactions (jsdom): sign-in, Account, websites, frame', () => {
	it('drives the public pages, Account, websites and the frame against a live Portal', async () => {
		const restore = quiet();
		const db = mongo.db('merchant_ui_1');
		// ---------------------------------------------------------------- Create admin while no admin exists
		{
			const { createPortal } = await import('../../src/portal.js');
			const { modules } = await import('../../src/modules/index.js');
			const { testConfig, createTestLogger } = await import('../helpers.js');
			const empty = createPortal({
				config: await testConfig(),
				db: mongo.db('merchant_ui_1_first'),
				modules,
				logger: createTestLogger().logger,
			});
			const first = browserOf(empty);
			first.use();
			render(<SignInView branding={BRANDING} firstAdmin />);
			expect(shows('No admin exists yet.')).toBe(true);
			await press('Create admin');
			expect(shows('Enter your name.') && shows('Enter an e-mail address.')).toBe(true);
			fill('Your name', 'Ada');
			fill('E-mail', 'ada@portal.test');
			fill('Password', 'short');
			await press('Create admin');
			expect(shows('Use at least 12 characters.')).toBe(true);
			fill('Password', PASSWORD);
			await press('Create admin');
			await first.waitCall('POST', '/v1/auth/first-admin', (st) => st === 201);
			cleanup();
		}

		const world = await createWorld({ db });
		const { portal } = world;
		const { merchantId } = await world.signup('owner@shop.test', 'Shop & Co');

		// ---------------------------------------------------------------- the one sign-in page
		const a = browserOf(portal);
		a.use();
		render(<SignInView branding={BRANDING} firstAdmin={false} next="/credits" notice="expired" />);
		expect(shows('Your session ended. Sign in again.')).toBe(true);
		await press('Sign in');
		expect(shows('Enter an e-mail address.') && shows('Enter your password.')).toBe(true);
		fill('E-mail', 'owner@shop.test');
		fill('Password', 'wrong password!!');
		await press('Sign in');
		await a.waitCall('POST', '/v1/auth/sign-in', (st) => st === 401);
		expect(shows('The e-mail or password is incorrect.')).toBe(true);
		fill('Password', PASSWORD);
		await press('Sign in');
		await a.waitCall('POST', '/v1/auth/sign-in', (st) => st === 200);
		cleanup();
		for (const notice of /** @type {const} */ (['reset', 'email'])) {
			render(<SignInView branding={BRANDING} firstAdmin={false} notice={notice} />);
			expect(shows(notice === 'reset' ? 'Your password was changed.' : 'Your new sign-in e-mail is confirmed.')).toBe(true);
			cleanup();
		}

		// ---------------------------------------------------------------- Account: details, e-mail, password, two-step
		withToasts(<AccountView {...await loaders.loadAccount(a.api, merchantId)} />);
		expect(shows('Business details') && shows('Your activity')).toBe(true);
		fill('Phone', '+92 300 7654321');
		type(byLabel(document, 'Country'), 'PK');
		fill('Address', 'Mall Road, Lahore');
		await press('Save');
		await a.waitCall('PATCH', '/v1/me', (st) => st === 200);
		await until(() => shows('Business details saved.'));
		// the sign-in e-mail: a wrong password, then the confirmation link
		fill('New e-mail', 'owner2@shop.test');
		fill('Current password', 'wrong password!!');
		await press('Change e-mail');
		await a.waitCall('POST', '/v1/me/email', (st) => st === 401);
		const passwordFields = /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll('input[type="password"]')]);
		type(/** @type {HTMLInputElement} */ (passwordFields[0]), PASSWORD);
		await press('Change e-mail');
		await until(() => shows('We sent a confirmation link to owner2@shop.test.'));
		// the password: too short, then changed
		type(/** @type {HTMLInputElement} */ (passwordFields[1]), PASSWORD);
		fill('New password', 'short');
		await press('Change password');
		expect(shows('Use at least 12 characters.')).toBe(true);
		fill('New password', 'a brand new passphrase');
		await press('Change password');
		await until(() => shows('Password changed.'));
		// two-step: set up with the QR code, then save the recovery codes
		await press('Set up two-step sign-in');
		await press('Set up two-step sign-in');
		const started = await a.waitCall('POST', '/v1/me/two-step/start', (st) => st === 200);
		expect(document.querySelector('svg[aria-label="QR code"]')).not.toBeNull();
		fill('Confirm a code', '000000');
		await press('Turn it on');
		await a.waitCall('POST', '/v1/me/two-step/confirm', (st) => st >= 400);
		fill('Confirm a code', code(started.body.secret));
		await press('Turn it on');
		const confirmed = await a.waitCall('POST', '/v1/me/two-step/confirm', (st) => st === 200);
		const recoveryCodes = /** @type {string[]} */ (confirmed.body.recoveryCodes);
		expect(shows('Save your recovery codes now')).toBe(true);
		expect(button('Done').disabled).toBe(true);
		await clickEl(byLabel(document, 'I have stored the recovery codes safely'));
		await press('Done');
		cleanup();
		withToasts(<AccountView {...await loaders.loadAccount(a.api, merchantId)} />);
		expect(shows('10 recovery codes left')).toBe(true);
		await press('Make new recovery codes');
		const codesForm = /** @type {HTMLElement} */ (document.querySelector('form[aria-label="Make new recovery codes"]'));
		type(byLabel(codesForm, 'Current password'), 'a brand new passphrase');
		type(byLabel(codesForm, 'Two-step or recovery code'), /** @type {string} */ (recoveryCodes[0]));
		await press('Make new recovery codes', codesForm);
		const fresh = await a.waitCall('POST', '/v1/me/two-step/recovery-codes', (st) => st === 200);
		await clickEl(byLabel(document, 'I have stored the recovery codes safely'));
		await press('Done');
		await press('Turn two-step off');
		await press('Cancel');
		await press('Turn two-step off');
		const offForm = /** @type {HTMLElement} */ (document.querySelector('form[aria-label="Turn two-step off"]'));
		type(byLabel(offForm, 'Current password'), 'a brand new passphrase');
		type(byLabel(offForm, 'Two-step or recovery code'), /** @type {string} */ (fresh.body.recoveryCodes[0]));
		await press('Turn two-step off', offForm);
		await a.waitCall('POST', '/v1/me/two-step/off', (st) => st === 200);
		cleanup();
		render(<AccountView ok={false} problem={{ status: 401, title: 'Unauthorized', code: 'unauthorized' }} />);
		cleanup();

		// ---------------------------------------------------------------- sign-in with two-step and a recovery code
		const b = browserOf(portal);
		await b.api.post('/v1/auth/sign-in', { email: 'owner@shop.test', password: 'a brand new passphrase' });
		const twoStep = await b.api.post('/v1/me/two-step/start');
		const secret = twoStep.ok ? twoStep.data.secret : '';
		await new Promise((resolve) => setTimeout(resolve, 1100));
		const on = await b.api.post('/v1/me/two-step/confirm', { code: code(secret) });
		const codes = on.ok ? on.data.recoveryCodes : [];
		const c = browserOf(portal);
		c.use();
		render(<SignInView branding={BRANDING} firstAdmin={false} />);
		fill('E-mail', 'owner@shop.test');
		fill('Password', 'a brand new passphrase');
		await press('Sign in');
		await until(() => shows('Two-step sign-in'));
		await press('Verify');
		expect(shows('Enter the 6-digit code from your app.')).toBe(true);
		fill('Code from the app', '000000');
		await press('Verify');
		await c.waitCall('POST', '/v1/auth/sign-in/two-step', (st) => st === 401);
		await press('Use a recovery code instead');
		fill('Recovery code', 'nope');
		await press('Verify');
		expect(shows('Enter a recovery code like abcde-fghij.')).toBe(true);
		fill('Recovery code', codes[0]);
		await press('Verify');
		await c.waitCall('POST', '/v1/auth/sign-in/two-step', (st) => st === 200);
		cleanup();

		// ---------------------------------------------------------------- a suspended merchant sees the support contact
		const suspended = await world.staff.api.post(`/v1/admin/merchants/${merchantId}/suspend`, { reason: 'check' });
		expect(suspended.ok).toBe(true);
		const d = browserOf(portal);
		d.use();
		render(<SignInView branding={BRANDING} firstAdmin={false} />);
		fill('E-mail', 'owner@shop.test');
		fill('Password', 'a brand new passphrase');
		await press('Sign in');
		await until(() => shows('Your account is suspended. Contact help@ss.test, +92 300 1234567.'));
		cleanup();
		await world.staff.api.post(`/v1/admin/merchants/${merchantId}/resume`, {});

		// ---------------------------------------------------------------- Forgot password, reset and setup links, e-mail confirmation
		const f = browserOf(portal);
		f.use();
		render(<ForgotPasswordView branding={BRANDING} />);
		fill('E-mail', 'not an e-mail');
		await press('Send the link');
		expect(shows('Enter an e-mail address.')).toBe(true);
		fill('E-mail', 'owner@shop.test');
		await press('Send the link');
		await until(() => shows('If this e-mail has a login, a link is on its way.'));
		cleanup();
		setToken('');
		render(<ResetPasswordView branding={BRANDING} />);
		await until(() => shows('This link is incomplete.'));
		cleanup();
		setToken(world.tokenOf('owner@shop.test', 'password_reset'));
		render(<ResetPasswordView branding={BRANDING} />);
		await until(() => shows('Choose a new password'));
		fill('New password', 'short');
		await press('Save the new password');
		expect(shows('Use at least 12 characters.')).toBe(true);
		fill('New password', 'yet another passphrase');
		await press('Save the new password');
		await f.waitCall('POST', '/v1/auth/reset-password', (st) => st === 204);
		cleanup();
		// setup link of a new merchant, and of an invited admin (who also enters a name)
		await world.staff.api.post('/v1/admin/merchants', { name: 'Beta', ownerName: 'Bea', email: 'bea@beta.test' });
		setToken(world.tokenOf('bea@beta.test', 'merchant_setup'));
		render(<SetPasswordView branding={BRANDING} />);
		await until(() => shows('Choose the password you will sign in with.'));
		fill('Password', PASSWORD);
		await press('Save and sign in');
		await f.waitCall('POST', '/v1/auth/set-password', (st) => st === 200);
		cleanup();
		await world.staff.api.post('/v1/admin/admins', { email: 'sue@portal.test', role: 'support' });
		setToken(world.tokenOf('sue@portal.test', 'admin_invite'));
		render(<SetPasswordView branding={BRANDING} />);
		await until(() => shows('Enter your name and choose the password'));
		fill('Password', PASSWORD);
		await press('Save and sign in');
		expect(shows('Enter your name.')).toBe(true);
		fill('Your name', 'Sue');
		await press('Save and sign in');
		await f.waitCall('POST', '/v1/auth/set-password', (st) => st === 200);
		cleanup();
		setToken('a'.repeat(43));
		render(<SetPasswordView branding={BRANDING} />);
		await until(() => shows('This link is invalid or has expired.'));
		cleanup();
		setToken('');
		render(<SetPasswordView branding={BRANDING} />);
		await until(() => shows('This link is incomplete.'));
		cleanup();
		setToken(world.tokenOf('owner2@shop.test', 'email_change_confirm'));
		render(<ConfirmEmailView branding={BRANDING} />);
		await f.waitCall('POST', '/v1/auth/confirm-email', (st) => st === 200);
		cleanup();
		setToken('a'.repeat(43));
		render(<ConfirmEmailView branding={BRANDING} />);
		await until(() => shows('This link is invalid or has expired.'));
		cleanup();
		setToken('');
		render(<ConfirmEmailView branding={BRANDING} />);
		await until(() => shows('This link is incomplete.'));
		cleanup();

		// ---------------------------------------------------------------- websites: the welcome, then the list and the install code
		const e = browserOf(portal);
		e.use();
		await e.api.post('/v1/auth/sign-in', { email: 'bea@beta.test', password: PASSWORD });
		const beta = /** @type {any} */ (await loaders.loadSession(e.api));
		render(<WebsitesView {...await loaders.loadWebsites(e.api, beta.merchantId)} branding={BRANDING} />);
		expect(shows('Your admin will add your websites and products.') && shows('help@ss.test')).toBe(true);
		cleanup();
		const site = await world.addWebsite(beta.merchantId, 'beta.example.com');
		render(<WebsitesView {...await loaders.loadWebsites(e.api, beta.merchantId)} branding={BRANDING} />);
		expect(shows('beta.example.com')).toBe(true);
		cleanup();
		const twinOverview = await loaders.loadWebsiteOverview(e.api, beta.merchantId, site.twin.websiteId);
		render(<WebsiteOverviewView {...twinOverview} />);
		expect(shows('test twin')).toBe(true);
		cleanup();
		render(<InstallCodeCard snippet={null} />);
		expect(shows('Your install code appears here once the website is loaded.')).toBe(true);
		cleanup();
		const tag = `<script src="https://portal.test/w/${site.twin.websiteId}/loader.js" crossorigin="anonymous" defer></script>`;
		const writeText = vi.fn(async () => undefined);
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		render(<InstallCodeCard snippet={{ alias: { tag } }} />);
		await press('Copy');
		expect(writeText).toHaveBeenCalledWith(tag);
		vi.unstubAllGlobals();
		e.use();
		cleanup();

		// ---------------------------------------------------------------- the frame: website switcher, banners, sign out
		const frame = await loaders.loadFrame(e.api, beta.merchantId);
		const low = { balanceMillicredits: 5000, burnRatePerHour: 1000, hoursRemaining: 5, subscriptions: [] };
		render(
			<PathnameContext.Provider value={`/websites/${site.twin.websiteId}/keys`}>
				<ConsoleShell
					me={beta.me}
					merchantId={beta.merchantId}
					websites={frame.websites}
					meter={low}
					branding={{ name: 'Acme', accent: '#112233' }}
					notifications={[
						{ kind: 'identity_issuer_request', websiteId: site.website.websiteId, domain: 'beta.example.com', request: {} },
					]}>
					<p>child</p>
				</ConsoleShell>
			</PathnameContext.Provider>,
		);
		expect(shows('child') && shows('of credits left') && shows('Acme')).toBe(true);
		expect(shows('beta.example.com · test')).toBe(true);
		const [siteSelect] = /** @type {HTMLSelectElement[]} */ ([...document.querySelectorAll('select')]);
		type(/** @type {HTMLSelectElement} */ (siteSelect), '');
		type(/** @type {HTMLSelectElement} */ (siteSelect), site.website.websiteId);
		await clickEl(
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('button')].find((x) => x.textContent?.includes('Sign out'))
			),
		);
		await e.waitCall('POST', '/v1/auth/sign-out');
		cleanup();
		render(
			<PathnameContext.Provider value="/websites">
				<ConsoleShell
					me={beta.me}
					merchantId={beta.merchantId}
					websites={frame.websites}
					meter={{ balanceMillicredits: 0, burnRatePerHour: 1000, subscriptions: [{}] }}>
					<p>x</p>
				</ConsoleShell>
			</PathnameContext.Provider>,
		);
		expect(shows('Your credit balance is empty')).toBe(true);
		cleanup();
		render(<QrCode text="otpauth://totp/x" size={64} />);
		expect(document.querySelector('svg')?.getAttribute('width')).toBe('64');
		cleanup();

		// ---------------------------------------------------------------- client helpers
		const anonymous = browserOf(portal);
		anonymous.use();
		expect((await apiFetch('/v1/me')).status).toBe(401);
		expect((await apiFetch('/v1/me', { redirectOn401: false })).ok).toBe(false);
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('offline');
		});
		expect(await apiFetch('/v1/me')).toMatchObject({ ok: false, status: 0 });
		vi.stubGlobal('fetch', async () => new Response('not json', { status: 200 }));
		expect(await apiFetch('/v1/me')).toMatchObject({ ok: true, data: null });
		vi.stubGlobal('fetch', async () => new Response('', { status: 500, statusText: 'Boom' }));
		expect(await apiFetch('/v1/x', { method: 'POST', body: {}, idempotencyKey: 'k1' })).toMatchObject({
			ok: false,
			problem: { title: 'Boom' },
		});
		signInAgain('/credits');
		signInAgain();
		setToken('abc');
		expect(takeFragmentToken()).toBe('abc');
		anonymous.use();
		function Probe() {
			const r = useResource('/v1/me', null);
			const none = useResource(null, 'initial');
			const action = useAction(() => apiFetch('/v1/me', { redirectOn401: false }));
			return (
				<div>
					<button type="button" onClick={() => void r.reload()}>
						reload
					</button>
					<button type="button" onClick={() => void none.reload()}>
						noop
					</button>
					<button type="button" onClick={() => void action.run()}>
						run
					</button>
					<button type="button" onClick={() => action.reset()}>
						reset
					</button>
					<span>{r.problem ? 'problem' : 'none'}</span>
					<span>{action.problem ? 'action-problem' : 'action-ok'}</span>
				</div>
			);
		}
		const probe = render(<Probe />);
		await press('noop');
		await press('reload');
		await until(() => shows('problem'));
		await press('run');
		await until(() => shows('action-problem'));
		await press('reset');
		await until(() => shows('action-ok'));
		// a reload that resolves after unmount is ignored
		await act(async () => {
			button('reload').click();
			probe.unmount();
		});
		await settle(2);
		restore();
	});
});
