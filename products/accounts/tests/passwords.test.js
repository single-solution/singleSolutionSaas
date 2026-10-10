/**
 * Passwords from older systems and the password options (PLAN 0.8.10 A1, A2, A9).
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

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

/** A peppered PBKDF2 hash as the older system stored it. @param {string} password @param {string} pepper */
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

describe('A1: legacy password hashes', () => {
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
		// no Unicode normalisation on this path: the composed é is not the decomposed one
		const password = 'café secret 12';
		const hash = pbkdf2Hash(password, 'store-auth-secret');
		await importHash(id, hash);
		expect(code(await signIn('pbkdf2@example.com', password))).toBe('sign_in_failed');
		await env.connect('legacy_pepper', 'store-auth-secret');
		const listed = await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/connections`);
		expect(listed.text).not.toContain('store-auth-secret');
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
			pbkdf2Hash('pw', 'store-auth-secret').replace(/^pbkdf2\$1000/, 'pbkdf2$9000000'),
			'pbkdf2$1000$AAAA$AAAA',
		]) {
			await importHash(id, hash);
			expect(code(await signIn('odd@example.com', 'pw'))).toBe('sign_in_failed');
		}
	});

	it('the current password of My account accepts a legacy hash too', async () => {
		const up = await env.visitor('POST', '/v1/sign-up/password', { email: 'change@example.com', password: 'first password 1' });
		await importHash(up.json.user.id, bcrypt.hashSync('legacy current 1', 4));
		const changed = await env.visitor(
			'PUT',
			'/v1/me/password',
			{ current: 'legacy current 1', password: 'brand new password 2' },
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
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', { phone: '+923001110000', password: 'x' }))).toBe(
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
		await env.setting('phone', 'defaultCallingCode', '+92');
		await env.setting('phone', 'trunkPrefix', '0');
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', { phone: 'nope', password: 'abc12345' }))).toBe(
			'validation_failed',
		);
		const up = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: '0300 1110000',
			password: 'abc12345',
			name: 'Sana',
			remember: true,
		});
		expect(up.json).toMatchObject({
			status: 'signed_in',
			user: { phone: '+923001110000', phoneVerified: false, name: 'Sana' },
		});
		expect(
			code(await env.visitor('POST', '/v1/sign-up/phone-password', { phone: '+923001110000', password: 'abc12345' })),
		).toBe('already_exists');
		const sessions = await env.visitor('GET', '/v1/me/sessions', undefined, up.json.signIn);
		expect(sessions.json.items[0].method).toBe('phone_password');
		expect(code(await phoneSignIn({ phone: '03001110000', password: 'wrong one' }))).toBe('sign_in_failed');
		expect(code(await phoneSignIn({ phone: '03009999999', password: 'abc12345' }))).toBe('sign_in_failed');
		expect((await phoneSignIn({ phone: '03001110000', password: 'abc12345' })).json.status).toBe('signed_in');
	});

	it('uses its own password rules: length 6 to 128 and a letter with a digit', async () => {
		await env.setting('phone_password', 'minLength', 6);
		await env.setting('phone_password', 'letterAndDigit', true);
		const refused = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: '+923001110001',
			password: 'onlyletters',
		});
		expect(code(refused)).toBe('weak_password');
		expect(refused.json.detail).toMatch(/letter and one digit/);
		expect(code(await env.visitor('POST', '/v1/sign-up/phone-password', { phone: '+923001110001', password: 'a1b2' }))).toBe(
			'weak_password',
		);
		const ok = await env.visitor('POST', '/v1/sign-up/phone-password', { phone: '+923001110001', password: 'a1b2c3' });
		expect(ok.json.status).toBe('signed_in');
		// My account changes the password of a phone user with the same rules
		expect(code(await env.visitor('PUT', '/v1/me/password', { current: 'a1b2c3', password: 'zzzzzz' }, ok.json.signIn))).toBe(
			'weak_password',
		);
		expect(
			(await env.visitor('PUT', '/v1/me/password', { current: 'a1b2c3', password: 'new1pass' }, ok.json.signIn)).status,
		).toBe(204);
		expect((await phoneSignIn({ phone: '+923001110001', password: 'new1pass' })).json.status).toBe('signed_in');
	});

	it('Forgot password sends a code through Notifications; the code sets a new password and signs devices out', async () => {
		const before = env.messages().length;
		expect((await env.visitor('POST', '/v1/password/phone/forgot', { phone: '+923009999999' })).status).toBe(202);
		expect(env.messages().length).toBe(before);
		expect((await env.visitor('POST', '/v1/password/phone/forgot', { phone: '03001110000' })).status).toBe(202);
		const sent = env.messages().at(-1);
		expect(sent).toMatchObject({ channel: 'sms', template: 'accounts.phone_code', to: { phone: '+923001110000' } });
		expect(code(await env.visitor('POST', '/v1/password/phone/forgot', { phone: '03001110000' }))).toBe('code_cooldown');
		const signedIn = await phoneSignIn({ phone: '+923001110000', password: 'abc12345' });
		expect(
			code(
				await env.visitor('POST', '/v1/password/phone/reset', {
					phone: '+923001110000',
					code: sent.values.code === '000000' ? '111111' : '000000',
					password: 'n3w password',
				}),
			),
		).toBe('code_invalid');
		expect(
			code(
				await env.visitor('POST', '/v1/password/phone/reset', {
					phone: '+923009999999',
					code: sent.values.code,
					password: 'x1',
				}),
			),
		).toBe('code_invalid');
		const reset = await env.visitor('POST', '/v1/password/phone/reset', {
			phone: '+923001110000',
			code: sent.values.code,
			password: 'n3w password',
		});
		expect(reset.status).toBe(204);
		expect(code(await env.visitor('GET', '/v1/me', undefined, signedIn.json.signIn))).toBe('signed_out');
		expect((await phoneSignIn({ phone: '+923001110000', password: 'n3w password' })).json.status).toBe('signed_in');
		expect(
			code(
				await env.visitor('POST', '/v1/password/phone/reset', {
					phone: '+923001110000',
					code: sent.values.code,
					password: 'n3w password',
				}),
			),
		).toBe('code_invalid');
	});

	it('with Forgot password off, the reset routes refuse and the widget config names the page', async () => {
		await env.setting('phone_password', 'selfReset', 'off');
		await env.setting('phone_password', 'forgotUrl', 'https://wa.me/923001234567');
		expect(code(await env.visitor('POST', '/v1/password/phone/forgot', { phone: '+923001110000' }))).toBe('self_reset_off');
		expect(
			code(await env.visitor('POST', '/v1/password/phone/reset', { phone: '+923001110000', code: '1', password: 'x' })),
		).toBe('self_reset_off');
		const config = await env.visitor('GET', '/v1/widget/config');
		expect(config.json.settings.phonePassword).toMatchObject({ selfReset: 'off', forgotUrl: 'https://wa.me/923001234567' });
		await env.setting('phone_password', 'selfReset', 'code');
	});
});

describe('A9: password and lock options', () => {
	it('a growing lock: free failures, then 1, 2, 4 … up to 60 minutes; a good password resets it', async () => {
		await env.setting('email_password', 'lockMode', 'growing');
		await env.setting('email_password', 'maxAttempts', 4);
		await env.visitor('POST', '/v1/sign-up/password', { email: 'grow@example.com', password: 'growing password 1' });
		for (let i = 0; i < 4; i += 1) expect(code(await signIn('grow@example.com', 'bad'))).toBe('sign_in_failed');
		expect(code(await signIn('grow@example.com', 'bad'))).toBe('sign_in_failed');
		const locked = await signIn('grow@example.com', 'growing password 1');
		expect(code(locked)).toBe('locked');
		expect(Date.parse(locked.json.lockedUntil) - env.now()).toBe(60_000);
		env.advance(60_000);
		expect(code(await signIn('grow@example.com', 'bad'))).toBe('sign_in_failed');
		expect(Date.parse((await signIn('grow@example.com', 'x')).json.lockedUntil) - env.now()).toBe(120_000);
		for (let level = 3; level <= 8; level += 1) {
			env.advance(3_600_000);
			await signIn('grow@example.com', 'bad');
		}
		expect(Date.parse((await signIn('grow@example.com', 'x')).json.lockedUntil) - env.now()).toBe(3_600_000);
		env.advance(3_600_000);
		expect((await signIn('grow@example.com', 'growing password 1')).json.status).toBe('signed_in');
		expect(code(await signIn('grow@example.com', 'bad'))).toBe('sign_in_failed');
		expect((await signIn('grow@example.com', 'growing password 1')).json.status).toBe('signed_in');
		await env.setting('email_password', 'lockMode', 'fixed');
	});

	it('a network limit per address, minimum lengths up to 128 and the personal check', async () => {
		await env.setting('email_password', 'networkLimit', 3);
		env.setNetwork('198.51.100.7');
		for (let i = 0; i < 3; i += 1) expect(code(await signIn('limit@example.com', 'x'))).toBe('sign_in_failed');
		expect(code(await signIn('limit@example.com', 'x'))).toBe('rate_limited');
		// another address from the same network still gets its tries
		expect(code(await signIn('other@example.com', 'x'))).toBe('sign_in_failed');
		env.advance(15 * 60_000);
		expect(code(await signIn('limit@example.com', 'x'))).toBe('sign_in_failed');
		env.setNetwork(null);
		await env.setting('email_password', 'networkLimit', 0);
		await env.setting('email_password', 'minLength', 128);
		await env.setting('email_password', 'minLength', 12);
		await env.setting('email_password', 'personalCheck', true);
		/** @param {string} password */
		const tryPassword = (password) =>
			env.visitor('POST', '/v1/sign-up/password', { email: 'farhan.ali@example.com', name: 'Farhan Ali', password });
		for (const password of ['my farhan password', 'farhan.ali the best', 'long password 1234', 'long qwerty password'])
			expect(code(await tryPassword(password)), password).toBe('weak_password');
		expect((await tryPassword('correct horse battery')).json.status).toBe('signed_in');
		await env.setting('email_password', 'personalCheck', false);
		await env.setting('email_password', 'minLength', 8);
	});
});
