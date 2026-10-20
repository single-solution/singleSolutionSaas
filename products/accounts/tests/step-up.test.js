/**
 * SR-4-5: a stolen 15-minute sign-in token does not become a lasting session or a lasting takeover. A two-step setup
 * challenge is not a sign-in challenge; changing the password and turning two-step on or off need the current
 * password (or, for an account without one, a fresh code sent to its proven email address or phone number); wrong
 * current passwords count toward the lock like wrong sign-in passwords.
 */
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
/** The code Notifications was last asked to send. */
const lastCode = () => String(env.messages().at(-1)?.values.code);

const PASSWORD = 'correct horse battery';

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => !['consents', 'approval', 'risk_checks'].includes(key)));
	await env.connectDatabase();
	await env.paste('notifications');
});
afterAll(async () => {
	await env.product.close();
});

/** A user with a password, signed in. @param {string} email */
const withPassword = async (email) => {
	const up = await env.visitor('POST', '/v1/sign-up/password', { email, password: PASSWORD, name: 'Una Buyer' });
	expect(up.json.status).toBe('signed_in');
	return { email, token: /** @type {string} */ (up.json.signIn), id: /** @type {string} */ (up.json.user.id) };
};
/** A user without a password whose address was proven by a code, signed in. @param {string} email */
const withoutPassword = async (email) => {
	const made = await env.serverCall('POST', '/v1/users', { name: 'Sam Social', email });
	expect(made.status).toBe(201);
	env.advance(61_000);
	expect((await env.visitor('POST', '/v1/sign-in/email/code', { email })).status).toBe(202);
	const done = await env.visitor('POST', '/v1/sign-in/email', { email, code: lastCode() });
	expect(done.json.status).toBe('signed_in');
	return { email, token: /** @type {string} */ (done.json.signIn), id: /** @type {string} */ (done.json.user.id) };
};
/** @param {string} token */
const sessionCount = async (token) => (await env.visitor('GET', '/v1/me/sessions', undefined, token)).json.items.length;

describe('a two-step setup challenge is not a sign-in challenge', () => {
	it('the public two-step route refuses it, so a stolen token makes no new session; My account still enables with it', async () => {
		const una = await withPassword('una@example.com');
		const before = await sessionCount(una.token);
		const setupAnswer = await env.visitor('POST', '/v1/me/two-step/setup', { current: PASSWORD }, una.token);
		expect(setupAnswer.status).toBe(200);
		const guess = totpCode(setupAnswer.json.secret, env.now());
		const stolen = await env.visitor('POST', '/v1/sign-in/two-step', { challenge: setupAnswer.json.challenge, code: guess });
		expect(code(stolen)).toBe('code_invalid');
		expect(await sessionCount(una.token)).toBe(before);
		// the legitimate setup still works with the same challenge
		const enabled = await env.visitor(
			'POST',
			'/v1/me/two-step/enable',
			{ challenge: setupAnswer.json.challenge, code: guess },
			una.token,
		);
		expect(enabled.json.recoveryCodes).toHaveLength(10);
		// and a sign-in challenge is no setup challenge
		env.advance(60_000);
		const again = await env.visitor('POST', '/v1/sign-in/password', { email: una.email, password: PASSWORD });
		expect(again.json.status).toBe('two_step');
		expect(
			code(
				await env.visitor(
					'POST',
					'/v1/me/two-step/enable',
					{ challenge: again.json.challenge, code: totpCode(setupAnswer.json.secret, env.now()) },
					una.token,
				),
			),
		).toBe('code_invalid');
	});
});

describe('the password and two-step need the current password', () => {
	it('changing the password: no current password or a wrong one is refused, and wrong ones count toward the lock', async () => {
		const una = await withPassword('lena@example.com');
		const change = (/** @type {Record<string, unknown>} */ body) =>
			env.visitor('PUT', '/v1/me/password', { password: 'a new long password', ...body }, una.token);
		expect(code(await change({}))).toBe('sign_in_failed');
		for (let tries = 0; tries < 5; tries += 1) expect(code(await change({ current: 'wrong guess' }))).toBe('sign_in_failed');
		// the fifth wrong one locked the account: even the right password waits, here and at sign-in
		expect(code(await change({ current: PASSWORD }))).toBe('locked');
		expect(code(await env.visitor('POST', '/v1/sign-in/password', { email: una.email, password: PASSWORD }))).toBe('locked');
		// the lock ends after 15 minutes (the sign-in token has run out by then: sign in again)
		env.advance(16 * 60_000);
		const again = await env.visitor('POST', '/v1/sign-in/password', { email: una.email, password: PASSWORD });
		expect(again.json.status).toBe('signed_in');
		const changed = await env.visitor(
			'PUT',
			'/v1/me/password',
			{ password: 'a new long password', current: PASSWORD },
			again.json.signIn,
		);
		expect(changed.status).toBe(204);
		const signedIn = await env.visitor('POST', '/v1/sign-in/password', { email: una.email, password: 'a new long password' });
		expect(signedIn.json.status).toBe('signed_in');
	});

	it('turning two-step on or off: the current password is asked; off also needs a code', async () => {
		const una = await withPassword('tara@example.com');
		expect(code(await env.visitor('POST', '/v1/me/two-step/setup', {}, una.token))).toBe('sign_in_failed');
		expect(code(await env.visitor('POST', '/v1/me/two-step/setup', { current: 'nope' }, una.token))).toBe('sign_in_failed');
		const setupAnswer = await env.visitor('POST', '/v1/me/two-step/setup', { current: PASSWORD }, una.token);
		expect(setupAnswer.status).toBe(200);
		const on = await env.visitor(
			'POST',
			'/v1/me/two-step/enable',
			{ challenge: setupAnswer.json.challenge, code: totpCode(setupAnswer.json.secret, env.now()) },
			una.token,
		);
		expect(on.status).toBe(200);
		env.advance(60_000);
		const off = (/** @type {Record<string, unknown>} */ body) =>
			env.visitor(
				'POST',
				'/v1/me/two-step/disable',
				{ code: totpCode(setupAnswer.json.secret, env.now()), ...body },
				una.token,
			);
		expect(code(await off({}))).toBe('sign_in_failed');
		expect(code(await off({ current: 'nope' }))).toBe('sign_in_failed');
		expect((await off({ current: PASSWORD })).status).toBe(204);
	});
});

describe('an account without a password proves itself with a fresh code', () => {
	it('sends the code to the proven address; the password is set with it once; a wrong or reused code is refused', async () => {
		const sam = await withoutPassword('sam@example.com');
		const set = (/** @type {Record<string, unknown>} */ body) =>
			env.visitor('PUT', '/v1/me/password', { password: 'a brand new password', ...body }, sam.token);
		expect(code(await set({}))).toBe('code_invalid');
		env.advance(61_000);
		const asked = await env.visitor('POST', '/v1/me/confirm-code', {}, sam.token);
		expect(asked.status).toBe(202);
		expect(asked.json).toMatchObject({ via: 'email' });
		expect(env.messages().at(-1)).toMatchObject({ template: 'accounts.email_code', to: { email: 'sam@example.com' } });
		const sent = lastCode();
		// one code at a time: asking again at once waits
		expect(code(await env.visitor('POST', '/v1/me/confirm-code', {}, sam.token))).toBe('code_cooldown');
		expect(code(await set({ confirmCode: sent === '000000' ? '111111' : '000000' }))).toBe('code_invalid');
		expect((await set({ confirmCode: sent })).status).toBe(204);
		expect(code(await set({ confirmCode: sent }))).toBe('sign_in_failed');
		expect(
			(await env.visitor('POST', '/v1/sign-in/password', { email: sam.email, password: 'a brand new password' })).json.status,
		).toBe('signed_in');
		// with a password the code route is not needed
		expect(code(await env.visitor('POST', '/v1/me/confirm-code', {}, sam.token))).toBe('conflict');
	});

	it('two-step is turned on with a fresh code too', async () => {
		const ivy = await withoutPassword('ivy@example.com');
		expect(code(await env.visitor('POST', '/v1/me/two-step/setup', {}, ivy.token))).toBe('code_invalid');
		env.advance(61_000);
		expect((await env.visitor('POST', '/v1/me/confirm-code', {}, ivy.token)).status).toBe(202);
		const setupAnswer = await env.visitor('POST', '/v1/me/two-step/setup', { confirmCode: lastCode() }, ivy.token);
		expect(setupAnswer.status).toBe(200);
		const on = await env.visitor(
			'POST',
			'/v1/me/two-step/enable',
			{ challenge: setupAnswer.json.challenge, code: totpCode(setupAnswer.json.secret, env.now()) },
			ivy.token,
		);
		expect(on.status).toBe(200);
		// turning it off asks for a new code and the app's code
		env.advance(61_000);
		const off = (/** @type {Record<string, unknown>} */ body) =>
			env.visitor(
				'POST',
				'/v1/me/two-step/disable',
				{ code: totpCode(setupAnswer.json.secret, env.now()), ...body },
				ivy.token,
			);
		expect(code(await off({}))).toBe('code_invalid');
		expect((await env.visitor('POST', '/v1/me/confirm-code', {}, ivy.token)).status).toBe(202);
		expect((await off({ confirmCode: lastCode() })).status).toBe(204);
	});

	it('an account whose address and number nobody proved has nothing to send a code to', async () => {
		const ben = await withoutPassword('ben@example.com');
		const store = await env.store();
		await store.users.update(ben.id, { emailVerified: false });
		env.advance(61_000);
		expect(code(await env.visitor('POST', '/v1/me/confirm-code', {}, ben.token))).toBe('conflict');
		expect(code(await env.visitor('PUT', '/v1/me/password', { password: 'a brand new password' }, ben.token))).toBe(
			'code_invalid',
		);
	});
});
