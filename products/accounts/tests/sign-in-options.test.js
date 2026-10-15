/**
 * Sign-in options (PLAN 0.8.10): phone-code options (A7), per-role sign-in options (A6), imported two-step (A8),
 * sign-in events in the activity log (A10), profile options (A11) and sign-in from the merchant's server (A12).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../adapters/crypto.js';
import { ALL, ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

/** @param {string} email @param {string} [password] @param {Record<string, unknown>} [extra] */
const signIn = (email, password = 'correct horse battery', extra = {}) =>
	env.visitor('POST', '/v1/sign-in/password', { email, password, ...extra });
/** @param {string} email @param {Record<string, unknown>} [extra] */
const signUp = (email, extra = {}) =>
	env.visitor('POST', '/v1/sign-up/password', { email, password: 'correct horse battery', name: 'Uma User', ...extra });
/** @param {string} phone */
const askCode = (phone) => env.visitor('POST', '/v1/sign-in/phone/code', { phone });
/** The server's view of a user. @param {string} id */
const userOf = async (id) => (await env.serverCall('GET', `/v1/users/${id}`)).json;
/** Accounts' own activity log. @param {string} query */
const activity = async (query) => (await env.serverCall('GET', `/v1/activity?${query}`)).json.items;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => !['terms', 'approval', 'two_step', 'risk_checks'].includes(key)));
	await env.connectDatabase();
	await env.paste('notifications');
});
afterAll(async () => {
	await env.product.close();
});

describe('A7: phone-code options', () => {
	it('waits between codes, caps codes per number and per website, and keeps to the allowed countries', async () => {
		await env.setting('phone', 'cooldownSeconds', 60);
		expect((await askCode('+447700900001')).status).toBe(202);
		env.advance(30_000);
		const soon = await askCode('+447700900001');
		expect(code(soon)).toBe('code_cooldown');
		expect(Date.parse(soon.json.retryAt) - env.now()).toBe(30_000);
		env.advance(30_000);
		expect((await askCode('+447700900001')).status).toBe(202);
		await env.setting('phone', 'perHour', 2);
		env.advance(60_000);
		expect(code(await askCode('+447700900001'))).toBe('code_limit');
		await env.setting('phone', 'websitePerHour', 3);
		env.advance(3_600_000);
		expect((await askCode('+447700900002')).status).toBe(202);
		expect((await askCode('+447700900003')).status).toBe(202);
		expect((await askCode('+447700900004')).status).toBe(202);
		expect(code(await askCode('+447700900005'))).toBe('code_limit');
		await env.setting('phone', 'websitePerHour', 0);
		await env.setting('phone_code', 'countries', ['GB']);
		expect(code(await askCode('+14155550100'))).toBe('country_not_allowed');
		expect((await askCode('+447700900006')).status).toBe(202);
		await env.setting('phone_code', 'countries', []);
	});

	it('a code lasts the website’s codeMinutes, and the message says so', async () => {
		await env.setting('phone', 'codeMinutes', 5);
		env.advance(3_600_000);
		const asked = await askCode('+447700900007');
		expect(Date.parse(asked.json.expiresAt) - env.now()).toBe(5 * 60_000);
		const sent = env.messages().at(-1);
		expect(sent.values.minutes).toBe(5);
		env.advance(5 * 60_000 + 1000);
		expect(code(await env.visitor('POST', '/v1/sign-in/phone', { phone: '+447700900007', code: sent.values.code }))).toBe(
			'code_invalid',
		);
		await env.setting('phone', 'codeMinutes', 10);
	});

	it('names new phone-code users with the website’s template', async () => {
		await env.setting('phone_code', 'newUserName', 'Customer {last4}');
		env.advance(3_600_000);
		await askCode('+447700900876');
		const sent = env.messages().at(-1);
		const named = await env.visitor('POST', '/v1/sign-in/phone', { phone: '+447700900876', code: sent.values.code });
		expect(named.json.user.name).toBe('Customer 0876');
		await askCode('+447700900877');
		const own = await env.visitor('POST', '/v1/sign-in/phone', {
			phone: '+447700900877',
			code: env.messages().at(-1).values.code,
			name: 'Own Name',
		});
		expect(own.json.user.name).toBe('Own Name');
	});

	it('reads a phone typed any usual way as one number, with the business.json country’s calling code (K-7, SA-3)', async () => {
		env.advance(3_600_000);
		// no calling code set and no country: a national number is refused
		expect(code(await askCode('07700 900008'))).toBe('validation_failed');
		env.responders.set(`${ORIGIN}/.well-known/business.json`, () => ({
			status: 200,
			body: { name: 'shop.example.com', country: 'GB' },
		}));
		await env.refreshBusiness();
		expect((await askCode('07700 900008')).status).toBe(202);
		const sent = env.messages().at(-1);
		expect(sent.to).toMatchObject({ phone: '+447700900008' });
		// the same number typed other ways waits for the cooldown
		for (const typed of ['447700900008', '+44 07700 900008']) expect(code(await askCode(typed))).toBe('code_cooldown');
		const signedIn = await env.visitor('POST', '/v1/sign-in/phone', { phone: '+44 (0)7700-900008', code: sent.values.code });
		expect(signedIn.json.user.phone).toBe('+447700900008');
		// the website's own calling code comes first: the same digits read as a US number, not a UK one
		await env.setting('phone', 'defaultCallingCode', '+1');
		expect((await askCode('202 555 0143')).status).toBe(202);
		expect(env.messages().at(-1).to).toMatchObject({ phone: '+12025550143' });
		await env.setting('phone', 'defaultCallingCode', '');
	});
});

describe('A6: per-role sign-in options', () => {
	it('remember: ask, ask_ticked or always; the widget config follows the role of sign-ups', async () => {
		await signUp('rem@example.com');
		expect((await signIn('rem@example.com')).json.remember).toBe(false);
		const customer = (await env.serverCall('GET', '/v1/roles')).json.items.find((/** @type {any} */ r) => r.key === 'customer');
		expect(customer).toMatchObject({ remember: 'ask', methods: [], signIn: 'on', logSignIns: false, rank: 900 });
		const save = (/** @type {Record<string, unknown>} */ fields) =>
			env.serverCall('PUT', '/v1/roles/customer', { ...customer, ...fields });
		expect((await save({ remember: 'always' })).status).toBe(200);
		const always = await signIn('rem@example.com');
		expect(always.json.remember).toBe(true);
		expect(Date.parse(always.json.sessionExpiresAt) - env.now()).toBe(30 * 86_400_000);
		expect((await env.visitor('GET', '/v1/widget/config')).json.settings).toMatchObject({
			remember: 'always',
			signInPaused: false,
		});
		await save({ remember: 'ask_ticked' });
		expect((await env.visitor('GET', '/v1/widget/config')).json.settings.remember).toBe('ask_ticked');
		expect(code(await save({ remember: 'sometimes' }))).toBe('validation_failed');
		await save({ remember: 'ask' });
	});

	it('A14 remember never: no box, never remembered, the server end is the role’s longer length; default unchanged', async () => {
		const customer = (await env.serverCall('GET', '/v1/roles')).json.items.find((/** @type {any} */ r) => r.key === 'customer');
		expect(customer).toMatchObject({ remember: 'ask', sessionHours: 24, rememberDays: 30, sessionRolling: false });
		const save = (/** @type {Record<string, unknown>} */ fields) =>
			env.serverCall('PUT', '/v1/roles/customer', { ...customer, ...fields });
		await signUp('never@example.com');
		// today's default: the box decides
		expect((await signIn('never@example.com', undefined, { remember: true })).json).toMatchObject({ remember: true });
		const saved = await save({ remember: 'never' });
		expect(saved.json.remember).toBe('never');
		expect((await env.visitor('GET', '/v1/widget/config')).json.settings.remember).toBe('never');
		// the box is ignored: the session is not remembered (the browser keeps it until it closes), and the server ends it
		// at the latest after the longer of the session length and the remember-me days
		for (const asked of [true, false]) {
			const answer = await signIn('never@example.com', undefined, { remember: asked });
			expect(answer.json.remember).toBe(false);
			expect(Date.parse(answer.json.sessionExpiresAt) - env.now()).toBe(30 * 86_400_000);
		}
		await save({ remember: 'never', sessionHours: 720, rememberDays: 1 });
		expect(Date.parse((await signIn('never@example.com')).json.sessionExpiresAt) - env.now()).toBe(720 * 3_600_000);
		await save({ remember: 'never', sessionHours: 5, rememberDays: 0 });
		const short = await signIn('never@example.com', undefined, { remember: true });
		expect(Date.parse(short.json.sessionExpiresAt) - env.now()).toBe(5 * 3_600_000);
		// a rolling session keeps the rule at each renewal
		await save({ remember: 'never', sessionHours: 2, rememberDays: 3, sessionRolling: true });
		const rolling = await signIn('never@example.com', undefined, { remember: true });
		env.advance(3_600_000);
		const renewed = await env.visitor('POST', '/v1/session/refresh', { refreshToken: rolling.json.refreshToken });
		expect(renewed.json.remember).toBe(false);
		expect(Date.parse(renewed.json.sessionExpiresAt) - env.now()).toBe(3 * 86_400_000);
		// the role's remember applies only while Roles and permissions is on: off, the box decides again
		await env.switchOn(
			ALL.filter((key) => !['terms', 'approval', 'two_step', 'risk_checks', 'roles', 'role_requests'].includes(key)),
		);
		expect((await signIn('never@example.com', undefined, { remember: true })).json.remember).toBe(true);
		expect((await env.visitor('GET', '/v1/widget/config')).json.settings.remember).toBe('ask');
		await env.switchOn(ALL.filter((key) => !['terms', 'approval', 'two_step', 'risk_checks'].includes(key)));
		await env.serverCall('PUT', '/v1/roles/customer', customer);
		expect((await signIn('never@example.com', undefined, { remember: true })).json.remember).toBe(true);
	});

	it('methods: a role signs in only with its methods; the refusal comes before a code is sent', async () => {
		const staff = await env.serverCall('POST', '/v1/users', {
			name: 'Sid Staff',
			email: 'sid@example.com',
			phone: '+447700900111',
			role: 'support_staff',
			password: 'correct horse battery',
		});
		expect(staff.status).toBe(201);
		const role = (await env.serverCall('GET', '/v1/roles')).json.items.find(
			(/** @type {any} */ r) => r.key === 'support_staff',
		);
		expect(code(await env.serverCall('PUT', '/v1/roles/support_staff', { ...role, methods: ['fax'] }))).toBe(
			'validation_failed',
		);
		await env.serverCall('PUT', '/v1/roles/support_staff', { ...role, methods: ['email_password'] });
		expect((await signIn('sid@example.com')).json.status).toBe('signed_in');
		env.advance(3_600_000);
		const before = env.messages().length;
		expect(code(await askCode('+447700900111'))).toBe('method_refused');
		expect(env.messages().length).toBe(before);
		await env.serverCall('PUT', '/v1/roles/support_staff', { ...role, methods: [] });
	});

	it('paused: users of the role and new sign-ups get sign_in_paused with the merchant’s text, before any code', async () => {
		const customer = (await env.serverCall('GET', '/v1/roles')).json.items.find((/** @type {any} */ r) => r.key === 'customer');
		await env.serverCall('PUT', '/v1/roles/customer', { ...customer, signIn: 'paused' });
		await env.serverCall('PUT', '/v1/texts/signIn.paused', { value: 'Order as a guest for now.' });
		const paused = await signIn('rem@example.com');
		expect(code(paused)).toBe('sign_in_paused');
		expect(paused.json.detail).toBe('Order as a guest for now.');
		expect(code(await signUp('new-paused@example.com'))).toBe('sign_in_paused');
		env.advance(3_600_000);
		const before = env.messages().length;
		expect(code(await askCode('+447700900222'))).toBe('sign_in_paused');
		expect(code(await env.visitor('POST', '/v1/sign-in/email/code', { email: 'rem@example.com' }))).toBe('sign_in_paused');
		expect(env.messages().length).toBe(before);
		expect((await env.visitor('GET', '/v1/widget/config')).json.settings.signInPaused).toBe(true);
		// staff of another role still sign in
		expect((await signIn('sid@example.com')).json.status).toBe('signed_in');
		await env.serverCall('PUT', '/v1/roles/customer', { ...customer, signIn: 'on' });
		expect((await signIn('rem@example.com')).json.status).toBe('signed_in');
	});

	it('ranks: ready roles keep theirs; own roles sit between Owner and Customer', async () => {
		const own = await env.serverCall('PUT', '/v1/roles/member', { name: 'Member', rank: 50 });
		expect(code(own)).toBe('validation_failed');
		expect((await env.serverCall('PUT', '/v1/roles/member', { name: 'Member', rank: 700 })).json.rank).toBe(700);
		expect((await env.serverCall('PUT', '/v1/roles/member', { name: 'Member' })).json.rank).toBe(600);
		const owner = (await env.serverCall('GET', '/v1/roles')).json.items[0];
		expect(owner.key).toBe('owner');
		expect((await env.serverCall('PUT', '/v1/roles/owner', { ...owner, rank: 999 })).json.rank).toBe(100);
	});
});

describe('A10: sign-in events in the activity log', () => {
	it('logs sign-ins, failures, resets and recovery codes with the IP, for roles that ask for it', async () => {
		env.setNetwork('203.0.113.77');
		await signIn('sid@example.com', 'wrong password');
		expect(await activity('action=user.sign_in_failed')).toEqual([]);
		const role = (await env.serverCall('GET', '/v1/roles')).json.items.find(
			(/** @type {any} */ r) => r.key === 'support_staff',
		);
		await env.serverCall('PUT', '/v1/roles/support_staff', { ...role, logSignIns: true });
		await signIn('sid@example.com', 'wrong password');
		await signIn('sid@example.com');
		const [failed] = await activity('action=user.sign_in_failed');
		expect(failed).toMatchObject({ actor: { kind: 'user', name: 'Sid Staff', role: 'support_staff' }, label: 'Sid Staff' });
		expect(failed.detail).toBe('IP: 203.0.113.77; Wrong password');
		expect((await activity('action=user.signed_in'))[0].detail).toBe('IP: 203.0.113.77; Method: email_password');
		await env.visitor('POST', '/v1/password/forgot', { email: 'sid@example.com', returnTo: 'https://shop.example.com/reset' });
		const link = String(env.messages().at(-1).values.link).split('=')[1];
		expect((await env.visitor('POST', '/v1/password/reset', { token: link, password: 'brand new password 9' })).status).toBe(
			204,
		);
		expect((await activity('action=user.password_reset'))[0].detail).toBe('IP: 203.0.113.77; With an email link');
		env.setNetwork(null);
	});
});

describe('A8: imported two-step and old recovery codes', () => {
	it('an imported TOTP secret signs in, and an old recovery code works once', async () => {
		await env.switchOn([...ALL.filter((key) => !['terms', 'approval', 'risk_checks'].includes(key))]);
		const user = (
			await env.serverCall('POST', '/v1/users', {
				name: 'Ira Imported',
				email: 'ira@example.com',
				role: 'support_staff',
				password: 'correct horse battery',
			})
		).json;
		const secret = 'JBSWY3DPEHPK3PXP';
		const old = ['ABCDE-FGHJK', 'MNPQR-STUVW'];
		const hashes = old.map((c) =>
			createHash('sha256')
				.update(`recovery:${c.replace('-', '')}`)
				.digest('hex'),
		);
		const store = await env.store();
		await store.users.update(user.id, {
			twoStep: env.product.twoStepFromImport(env.websiteId, user.id, { secret: secret.toLowerCase(), recoveryHashes: hashes }),
		});
		const first = await signIn('ira@example.com');
		expect(first.json.status).toBe('two_step');
		const ok = await env.visitor('POST', '/v1/sign-in/two-step', {
			challenge: first.json.challenge,
			code: totpCode(secret, env.now()),
		});
		expect(ok.json.status).toBe('signed_in');
		const second = await signIn('ira@example.com');
		const withOld = await env.visitor('POST', '/v1/sign-in/two-step', {
			challenge: second.json.challenge,
			recoveryCode: 'abcde fghjk',
		});
		expect(withOld.json.status).toBe('signed_in');
		expect((await userOf(user.id)).recoveryCodesLeft).toBe(1);
		const third = await signIn('ira@example.com');
		expect(
			code(
				await env.visitor('POST', '/v1/sign-in/two-step', { challenge: third.json.challenge, recoveryCode: 'ABCDE-FGHJK' }),
			),
		).toBe('code_invalid');
		const logged = await activity('action=user.recovery_code_used');
		expect(logged[0].detail).toMatch(/1 left$/);
	});

	it('wrong two-step and recovery codes count toward the lock like wrong passwords; the step is refused while locked', async () => {
		const user = (
			await env.serverCall('POST', '/v1/users', {
				name: 'Ivo Guarded',
				email: 'ivo@example.com',
				role: 'support_staff',
				password: 'correct horse battery',
			})
		).json;
		const secret = 'KRUGS4ZANFZSAYJA';
		const store = await env.store();
		await store.users.update(user.id, {
			twoStep: env.product.twoStepFromImport(env.websiteId, user.id, { secret, recoveryHashes: [] }),
		});
		const good = () => totpCode(secret, env.now());
		// a code none of the accepted steps (now and one step either side) gives
		const near = [-30_000, 0, 30_000].map((ms) => totpCode(secret, env.now() + ms));
		const bad = ['000000', '111111', '222222', '333333'].find((c) => !near.includes(c));
		/** @param {Record<string, unknown>} answer */
		const step = async (answer) =>
			env.visitor('POST', '/v1/sign-in/two-step', { challenge: (await signIn('ivo@example.com')).json.challenge, ...answer });
		// 5 wrong tries over fresh challenges (each password sign-in gives a new one): the user is locked
		for (let i = 0; i < 3; i += 1) expect(code(await step({ code: bad }))).toBe('code_invalid');
		const open = (await signIn('ivo@example.com')).json.challenge;
		for (let i = 0; i < 2; i += 1) expect(code(await step({ recoveryCode: 'ZZZZZ-ZZZZZ' }))).toBe('code_invalid');
		// even the right code of a challenge given before the lock is refused while it lasts
		const locked = await env.visitor('POST', '/v1/sign-in/two-step', { challenge: open, code: good() });
		expect(code(locked)).toBe('locked');
		expect(Date.parse(locked.json.lockedUntil) - env.now()).toBe(15 * 60_000);
		expect(code(await signIn('ivo@example.com'))).toBe('locked');
		env.advance(16 * 60_000);
		expect((await step({ code: good() })).json.status).toBe('signed_in');
		expect((await userOf(user.id)).lockedUntil).toBeNull();
	});
});

describe('A11: profile options', () => {
	it('area and a default address; at most N; required fields; the last address stays', async () => {
		await env.switchOn(ALL.filter((key) => !['terms', 'approval', 'two_step', 'risk_checks'].includes(key)));
		const me = (await signIn('rem@example.com')).json.signIn;
		const save = (/** @type {unknown[]} */ addresses) => env.visitor('PATCH', '/v1/me', { addresses }, me);
		const two = await save([
			{ line1: '1 High Street', area: 'Camden', city: 'London' },
			{ line1: '2 Park Road', city: 'London' },
		]);
		expect(two.json.addresses).toMatchObject([
			{ area: 'Camden', default: true },
			{ area: '', default: false },
		]);
		const moved = await save([
			{ ...two.json.addresses[0], default: false },
			{ ...two.json.addresses[1], default: true },
		]);
		expect(moved.json.addresses.map((/** @type {any} */ a) => a.default)).toEqual([false, true]);
		expect(
			code(
				await save([
					{ line1: 'a', city: 'b', default: true },
					{ line1: 'c', city: 'd', default: true },
				]),
			),
		).toBe('validation_failed');
		expect(code(await save([{ line1: 'No city' }]))).toBe('validation_failed');
		await env.setting('profile', 'addressRequired', ['line1', 'area']);
		expect((await save([{ line1: 'No city', area: 'DHA' }])).status).toBe(200);
		await env.setting('profile', 'maxAddresses', 1);
		expect(
			code(
				await save([
					{ line1: 'a', area: 'b' },
					{ line1: 'c', area: 'd' },
				]),
			),
		).toBe('validation_failed');
		await env.setting('profile', 'keepOneAddress', true);
		expect(code(await save([]))).toBe('validation_failed');
		const config = (await env.visitor('GET', '/v1/widget/config')).json.settings.profile;
		expect(config).toEqual({ maxAddresses: 1, keepOneAddress: true, addressRequired: ['line1', 'area'] });
	});
});

describe('A12: sign-in from the merchant’s server', () => {
	it('signs in, renews and signs out with the server token and SS-Visitor-IP; the refresh token comes in the body', async () => {
		/** @param {string} path @param {unknown} body @param {Record<string, string>} [headers] */
		const fromServer = (path, body, headers = {}) =>
			env.call('POST', path, {
				token: env.server,
				body,
				headers: {
					'ss-visitor-ip': '198.51.100.20',
					'ss-visitor-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0',
					...headers,
				},
			});
		const noIp = await env.call('POST', '/v1/sign-in/password', {
			token: env.server,
			body: { email: 'rem@example.com', password: 'correct horse battery' },
		});
		expect(code(noIp)).toBe('visitor_ip_required');
		const signedIn = await fromServer('/v1/sign-in/password', { email: 'rem@example.com', password: 'correct horse battery' });
		expect(signedIn.json).toMatchObject({ status: 'signed_in' });
		expect(signedIn.json.refreshToken).toMatch(/^ses_/);
		const devices = await env.call('GET', '/v1/me/sessions', { token: env.server, signIn: signedIn.json.signIn });
		expect(devices.json.items.find((/** @type {any} */ d) => d.current).device).toBe('Chrome on Android');
		const renewed = await fromServer('/v1/session/refresh', { refreshToken: signedIn.json.refreshToken });
		expect(renewed.json.refreshToken).not.toBe(signedIn.json.refreshToken);
		expect((await fromServer('/v1/session/sign-out', { refreshToken: renewed.json.refreshToken })).status).toBe(204);
		expect(code(await fromServer('/v1/session/refresh', { refreshToken: renewed.json.refreshToken }))).toBe('signed_out');
		env.advance(3_600_000);
		expect((await fromServer('/v1/sign-in/phone/code', { phone: '+447700900990' })).status).toBe(202);
	});
});

describe('K-27: rolling sessions, new recovery codes and reset links to another host', () => {
	/** @param {string} refreshToken */
	const renew = (refreshToken) => env.visitor('POST', '/v1/session/refresh', { refreshToken });

	it('a role’s sessions roll: each renewal moves the end to the role’s length from then; off by default', async () => {
		await env.switchOn(ALL.filter((key) => !['terms', 'approval', 'risk_checks'].includes(key)));
		const customer = (await env.serverCall('GET', '/v1/roles')).json.items.find((/** @type {any} */ r) => r.key === 'customer');
		expect(customer.sessionRolling).toBe(false);
		await signUp('roll@example.com');
		const first = await signIn('roll@example.com');
		const end = Date.parse(first.json.sessionExpiresAt);
		expect(end - env.now()).toBe(24 * 3_600_000);
		// by default the end is fixed at sign-in
		env.advance(3_600_000);
		const fixed = await renew(first.json.refreshToken);
		expect(Date.parse(fixed.json.sessionExpiresAt)).toBe(end);
		const saved = await env.serverCall('PUT', '/v1/roles/customer', { ...customer, sessionRolling: true });
		expect(saved.json.sessionRolling).toBe(true);
		// a session in use lives on past its first end
		let token = fixed.json.refreshToken;
		for (let hour = 0; hour < 30; hour += 1) {
			env.advance(3_600_000);
			const rolled = await renew(token);
			expect(Date.parse(rolled.json.sessionExpiresAt) - env.now()).toBe(24 * 3_600_000);
			token = rolled.json.refreshToken;
		}
		expect(env.now()).toBeGreaterThan(end);
		// a renewal again within the grace gets the same pair and the same end
		const once = await renew(token);
		env.advance(10_000);
		const twice = await renew(token);
		expect([twice.json.refreshToken, twice.json.sessionExpiresAt]).toEqual([
			once.json.refreshToken,
			once.json.sessionExpiresAt,
		]);
		expect((await env.visitor('GET', '/v1/me', undefined, twice.json.signIn)).json.email).toBe('roll@example.com');
		// a remembered session rolls by the remember-me days; an idle one still ends
		const remembered = await signIn('roll@example.com', undefined, { remember: true });
		env.advance(10 * 86_400_000);
		const later = await renew(remembered.json.refreshToken);
		expect(Date.parse(later.json.sessionExpiresAt) - env.now()).toBe(30 * 86_400_000);
		env.advance(31 * 86_400_000);
		expect(code(await renew(later.json.refreshToken))).toBe('signed_out');
		await env.serverCall('PUT', '/v1/roles/customer', { ...customer, sessionRolling: false });
	});

	it('new recovery codes: a code from the app or a recovery code proves the step; the old codes stop working', async () => {
		const user = (
			await env.serverCall('POST', '/v1/users', {
				name: 'Rae Renew',
				email: 'rae@example.com',
				role: 'support_staff',
				password: 'correct horse battery',
			})
		).json;
		/** @param {Record<string, unknown>} body @param {string} signInToken */
		const replace = (body, signInToken) => env.visitor('POST', '/v1/me/two-step/recovery-codes', body, signInToken);
		// without two-step there is nothing to replace
		const plain = (await signIn('rae@example.com')).json.signIn;
		expect(code(await replace({ code: '123456' }, plain))).toBe('conflict');
		const secret = 'MFRGGZDFMZTWQ2LK';
		await (
			await env.store()
		).users.update(user.id, {
			twoStep: env.product.twoStepFromImport(env.websiteId, user.id, { secret, recoveryHashes: [] }),
		});
		const first = await signIn('rae@example.com');
		const me = (
			await env.visitor('POST', '/v1/sign-in/two-step', { challenge: first.json.challenge, code: totpCode(secret, env.now()) })
		).json.signIn;
		// the code the sign-in used is spent
		expect(code(await replace({ code: totpCode(secret, env.now()) }, me))).toBe('code_invalid');
		env.advance(60_000);
		const fresh = await replace({ code: totpCode(secret, env.now()) }, me);
		expect(fresh.json.recoveryCodes).toHaveLength(10);
		expect((await userOf(user.id)).recoveryCodesLeft).toBe(10);
		// with one of them (the phone is lost): new ones again, and the earlier ones stop working
		const again = await replace({ recoveryCode: fresh.json.recoveryCodes[3] }, me);
		expect(again.json.recoveryCodes).toHaveLength(10);
		const second = await signIn('rae@example.com');
		const old = await env.visitor('POST', '/v1/sign-in/two-step', {
			challenge: second.json.challenge,
			recoveryCode: fresh.json.recoveryCodes[0],
		});
		expect(code(old)).toBe('code_invalid');
		const withNew = await env.visitor('POST', '/v1/sign-in/two-step', {
			challenge: second.json.challenge,
			recoveryCode: again.json.recoveryCodes[0],
		});
		expect(withNew.json.status).toBe('signed_in');
		const logged = await activity('action=user.recovery_codes_replaced');
		expect(logged[0]).toMatchObject({ actor: { name: 'Rae Renew', role: 'support_staff' }, label: 'Rae Renew' });
		expect(logged[0].detail).toMatch(/^IP: [\d.]+; 10 new recovery codes$/);
		// wrong codes count toward the lock; the route is refused while it lasts
		for (let i = 0; i < 5; i += 1) expect(code(await replace({ recoveryCode: 'ZZZZZ-ZZZZZ' }, me))).toBe('code_invalid');
		env.advance(60_000);
		const locked = await replace({ code: totpCode(secret, env.now()) }, me);
		expect(code(locked)).toBe('locked');
		expect(code(await signIn('rae@example.com'))).toBe('locked');
	});

	it('Forgot password links may open another host of the merchant’s listed in Settings (an admin on its own host)', async () => {
		const page = 'https://admin.shop.example.com/login/reset';
		/** @param {string} returnTo */
		const forgot = (returnTo) => env.visitor('POST', '/v1/password/forgot', { email: 'sid@example.com', returnTo });
		expect(code(await forgot(page))).toBe('validation_failed');
		await env.setting('email_password', 'resetHosts', ['Admin.Shop.Example.com']);
		expect((await forgot(page)).status).toBe(202);
		expect(String(env.messages().at(-1).values.link)).toMatch(
			/^https:\/\/admin\.shop\.example\.com\/login\/reset#ss_accounts_reset=/,
		);
		// over https on the default port, and only the hosts listed
		for (const url of [
			'http://admin.shop.example.com/x',
			'https://admin.shop.example.com:8443/x',
			'https://other.shop.example.com/x',
		])
			expect(code(await forgot(url))).toBe('validation_failed');
		const refused = await env.dashboard(
			await env.adminSession(),
			'PUT',
			`/v1/dashboard/websites/${env.websiteId}/settings/email_password.resetHosts`,
			{ value: ['not a host!'] },
		);
		expect(refused.status).toBe(422);
		await env.setting('email_password', 'resetHosts', []);
		expect(code(await forgot(page))).toBe('validation_failed');
	});
});
