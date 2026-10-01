// @vitest-environment jsdom
/**
 * Merchant Console in the browser (jsdom), part 1 — account pages, websites, team and the frame: the views are
 * rendered client-side against a live in-process Portal (`fetch` routed to `portal.handle` with a cookie jar) and
 * driven through their forms and dialogs: sign-up, e-mail verification, sign-in with the MFA challenge, password
 * reset, invite acceptance, onboarding, websites add/delete with typed confirmation, team invite/role/remove,
 * account rename/password/MFA enrol/recovery codes/disable/sessions, merchant and website switchers, sign-out and
 * the impersonation banner.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as hooks from 'next/dist/shared/lib/hooks-client-context.shared-runtime.js';
import { ToastProvider } from '@ss/ui';
import { totpCode } from '../../src/infra/auth.js';
import { closeMongoClients } from '../../src/infra/db.js';
import * as loaders from '../../src/console/loaders.js';
import { apiFetch, signInAgain, takeFragmentToken, useAction, useResource } from '../../src/console/client.js';
import { AccountView, secondFactor } from '../../src/console/views/account.js';
import {
	AcceptInviteView,
	ForgotPasswordView,
	LoginView,
	ResetPasswordView,
	SignupView,
	VerifyEmailView,
} from '../../src/console/views/auth.js';
import { ConsoleShell } from '../../src/console/views/shell.js';
import { TeamView } from '../../src/console/views/team.js';
import { OnboardingView, WebsiteOverviewView, WebsitesView } from '../../src/console/views/websites.js';
import { act, byLabel, cleanup, render, type } from '../../../packages/ui/test/dom.js';
import { startMongo } from '../helpers.js';
import {
	browserOf,
	button,
	buttons,
	check,
	clickEl,
	createWorld,
	dialog,
	fill,
	fillDialog,
	press,
	pressDialog,
	quiet,
	settle,
	shows,
	until,
} from './merchant-harness.js';

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

describe('merchant console interactions (jsdom): account, websites, team', () => {
	it('drives the account pages, websites, team and frame against a live Portal', async () => {
		const restore = quiet();
		const world = await createWorld({ db: mongo.db('merchant_ui_1') });
		const { portal, tokenOf } = world;
		const PASSWORD = 'correct horse battery';

		// ---------------------------------------------------------------- sign up, verify, sign in (browser A)
		const a = browserOf(portal);
		a.use();
		render(<SignupView />);
		await press('Create account');
		expect(shows('Enter the name of your business.')).toBe(true);
		expect(shows('Enter your e-mail address.')).toBe(true);
		expect(shows('Use at least 12 characters.')).toBe(true);
		fill('Business name', 'Shop & Co');
		fill('Your name', 'Olive Owner');
		fill('E-mail', 'owner@shop.test');
		fill('Password', PASSWORD);
		await press('Create account');
		await until(() => shows('Verification link sent'));
		await press('Change it');
		expect(shows('Create your account')).toBe(true);
		cleanup();
		// a server-side validation problem is mapped to the fields
		render(<SignupView />);
		fill('Business name', 'x'.repeat(400));
		fill('E-mail', 'second@shop.test');
		fill('Password', PASSWORD);
		await press('Create account');
		await a.waitCall('POST', '/v1/auth/merchant/signup', (s) => s >= 400);
		cleanup();

		setToken('');
		render(<VerifyEmailView />);
		await until(() => shows('This link is incomplete'));
		cleanup();
		setToken('not-a-real-token');
		render(<VerifyEmailView />);
		await until(() => shows('We could not verify your e-mail'));
		cleanup();
		setToken(tokenOf('owner@shop.test', 'verify_email'));
		render(<VerifyEmailView />);
		await until(() => shows('Verified — opening your console'));
		expect(window.location.hash).toBe('');
		cleanup();
		// verification signs the browser in; start from a fresh browser to sign in by hand
		await a.api.post('/v1/auth/merchant/logout');

		render(<LoginView next="/credits" expired />);
		expect(shows('Your session ended.')).toBe(true);
		await press('Sign in');
		expect(shows('Enter your e-mail address.') && shows('Enter your password.')).toBe(true);
		fill('E-mail', 'owner@shop.test');
		fill('Password', 'wrong password!!');
		await press('Sign in');
		await a.waitCall('POST', '/v1/auth/merchant/login', (s) => s >= 400);
		fill('Password', PASSWORD);
		await press('Sign in');
		await a.waitCall('POST', '/v1/auth/merchant/login', (s) => s === 200);
		cleanup();
		render(<LoginView reset />);
		expect(shows('Your password was changed.')).toBe(true);
		cleanup();
		const session = await loaders.loadSession(a.api);
		if (!session.ok) throw new Error('session');
		const merchantId = /** @type {string} */ (session.merchantId);

		// ---------------------------------------------------------------- onboarding and websites
		render(<WebsitesView {...await loaders.loadWebsites(a.api, merchantId)} />);
		expect(shows('Add your first website')).toBe(true);
		cleanup();
		render(<OnboardingView {...await loaders.loadOnboarding(a.api, merchantId, undefined)} />);
		await press('Add website');
		expect(shows('Enter the domain of your website')).toBe(true);
		fill('Domain', 'not a domain');
		await press('Add website');
		await a.waitCall('POST', `/v1/merchants/${merchantId}/websites`, (s) => s >= 400);
		fill('Domain', 'shop.example.com');
		await press('Add website');
		const added = await a.waitCall('POST', `/v1/merchants/${merchantId}/websites`, (s) => s === 201 || s === 200);
		const websiteId = added.body.website.websiteId;
		const twinId = added.body.twin.websiteId;
		cleanup();
		render(<OnboardingView {...await loaders.loadOnboarding(a.api, merchantId, websiteId)} />);
		expect(shows('Connect resources for shop.example.com')).toBe(true);
		cleanup();
		render(<OnboardingView {...await loaders.loadOnboarding(a.api, merchantId, undefined)} />);
		expect(shows('You already have websites.')).toBe(true);
		cleanup();

		withToasts(<WebsitesView {...await loaders.loadWebsites(a.api, merchantId)} />);
		expect(shows('shop.example.com')).toBe(true);
		await press('Add website');
		fillDialog('Domain', 'blog.example.com');
		await pressDialog('Add website');
		await until(() => a.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/websites') && c.status < 300).length >= 2);
		cleanup();
		withToasts(<WebsitesView {...await loaders.loadWebsites(a.api, merchantId)} />);
		await press('Delete blog.example.com');
		await pressDialog('Delete website');
		expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('Type blog.example.com to confirm.');
		fillDialog('Type blog.example.com to confirm', 'blog.example.com');
		await pressDialog('Delete website');
		await until(() => shows('blog.example.com deleted'));
		await until(() => !shows('Delete blog.example.com') && buttons('Delete blog.example.com').length === 0);
		// a delete the server refuses (already gone) shows its problem
		await press('Delete shop.example.com');
		await pressDialog('Cancel');
		cleanup();
		const blog = a.calls.find((c) => c.method === 'POST' && c.body?.website?.domain === 'blog.example.com');
		const stale = await loaders.loadWebsites(a.api, merchantId);
		if (!stale.ok) throw new Error('websites');
		withToasts(<WebsitesView {...stale} websites={[...stale.websites, { ...blog?.body.website, status: 'active' }]} />);
		await press('Delete blog.example.com');
		fillDialog('Type blog.example.com to confirm', 'blog.example.com');
		await pressDialog('Delete website');
		await a.waitCall(
			'DELETE',
			(p) => p.endsWith(blog?.body.website.websiteId),
			(s) => s >= 400,
		);
		expect(dialog().textContent).toMatch(/./);
		cleanup();

		render(<WebsiteOverviewView {...await loaders.loadWebsiteOverview(a.api, merchantId, twinId)} />);
		expect(shows('test twin')).toBe(true);
		cleanup();

		// ---------------------------------------------------------------- team: invite, accept, edit, remove, revoke
		const me1 = (await loaders.loadSession(a.api)).ok ? /** @type {any} */ (await loaders.loadSession(a.api)).me : null;
		withToasts(<TeamView {...await loaders.loadTeam(a.api, merchantId, me1)} />);
		await press('Invite');
		fillDialog('E-mail', 'nope');
		await pressDialog('Send invitation');
		expect(shows('Enter an e-mail address.')).toBe(true);
		fillDialog('E-mail', 'dev@shop.test');
		await check('Editor — element settings and content', dialog());
		await pressDialog('Send invitation');
		expect(shows('Give at least one role.')).toBe(true);
		await check('Only some websites', dialog());
		await check('Developer', dialog());
		await pressDialog('Send invitation');
		await until(() => shows('Invitation sent to dev@shop.test'));
		await until(() => shows('dev@shop.test'));
		// an invitation the server refuses (role outside the list) maps its problem
		await press('Invite');
		fillDialog('E-mail', 'x'.repeat(300) + '@shop.test');
		await pressDialog('Send invitation');
		await until(() => a.calls.some((c) => c.path.endsWith('/team/invites') && c.status >= 400));
		await pressDialog('Cancel');
		// another pending invitation, revoked
		await press('Invite');
		fillDialog('E-mail', 'temp@shop.test');
		await pressDialog('Send invitation');
		await until(() => shows('temp@shop.test'));
		const tempRow = /** @type {HTMLElement} */ (
			[...document.querySelectorAll('li')].find((li) => li.textContent?.includes('temp@shop.test'))
		);
		await clickEl(button('Revoke', tempRow));
		await pressDialog('Revoke invitation');
		await until(() => a.calls.some((c) => c.method === 'DELETE' && c.path.includes('/team/invites/')));
		cleanup();

		// the invitee accepts (new account)
		const c = browserOf(portal);
		c.use();
		setToken('');
		render(<AcceptInviteView />);
		await until(() => shows('This invitation link is incomplete'));
		cleanup();
		setToken(tokenOf('dev@shop.test', 'invite'));
		render(<AcceptInviteView />);
		await until(() => shows('Accept invitation'));
		await press('Accept invitation');
		expect(shows('Enter a password')).toBe(true);
		fill('Your name', 'Dev');
		fill('Password', 'short');
		await press('Accept invitation');
		await c.waitCall('POST', '/v1/auth/invites/accept', (s) => s >= 400);
		fill('Password', 'developer password 1');
		await press('Accept invitation');
		await c.waitCall('POST', '/v1/auth/invites/accept', (s) => s === 200);
		cleanup();

		a.use();
		withToasts(<TeamView {...await loaders.loadTeam(a.api, merchantId, me1)} />);
		expect(shows('Website roles')).toBe(true);
		await press('Edit');
		expect(/** @type {HTMLInputElement} */ (byLabel(dialog(), 'Only some websites')).checked).toBe(true);
		await check('All websites', dialog());
		await check('Billing — credits, statements, spend policies', dialog());
		await pressDialog('Save');
		await until(() => shows('Access updated'));
		await press('Remove');
		await pressDialog('Remove member');
		await until(() => shows('Member removed'));
		cleanup();
		// a member without manage rights sees no actions; failures of the page render a problem
		render(<TeamView ok={false} problem={{ status: 403, title: 'Forbidden', code: 'forbidden' }} />);
		expect(shows('No access')).toBe(true);
		cleanup();

		// ---------------------------------------------------------------- account: rename, password, MFA
		withToasts(<AccountView {...await loaders.loadAccount(a.api, merchantId)} />);
		expect(shows('Two-factor authentication')).toBe(true);
		fill('Organisation name', 'Shop & Co Ltd');
		await press('Rename');
		await until(() => shows('Organisation renamed'));
		await press('Change password');
		expect(shows('Enter your current password.')).toBe(true);
		fill('Current password', 'not my password');
		fill('New password', 'brand new password 1');
		fill('Repeat the new password', 'brand new password 1');
		await press('Change password');
		await a.waitCall('POST', '/v1/me/password', (s) => s >= 400);
		await press('Set up two-factor authentication');
		const enrol = await a.waitCall('POST', '/v1/me/mfa/enrol', (s) => s === 200);
		const secret = String(enrol.body.secret);
		fillDialog('Code from the app', '12');
		await pressDialog('Turn on');
		expect(shows('Enter the 6-digit code from your app.')).toBe(true);
		fillDialog('Code from the app', '000000');
		await pressDialog('Turn on');
		await a.waitCall('POST', '/v1/me/mfa/confirm', (s) => s >= 400);
		fillDialog('Code from the app', totpCode(secret, Date.now()));
		await pressDialog('Turn on');
		const confirmed = await a.waitCall('POST', '/v1/me/mfa/confirm', (s) => s === 200);
		let codes = /** @type {string[]} */ (confirmed.body.recoveryCodes);
		await until(() => shows('Your recovery codes'));
		await act(async () => {
			/** @type {HTMLButtonElement} */ (button('Copy', dialog())).click();
		});
		await pressDialog('I have saved them');
		await until(() => shows('recovery codes left'));
		await press('New recovery codes');
		await pressDialog('Generate');
		expect(shows('Enter a current code (or a recovery code).')).toBe(true);
		fillDialog('Code or recovery code', 'zzzzz-zzzzz');
		await pressDialog('Generate');
		await a.waitCall('POST', '/v1/me/mfa/recovery-codes', (s) => s >= 400);
		fillDialog('Code or recovery code', String(codes[0]));
		await pressDialog('Generate');
		const regenerated = await a.waitCall('POST', '/v1/me/mfa/recovery-codes', (s) => s === 200);
		codes = regenerated.body.recoveryCodes;
		await until(() => shows('Your recovery codes'));
		await pressDialog('I have saved them');
		cleanup();

		// ---------------------------------------------------------------- sign in with the MFA challenge (browser B)
		const b = browserOf(portal);
		b.use();
		render(<LoginView />);
		fill('E-mail', 'owner@shop.test');
		fill('Password', PASSWORD);
		await press('Sign in');
		await until(() => shows('Authentication code'));
		await press('Verify');
		expect(shows('Enter the 6-digit code from your app.')).toBe(true);
		fill('Authentication code', '000000');
		await press('Verify');
		await b.waitCall('POST', '/v1/auth/merchant/login/mfa', (s) => s >= 400);
		await press('Use a recovery code instead');
		fill('Recovery code', 'nope');
		await press('Verify');
		expect(shows('Enter a recovery code like abcde-fghij.')).toBe(true);
		fill('Recovery code', String(codes[0]));
		await press('Verify');
		await b.waitCall('POST', '/v1/auth/merchant/login/mfa', (s) => s === 200);
		cleanup();

		// another organisation invites the owner: accepting with MFA goes through the challenge
		const other = await world.signup('other@else.test', 'Else Ltd');
		await other.b.api.post(`/v1/merchants/${other.merchantId}/team/invites`, {
			email: 'owner@shop.test',
			roles: ['admin'],
		});
		setToken(tokenOf('owner@shop.test', 'invite'));
		render(<AcceptInviteView />);
		await until(() => shows('Accept invitation'));
		fill('Password', PASSWORD);
		await press('Accept invitation');
		await until(() => shows('Two-factor verification'));
		await press('Use a recovery code instead');
		fill('Recovery code', String(codes[1]));
		await press('Verify');
		await b.waitCall('POST', '/v1/auth/merchant/login/mfa', (s) => s === 200);
		cleanup();

		// ---------------------------------------------------------------- the frame: switchers, banner, sign out
		const me2 = /** @type {any} */ (await loaders.loadSession(b.api));
		expect(me2.me.memberships.length).toBe(2);
		const frame = await loaders.loadFrame(a.api, merchantId);
		const low = { balanceMillicredits: 5000, burnRatePerHour: 1000, hoursRemaining: 5, subscriptions: [] };
		render(
			<PathnameContext.Provider value={`/websites/${twinId}/keys`}>
				<ConsoleShell
					me={me2.me}
					merchantId={me2.merchantId}
					websites={frame.websites}
					meter={low}
					impersonation={{ staffId: 'stf_1', staffName: 'Help', expiresAt: new Date(Date.now() + 60_000).toISOString() }}>
					<p>child</p>
				</ConsoleShell>
			</PathnameContext.Provider>,
		);
		expect(shows('child') && shows('of credits left')).toBe(true);
		expect(shows('shop.example.com · test')).toBe(true);
		const [orgSelect, siteSelect] = /** @type {HTMLSelectElement[]} */ ([...document.querySelectorAll('select')]);
		type(/** @type {HTMLSelectElement} */ (siteSelect), '');
		type(/** @type {HTMLSelectElement} */ (siteSelect), websiteId);
		const target = me2.me.memberships.find((/** @type {any} */ m) => m.merchantId !== me2.merchantId).merchantId;
		type(/** @type {HTMLSelectElement} */ (orgSelect), target);
		await b.waitCall('POST', '/v1/me/merchant', (s) => s === 200);
		await press('End impersonation');
		await b.waitCall('POST', '/v1/auth/merchant/logout');
		cleanup();
		render(
			<PathnameContext.Provider value="/websites">
				<ConsoleShell
					me={me1}
					merchantId={merchantId}
					websites={frame.websites}
					meter={{ balanceMillicredits: 0, burnRatePerHour: 1000, subscriptions: [{}] }}>
					<p>x</p>
				</ConsoleShell>
			</PathnameContext.Provider>,
		);
		expect(shows('Your credit balance is empty')).toBe(true);
		await clickEl(
			/** @type {HTMLButtonElement} */ (
				[...document.querySelectorAll('button')].find((x) => x.textContent?.includes('Sign out'))
			),
		);
		cleanup();

		// ---------------------------------------------------------------- account: sessions, MFA off, password
		const d = browserOf(portal);
		d.use();
		await d.api.post('/v1/auth/merchant/login', { email: 'owner@shop.test', password: PASSWORD }).then(async (r) => {
			if (r.ok && r.data?.status === 'mfa_required')
				await d.api.post('/v1/auth/merchant/login/mfa', { challenge: r.data.challenge, recoveryCode: codes[2] });
		});
		// a second session of the same user (browser E) to revoke
		const e = browserOf(portal);
		const login = await e.api.post('/v1/auth/merchant/login', { email: 'owner@shop.test', password: PASSWORD });
		if (login.ok && login.data?.status === 'mfa_required')
			await e.api.post('/v1/auth/merchant/login/mfa', { challenge: login.data.challenge, recoveryCode: codes[3] });
		const account = await loaders.loadAccount(d.api, merchantId);
		withToasts(<AccountView {...account} />);
		await until(() => shows('This device'));
		const otherRow = /** @type {HTMLTableRowElement} */ (
			[...document.querySelectorAll('tbody tr')].find((tr) => !tr.textContent?.includes('This device'))
		);
		await clickEl(button('Sign out', otherRow));
		await pressDialog('Sign out');
		await until(() => shows('Session signed out'));
		await press('Turn off');
		await pressDialog('Turn off');
		expect(shows('Enter your password and a code')).toBe(true);
		fillDialog('Password', 'wrong password!!');
		fillDialog('Code or recovery code', String(codes[4]));
		await pressDialog('Turn off');
		await d.waitCall('POST', '/v1/me/mfa/disable', (s) => s >= 400);
		fillDialog('Password', PASSWORD);
		fillDialog('Code or recovery code', String(codes[5]));
		await pressDialog('Turn off');
		await until(() => shows('Two-factor authentication turned off'));
		fill('Current password', PASSWORD);
		fill('New password', 'brand new password 1');
		fill('Repeat the new password', 'brand new password 2');
		await press('Change password');
		expect(shows('The passwords do not match.')).toBe(true);
		fill('Repeat the new password', 'brand new password 1');
		await press('Change password');
		await until(() => shows('Password changed'));
		const currentRow = /** @type {HTMLTableRowElement} */ (
			[...document.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('This device'))
		);
		await clickEl(button('Sign out', currentRow));
		await d.waitCall('POST', '/v1/auth/merchant/logout');
		cleanup();
		render(<AccountView ok={false} problem={{ status: 401, title: 'Unauthorized', code: 'unauthorized' }} />);
		expect(shows('Sign in')).toBe(true);
		cleanup();

		// ---------------------------------------------------------------- forgot / reset password
		const f = browserOf(portal);
		f.use();
		render(<ForgotPasswordView />);
		await press('Send reset link');
		expect(shows('Enter your e-mail address.')).toBe(true);
		fill('E-mail', 'owner@shop.test');
		await press('Send reset link');
		await until(() => shows('If an account exists for owner@shop.test'));
		cleanup();
		setToken('');
		render(<ResetPasswordView />);
		await until(() => shows('This link is incomplete'));
		cleanup();
		setToken('bogus-token');
		render(<ResetPasswordView />);
		await until(() => shows('Choose a new password'));
		fill('New password', 'another password 12');
		fill('Repeat the password', 'another password 12');
		await press('Save password');
		await f.waitCall('POST', '/v1/auth/merchant/password-reset/confirm', (s) => s >= 400);
		cleanup();
		setToken(tokenOf('owner@shop.test', 'password_reset'));
		render(<ResetPasswordView />);
		await until(() => shows('New password'));
		fill('New password', 'short');
		await press('Save password');
		expect(shows('Use at least 12 characters.') && shows('The passwords do not match.')).toBe(true);
		fill('New password', 'another password 12');
		fill('Repeat the password', 'another password 12');
		await press('Save password');
		await f.waitCall('POST', '/v1/auth/merchant/password-reset/confirm', (s) => s < 300);
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
		expect(secondFactor('123456')).toEqual({ code: '123456' });
		expect(secondFactor('abcde-fghij')).toEqual({ recoveryCode: 'abcde-fghij' });
		expect(secondFactor('x')).toBeNull();
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
