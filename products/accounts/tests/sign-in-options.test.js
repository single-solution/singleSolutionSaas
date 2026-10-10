/**
 * Sign-in options (PLAN 0.8.10): phone-code options (A7), per-role sign-in options (A6), imported two-step (A8),
 * sign-in events in the activity log (A10), profile options (A11) and sign-in from the merchant's server (A12).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../adapters/crypto.js';
import { ALL, setup } from './helpers.js';

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
		await env.setting('phone_code', 'cooldownSeconds', 60);
		expect((await askCode('+923001230001')).status).toBe(202);
		env.advance(30_000);
		const soon = await askCode('+923001230001');
		expect(code(soon)).toBe('code_cooldown');
		expect(Date.parse(soon.json.retryAt) - env.now()).toBe(30_000);
		env.advance(30_000);
		expect((await askCode('+923001230001')).status).toBe(202);
		await env.setting('phone_code', 'perHour', 2);
		env.advance(60_000);
		expect(code(await askCode('+923001230001'))).toBe('code_limit');
		await env.setting('phone_code', 'websitePerHour', 3);
		env.advance(3_600_000);
		expect((await askCode('+923001230002')).status).toBe(202);
		expect((await askCode('+923001230003')).status).toBe(202);
		expect((await askCode('+923001230004')).status).toBe(202);
		expect(code(await askCode('+923001230005'))).toBe('code_limit');
		await env.setting('phone_code', 'websitePerHour', 0);
		await env.setting('phone_code', 'countries', ['PK']);
		expect(code(await askCode('+14155550100'))).toBe('country_not_allowed');
		expect((await askCode('+923001230006')).status).toBe(202);
		await env.setting('phone_code', 'countries', []);
	});

	it('names new phone-code users with the website’s template', async () => {
		await env.setting('phone_code', 'newUserName', 'Customer {last4}');
		env.advance(3_600_000);
		await askCode('+923001239876');
		const sent = env.messages().at(-1);
		const named = await env.visitor('POST', '/v1/sign-in/phone', { phone: '+923001239876', code: sent.values.code });
		expect(named.json.user.name).toBe('Customer 9876');
		await askCode('+923001239877');
		const own = await env.visitor('POST', '/v1/sign-in/phone', {
			phone: '+923001239877',
			code: env.messages().at(-1).values.code,
			name: 'Own Name',
		});
		expect(own.json.user.name).toBe('Own Name');
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
		expect(code(await save({ remember: 'never' }))).toBe('validation_failed');
		await save({ remember: 'ask' });
	});

	it('methods: a role signs in only with its methods; the refusal comes before a code is sent', async () => {
		const staff = await env.serverCall('POST', '/v1/users', {
			name: 'Sid Staff',
			email: 'sid@example.com',
			phone: '+923001231111',
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
		expect(code(await askCode('+923001231111'))).toBe('method_refused');
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
		expect(code(await askCode('+923001232222'))).toBe('sign_in_paused');
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
		expect((await activity('action=user.password_reset'))[0].detail).toBe('IP: 203.0.113.77; With an e-mail link');
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
});

describe('A11: profile options', () => {
	it('area and a default address; at most N; required fields; the last address stays', async () => {
		await env.switchOn(ALL.filter((key) => !['terms', 'approval', 'two_step', 'risk_checks'].includes(key)));
		const me = (await signIn('rem@example.com')).json.signIn;
		const save = (/** @type {unknown[]} */ addresses) => env.visitor('PATCH', '/v1/me', { addresses }, me);
		const two = await save([
			{ line1: '1 Mall Road', area: 'Gulberg', city: 'Lahore' },
			{ line1: '2 Canal Road', city: 'Lahore' },
		]);
		expect(two.json.addresses).toMatchObject([
			{ area: 'Gulberg', default: true },
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
		expect((await fromServer('/v1/sign-in/phone/code', { phone: '+923001239990' })).status).toBe(202);
	});
});
