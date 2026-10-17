/**
 * Passwords from other systems and the password options (PLAN 0.8.10 A1, A2, A9).
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODE_LENGTH, CODE_MINUTES, PASSWORD_MAX_LENGTH } from '../core/limits.js';
import { NOTIFY, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

/** The stored password hash of a user. @param {string} id */
const storedHash = async (id) => (await (await env.store()).users.get(id))?.passwordHash ?? null;

/** Put an imported hash on a user. @param {string} id @param {string} passwordHash */
const importHash = async (id, passwordHash) => {
	await (await env.store()).users.update(id, { passwordHash });
};

/** A peppered PBKDF2 hash as the source system stored it. @param {string} password @param {string} pepper */
const pbkdf2Hash = (password, pepper, iterations = 1000) => {
	const salt = randomBytes(16);
	const hash = pbkdf2Sync(`${pepper}:${password}`, salt, iterations, 32, 'sha256');
	return `pbkdf2$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
};

/** @param {string} email @param {string} password */
const signIn = (email, password) => env.visitor('POST', '/v1/sign-in/password', { email, password });

beforeAll(async () => {
	env = await setup();
	await env.switchOn(['email_password']);
	await env.connectDatabase();
	await env.paste('notifications');
});
afterAll(async () => {
	await env.product.close();
});

describe('A1: password hashes imported from another system', () => {
	it('bcrypt ($2a$, $2b$, $2y$) signs in and is re-hashed with scrypt', async () => {
		for (const [index, prefix] of ['$2a$', '$2b$', '$2y$'].entries()) {
			const email = `bcrypt${index}@example.com`;
			const up = await env.visitor('POST', '/v1/sign-up/password', { email, password: 'first password 1' });
			const id = up.json.user.id;
			const hash = `${prefix}${bcrypt.hashSync('old bcrypt password', 4).slice(4)}`;
			await importHash(id, hash);
			expect(code(await signIn(email, 'wrong password'))).toBe('sign_in_failed');
			expect(await storedHash(id)).toBe(hash);
			const ok = await signIn(email, 'old bcrypt password');
			expect(ok.json.status).toBe('signed_in');
			expect(await storedHash(id)).toMatch(/^scrypt\$/);
			expect((await signIn(email, 'old bcrypt password')).json.status).toBe('signed_in');
		}
	});

	it('PBKDF2 with the pepper connection; without the pepper the check fails', async () => {
		const up = await env.visitor('POST', '/v1/sign-up/password', { email: 'pbkdf2@example.com', password: 'first password 1' });
		const id = up.json.user.id;
		// no Unicode normalization on this path: the composed é is not the decomposed one
		const password = 'café secret 12';
		const hash = pbkdf2Hash(password, 'source-pepper');
		await importHash(id, hash);
		expect(code(await signIn('pbkdf2@example.com', password))).toBe('sign_in_failed');
		await env.connect('imported_password_pepper', 'source-pepper');
		const listed = await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/connections`);
		expect(listed.text).not.toContain('source-pepper');
		expect(code(await signIn('pbkdf2@example.com', 'café secret 12'))).toBe('sign_in_failed');
		expect(await storedHash(id)).toBe(hash);
		expect((await signIn('pbkdf2@example.com', password)).json.status).toBe('signed_in');
		expect(await storedHash(id)).toMatch(/^scrypt\$/);
		expect((await signIn('pbkdf2@example.com', password)).json.status).toBe('signed_in');
	});

	it('refuses malformed hashes and outsized iterations like a wrong password', async () => {
		const up = await env.visitor('POST', '/v1/sign-up/password', { email: 'odd@example.com', password: 'first password 1' });
		const id = up.json.user.id;
		for (const hash of [
			'md5$abc',
			pbkdf2Hash('pw', 'source-pepper').replace(/^pbkdf2\$1000/, 'pbkdf2$9000000'),
			'pbkdf2$1000$AAAA$AAAA',
		]) {
			await importHash(id, hash);
			expect(code(await signIn('odd@example.com', 'pw'))).toBe('sign_in_failed');
		}
	});

	it('the current password of My account accepts an imported hash too', async () => {
		const up = await env.visitor('POST', '/v1/sign-up/password', { email: 'change@example.com', password: 'first password 1' });
		await importHash(up.json.user.id, bcrypt.hashSync('imported current 1', 4));
		const changed = await env.visitor(
			'PUT',
			'/v1/me/password',
			{ current: 'imported current 1', password: 'brand new password 2' },
			up.json.signIn,
		);
		expect(changed.status).toBe(204);
		expect((await signIn('change@example.com', 'brand new password 2')).json.status).toBe('signed_in');
	});
});

describe('A2: phone + password', () => {
	/** @param {Record<string, unknown>} body */
	const phoneSignIn = (body) => env.visitor('POST', '/v1/sign-in/phone-password', body);

	it('signs up and in with a phone number and a password in the website’s phone format', async () => {
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', { phone: '+447700900000', password: 'x' }))).toBe(
			'feature_off',
		);
		await env.switchOn(['email_password', 'phone_password']);
		// the phone format is shared by Phone code and Phone + password, and shown while either is on
		const cookie = await env.merchantSession();
		const listed = await env.dashboard(cookie, 'GET', `/v1/dashboard/websites/${env.websiteId}/settings`);
		expect(listed.json.features.map((/** @type {{ key: string }} */ f) => f.key)).toEqual(
			expect.arrayContaining(['phone_password', 'email_password', 'phone', 'profile']),
		);
		expect(listed.json.features.map((/** @type {{ key: string }} */ f) => f.key)).not.toContain('phone_code');
		await env.setting('phone', 'defaultCallingCode', '+44');
		await env.setting('phone', 'trunkPrefix', '0');
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', { phone: 'nope', password: 'abc12345' }))).toBe(
			'validation_failed',
		);
		const up = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: '07700 900000',
			password: 'abc12345',
			name: 'Robin',
			remember: true,
		});
		expect(up.json).toMatchObject({
			status: 'signed_in',
			user: { phone: '+447700900000', phoneVerified: false, name: 'Robin' },
		});
		expect(
			code(await env.visitor('POST', '/v1/sign-up/phone-password', { phone: '+447700900000', password: 'abc12345' })),
		).toBe('already_exists');
		const sessions = await env.visitor('GET', '/v1/me/sessions', undefined, up.json.signIn);
		expect(sessions.json.items[0].method).toBe('phone_password');
		expect(code(await phoneSignIn({ phone: '07700900000', password: 'wrong one' }))).toBe('sign_in_failed');
		expect(code(await phoneSignIn({ phone: '07700900999', password: 'abc12345' }))).toBe('sign_in_failed');
		expect((await phoneSignIn({ phone: '07700900000', password: 'abc12345' })).json.status).toBe('signed_in');
	});

	it('uses its own password rules: length 6 to 128 and a letter with a digit', async () => {
		await env.setting('phone_password', 'minLength', 6);
		await env.setting('phone_password', 'letterAndDigit', true);
		const refused = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: '+447700900001',
			password: 'onlyletters',
		});
		expect(code(refused)).toBe('weak_password');
		expect(refused.json.detail).toMatch(/letter and one digit/);
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', { phone: '+447700900001', password: 'a1b2' }))).toBe(
			'weak_password',
		);
		const ok = await env.visitor('POST', '/v1/sign-up/phone-password', { phone: '+447700900001', password: 'a1b2c3' });
		expect(ok.json.status).toBe('signed_in');
		// My account changes the password of a phone user with the same rules
		expect(code(await env.visitor('PUT', '/v1/me/password', { current: 'a1b2c3', password: 'zzzzzz' }, ok.json.signIn))).toBe(
			'weak_password',
		);
		expect(
			(await env.visitor('PUT', '/v1/me/password', { current: 'a1b2c3', password: 'new1pass' }, ok.json.signIn)).status,
		).toBe(204);
		expect((await phoneSignIn({ phone: '+447700900001', password: 'new1pass' })).json.status).toBe('signed_in');
	});

	it('with sign-up off, only the shop gives passwords: sign-up is closed, sign-in still works', async () => {
		expect((await env.visitor('GET', '/v1/widget/config')).json.settings.phonePassword.signUp).toBe(true);
		await env.setting('phone_password', 'signUp', false);
		expect(
			code(await env.visitor('POST', '/v1/sign-up/phone-password', { phone: '+447700900002', password: 'a1b2c3d4' })),
		).toBe('sign_up_closed');
		expect((await env.visitor('GET', '/v1/widget/config')).json.settings.phonePassword.signUp).toBe(false);
		expect((await phoneSignIn({ phone: '+447700900001', password: 'new1pass' })).json.status).toBe('signed_in');
		await env.setting('phone_password', 'signUp', true);
	});

	it('Forgot password sends a code through Notifications; the code sets a new password and signs devices out', async () => {
		const before = env.messages().length;
		expect((await env.visitor('POST', '/v1/password/phone/forgot', { phone: '+447700900999' })).status).toBe(202);
		expect(env.messages().length).toBe(before);
		expect((await env.visitor('POST', '/v1/password/phone/forgot', { phone: '07700900000' })).status).toBe(202);
		const sent = env.messages().at(-1);
		expect(sent).toMatchObject({ channel: 'sms', template: 'accounts.phone_code', to: { phone: '+447700900000' } });
		// a second ask within the cooldown sends nothing, and the answer does not tell (ST-3)
		const sentCount = env.messages().length;
		expect((await env.visitor('POST', '/v1/password/phone/forgot', { phone: '07700900000' })).status).toBe(202);
		expect(env.messages()).toHaveLength(sentCount);
		const signedIn = await phoneSignIn({ phone: '+447700900000', password: 'abc12345' });
		expect(
			code(
				await env.visitor('POST', '/v1/password/phone/reset', {
					phone: '+447700900000',
					code: sent.values.code === '000000' ? '111111' : '000000',
					password: 'n3w password',
				}),
			),
		).toBe('code_invalid');
		expect(
			code(
				await env.visitor('POST', '/v1/password/phone/reset', {
					phone: '+447700900999',
					code: sent.values.code,
					password: 'x1',
				}),
			),
		).toBe('code_invalid');
		const reset = await env.visitor('POST', '/v1/password/phone/reset', {
			phone: '+447700900000',
			code: sent.values.code,
			password: 'n3w password',
		});
		expect(reset.status).toBe(204);
		expect(code(await env.visitor('GET', '/v1/me', undefined, signedIn.json.signIn))).toBe('signed_out');
		expect((await phoneSignIn({ phone: '+447700900000', password: 'n3w password' })).json.status).toBe('signed_in');
		expect(
			code(
				await env.visitor('POST', '/v1/password/phone/reset', {
					phone: '+447700900000',
					code: sent.values.code,
					password: 'n3w password',
				}),
			),
		).toBe('code_invalid');
	});

	it('a code that cannot go now goes on a later request while it is valid; the answer never tells', async () => {
		const sms = `${NOTIFY}/v1/messages/sms`;
		const tries = () => env.messages().filter((m) => m.to.phone === '+447700900000').length;
		env.advance(31_000);
		env.responders.set(sms, () => ({ status: 201, body: { status: 'skipped' } }));
		const before = tries();
		expect((await env.visitor('POST', '/v1/password/phone/forgot', { phone: '+447700900000' })).status).toBe(202);
		expect(tries()).toBe(before + 1);
		env.responders.delete(sms);
		await phoneSignIn({ phone: '+447700900999', password: 'any later request' });
		expect(tries()).toBe(before + 2);
		const reset = await env.visitor('POST', '/v1/password/phone/reset', {
			phone: '+447700900000',
			code: env.messages().at(-1).values.code,
			password: 'n3w password',
		});
		expect(reset.status).toBe(204);
	});

	it('reset codes follow the shared phone settings, which the merchant sets with Phone + password alone', async () => {
		// Phone code is off here: its own settings cannot be changed, the shared Phone numbers and codes ones can
		const cookie = await env.merchantSession();
		/** @param {string} key @param {unknown} value */
		const save = async (key, value) =>
			(await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/settings/${key}`, { value })).status;
		expect(await save('phone_code.newUserName', 'Customer {last4}')).toBe(403);
		expect(await save('phone.channel', 'whatsapp')).toBe(204);
		env.advance(31_000);
		expect((await env.visitor('POST', '/v1/password/phone/forgot', { phone: '+447700900000' })).status).toBe(202);
		const sent = env.messages().at(-1);
		expect(sent).toMatchObject({ channel: 'whatsapp', template: 'accounts.phone_code', values: { minutes: CODE_MINUTES } });
		expect(String(sent.values.code)).toMatch(new RegExp(`^\\d{${CODE_LENGTH}}$`));
		// staff invite someone by phone on the same channel
		// (a staff member's authority is the permissions of their role: Roles and permissions is on for staff routes)
		await env.switchOn(['email_password', 'phone_password', 'approval', 'roles']);
		await env.setting('approval', 'invitePageUrl', 'https://shop.example.com/join');
		const invited = await env.serverCall('POST', '/v1/users/invite', { name: 'Ira Vale', phone: '+447700900344' });
		expect(invited.status).toBe(201);
		expect(env.messages().at(-1)).toMatchObject({ channel: 'whatsapp', template: 'accounts.invite' });
		await env.switchOn(['email_password', 'phone_password']);
		expect(await save('phone.channel', 'sms')).toBe(204);
	});

	it('with Forgot password off, the reset routes refuse and the widget config names the page', async () => {
		await env.setting('phone_password', 'selfReset', 'off');
		await env.setting('phone_password', 'forgotUrl', 'https://wa.me/447700900567');
		expect(code(await env.visitor('POST', '/v1/password/phone/forgot', { phone: '+447700900000' }))).toBe('self_reset_off');
		expect(
			code(await env.visitor('POST', '/v1/password/phone/reset', { phone: '+447700900000', code: '1', password: 'x' })),
		).toBe('self_reset_off');
		const config = await env.visitor('GET', '/v1/widget/config');
		expect(config.json.settings.phonePassword).toMatchObject({ selfReset: 'off', forgotUrl: 'https://wa.me/447700900567' });
		await env.setting('phone_password', 'selfReset', 'code');
	});
});

describe('Forgot password by email: only a proven address or the one the account was made with', () => {
	/** Messages sent to an address. @param {string} email */
	const sentTo = (email) => env.messages().filter((m) => m.to.email === email);
	/** @param {string} email */
	const forgot = (email) => env.visitor('POST', '/v1/password/forgot', { email, returnTo: 'https://shop.example.com/reset' });

	it('a phone + password member’s unproven email address gets nothing, so its owner cannot take the account', async () => {
		const member = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: '+447700900233',
			password: 'member pass 1',
			email: 'someone@example.com',
		});
		expect(member.json.user).toMatchObject({ email: 'someone@example.com', emailVerified: false });
		// the same answer as for an unknown address, and no link
		const asked = await forgot('someone@example.com');
		expect([asked.status, asked.text]).toEqual([202, '']);
		expect(sentTo('someone@example.com')).toHaveLength(0);
		// once the address is proven (staff confirm it, a code or link), the link goes
		await (await env.store()).users.update(member.json.user.id, { emailVerified: true });
		expect((await forgot('someone@example.com')).status).toBe(202);
		expect(sentTo('someone@example.com')).toHaveLength(1);
	});

	it('an email + password account gets the link at the address it was made with, proven or not', async () => {
		const up = await env.visitor('POST', '/v1/sign-up/password', {
			email: 'own@example.com',
			phone: '+447700900244',
			password: 'own password 1',
		});
		expect(up.json.user).toMatchObject({ emailVerified: false, phoneVerified: false });
		await forgot('own@example.com');
		expect(sentTo('own@example.com')).toHaveLength(1);
	});

	it('an account stored without an identity (an import whose source did not say): the email address of one without a phone number', async () => {
		const store = await env.store();
		const alone = await env.visitor('POST', '/v1/sign-up/password', { email: 'old1@example.com', password: 'old password 1' });
		const both = await env.visitor('POST', '/v1/sign-up/password', {
			email: 'old2@example.com',
			phone: '+447700900255',
			password: 'old password 2',
		});
		for (const id of [alone.json.user.id, both.json.user.id]) await store.users.update(id, {}, { $unset: { identity: '' } });
		expect((await store.users.get(alone.json.user.id))?.identity).toBeUndefined();
		await forgot('old1@example.com');
		await forgot('old2@example.com');
		expect(sentTo('old1@example.com')).toHaveLength(1);
		// with a phone number too, which one it was made with is not known: nothing is sent
		expect(sentTo('old2@example.com')).toHaveLength(0);
	});
});

describe('A9: password and lock options', () => {
	it('wrong passwords are forgotten after a quiet day: only recent ones lead to a lock (K-27)', async () => {
		const HOUR = 3_600_000;
		const DAY = 24 * HOUR;
		for (const name of ['steady', 'quiet', 'slow'])
			await env.visitor('POST', '/v1/sign-up/password', { email: `${name}@example.com`, password: `${name} password 1` });
		// just inside the day the earlier wrong passwords still count: the 5th locks
		for (let i = 0; i < 4; i += 1) expect(code(await signIn('steady@example.com', 'bad'))).toBe('sign_in_failed');
		env.advance(DAY - 1);
		expect(code(await signIn('steady@example.com', 'bad'))).toBe('sign_in_failed');
		expect(code(await signIn('steady@example.com', 'steady password 1'))).toBe('locked');
		// a full day with no wrong password: the 4 before are forgotten and the count starts again at the next one
		for (let i = 0; i < 4; i += 1) expect(code(await signIn('quiet@example.com', 'bad'))).toBe('sign_in_failed');
		env.advance(DAY);
		for (let i = 0; i < 5; i += 1) expect(code(await signIn('quiet@example.com', 'bad'))).toBe('sign_in_failed');
		expect(code(await signIn('quiet@example.com', 'quiet password 1'))).toBe('locked');
		// the day runs from the last wrong password, not the first: slow guessing still adds up
		for (let i = 0; i < 4; i += 1) {
			expect(code(await signIn('slow@example.com', 'bad'))).toBe('sign_in_failed');
			env.advance(20 * HOUR);
		}
		expect(code(await signIn('slow@example.com', 'bad'))).toBe('sign_in_failed');
		expect(code(await signIn('slow@example.com', 'slow password 1'))).toBe('locked');
		// Phone + password keeps the same day and the same five
		/** @param {string} phone @param {string} password */
		const phoneSignIn = (phone, password) => env.visitor('POST', '/v1/sign-in/phone-password', { phone, password });
		for (const phone of ['+447700900331', '+447700900332'])
			expect(
				(await env.visitor('POST', '/v1/sign-up/phone-password', { phone, password: `phone pass ${phone.slice(-3)}` })).json
					.status,
			).toBe('signed_in');
		for (let i = 0; i < 4; i += 1) expect(code(await phoneSignIn('+447700900331', 'bad'))).toBe('sign_in_failed');
		env.advance(DAY - 1);
		expect(code(await phoneSignIn('+447700900331', 'bad'))).toBe('sign_in_failed');
		expect(code(await phoneSignIn('+447700900331', 'phone pass 331'))).toBe('locked');
		for (let i = 0; i < 4; i += 1) expect(code(await phoneSignIn('+447700900332', 'bad'))).toBe('sign_in_failed');
		env.advance(DAY);
		for (let i = 0; i < 4; i += 1) expect(code(await phoneSignIn('+447700900332', 'bad'))).toBe('sign_in_failed');
		expect((await phoneSignIn('+447700900332', 'phone pass 332')).json.status).toBe('signed_in');
	});

	it('letter and digit, and the longest password (256), for email + password and phone + password (ST-26)', async () => {
		/** @param {string} email @param {string} password */
		const tryUp = (email, password) => env.visitor('POST', '/v1/sign-up/password', { email, password });
		// by default: letters only and up to 256 characters
		expect((await tryUp('letters@example.com', 'onlyletters')).json.status).toBe('signed_in');
		expect((await tryUp('long@example.com', 'a1'.repeat(128))).json.status).toBe('signed_in');
		const tooLong = await tryUp('longer@example.com', `${'a1'.repeat(128)}x`);
		expect([code(tooLong), tooLong.json.detail]).toEqual(['weak_password', `Use at most ${PASSWORD_MAX_LENGTH} characters.`]);
		expect(tooLong.json).toMatchObject({ rule: 'too_long', maxLength: PASSWORD_MAX_LENGTH });
		await env.setting('email_password', 'letterAndDigit', true);
		for (const password of ['onlyletters', '1234567890']) {
			const refused = await tryUp('rules@example.com', password);
			expect([code(refused), refused.json.detail, refused.json.rule]).toEqual([
				'weak_password',
				'Use at least one letter and one digit.',
				'letter_and_digit',
			]);
		}
		expect((await tryUp('rules@example.com', 'a1'.repeat(64))).json.status).toBe('signed_in');
		// the same rules for a reset and in My account
		const signedIn = await signIn('rules@example.com', 'a1'.repeat(64));
		expect(
			code(
				await env.visitor('PUT', '/v1/me/password', { current: 'a1'.repeat(64), password: 'nodigits' }, signedIn.json.signIn),
			),
		).toBe('weak_password');
		// Phone + password has the same longest password
		const phoneLong = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: '+447700900003',
			password: `${'a1'.repeat(128)}x`,
		});
		expect(phoneLong.json.detail).toBe(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
		await env.setting('email_password', 'letterAndDigit', false);
	});

	it('minimum lengths up to 128 and the personal check', async () => {
		await env.setting('email_password', 'minLength', 128);
		await env.setting('email_password', 'minLength', 12);
		await env.setting('passwords', 'personalCheck', true);
		/** @param {string} password */
		const tryPassword = (password) =>
			env.visitor('POST', '/v1/sign-up/password', { email: 'jordan.blake@example.com', name: 'Jordan Blake', password });
		for (const password of ['my jordan password', 'jordan.blake the best', 'long password 1234', 'long qwerty password']) {
			const refused = await tryPassword(password);
			expect([code(refused), refused.json.rule], password).toEqual(['weak_password', 'personal']);
		}
		expect((await tryPassword('correct horse battery')).json.status).toBe('signed_in');
		await env.setting('passwords', 'personalCheck', false);
		await env.setting('email_password', 'minLength', 8);
	});

	it('the personal check is shared by both methods, also with Phone + password alone', async () => {
		await env.switchOn(['phone_password']);
		// the widgets get the rules of the methods that are on: no Email + password minimum, Phone + password's own
		const config = (await env.visitor('GET', '/v1/widget/config')).json.settings;
		expect(config.passwordMinLength).toBeNull();
		expect(Object.keys(config.phonePassword).sort()).toEqual(['forgotUrl', 'minLength', 'selfReset', 'signUp']);
		// the merchant cannot change Email + password's own settings while it is off, but the shared Passwords ones
		const cookie = await env.merchantSession();
		/** @param {string} key @param {unknown} value */
		const save = async (key, value) =>
			(await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/settings/${key}`, { value })).status;
		expect(await save('email_password.minLength', 10)).toBe(403);
		expect(await save('passwords.personalCheck', true)).toBe(204);
		/** @param {Record<string, unknown>} body */
		const phoneUp = (body) => env.visitor('POST', '/v1/sign-up/phone-password', body);
		const personal = await phoneUp({ phone: '+447700900341', name: 'Morgan Lee', password: 'morgan secret 1' });
		expect([code(personal), personal.json.rule]).toEqual(['weak_password', 'personal']);
		expect((await phoneUp({ phone: '+447700900341', name: 'Morgan Lee', password: 'quiet river 77' })).json.status).toBe(
			'signed_in',
		);
		await env.setting('passwords', 'personalCheck', false);
		await env.switchOn(['email_password', 'phone_password']);
	});
});
