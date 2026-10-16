/**
 * A password change ends the sessions made before it: users, sign-ins and staff views carry `passwordChangedAt`, and a
 * session made before a user's last password change stops working (My account, renewing), however the change was made.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** Short of the 15 minutes a sign-in lasts, so the sign-ins of a test stay valid. */
const STEP = 300_000;

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();
/** @param {string} method @param {string} path @param {unknown} [body] */
const server = (method, path, body) => env.call(method, path, { token: env.server, ...(body === undefined ? {} : { body }) });
/** My account with a sign-in. @param {string} signIn */
const me = (signIn) => env.visitor('GET', '/v1/me', undefined, signIn);
/** Renew with a refresh token. @param {string} refreshToken */
const renew = (refreshToken) => env.visitor('POST', '/v1/session/refresh', { refreshToken });
/** @param {string} email @param {string} password */
const signIn = (email, password) => env.visitor('POST', '/v1/sign-in/password', { email, password });

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => !['consents', 'approval', 'two_step', 'risk_checks'].includes(key)));
	await env.connectDatabase();
	await env.paste('notifications');
});
afterAll(async () => {
	await env.product.close();
});

describe('passwordChangedAt', () => {
	it('is the time the password was set or last changed, on the user and in the sign-in answers; null without a password', async () => {
		const at = new Date(env.now()).toISOString();
		const up = await env.visitor('POST', '/v1/sign-up/password', { email: 'ida@example.com', password: 'first password 1' });
		expect(up.json.user.passwordChangedAt).toBe(at);
		expect((await me(up.json.signIn)).json.passwordChangedAt).toBe(at);
		expect((await server('GET', `/v1/users/${up.json.user.id}`)).json.passwordChangedAt).toBe(at);
		env.advance(STEP);
		const again = await signIn('ida@example.com', 'first password 1');
		expect(again.json.user.passwordChangedAt).toBe(at);
		expect((await renew(again.json.refreshToken)).json.user.passwordChangedAt).toBe(at);
		// staff make a user without a password: none yet, then the time they set one
		const made = await server('POST', '/v1/users', { name: 'Kit Moss', email: 'kit@example.com' });
		expect(made.json.passwordChangedAt).toBeNull();
		env.advance(STEP);
		const set = await server('PATCH', `/v1/users/${made.json.id}`, { password: 'staff set password 1' });
		expect(set.json.passwordChangedAt).toBe(new Date(env.now()).toISOString());
		expect((await server('GET', `/v1/users/${made.json.id}`)).json.passwordChangedAt).toBe(set.json.passwordChangedAt);
	});
});

describe('a session made before the last password change', () => {
	it('ends at a password change from another device, while the device that changed it stays signed in', async () => {
		const first = await env.visitor('POST', '/v1/sign-up/password', { email: 'ona@example.com', password: 'first password 1' });
		env.advance(STEP);
		const second = await signIn('ona@example.com', 'first password 1');
		expect((await me(second.json.signIn)).status).toBe(200);
		env.advance(STEP);
		const changed = await env.visitor(
			'PUT',
			'/v1/me/password',
			{ current: 'first password 1', password: 'second password 2' },
			first.json.signIn,
		);
		expect(changed.status).toBe(204);
		const stamp = new Date(env.now()).toISOString();
		// the device that changed it keeps working, and renews
		expect((await me(first.json.signIn)).json.passwordChangedAt).toBe(stamp);
		const renewed = await renew(first.json.refreshToken);
		expect(renewed.status).toBe(200);
		expect(renewed.json.user.passwordChangedAt).toBe(stamp);
		expect((await me(renewed.json.signIn)).status).toBe(200);
		// the other one is signed out
		expect(code(await me(second.json.signIn))).toBe('signed_out');
		expect(code(await renew(second.json.refreshToken))).toBe('signed_out');
		// a session made after the change works
		const fresh = await signIn('ona@example.com', 'second password 2');
		expect((await me(fresh.json.signIn)).status).toBe(200);
		expect((await renew(fresh.json.refreshToken)).status).toBe(200);
	});

	it('is refused whichever way the password changed, with nothing else signing it out', async () => {
		const first = await env.visitor('POST', '/v1/sign-up/password', { email: 'eli@example.com', password: 'first password 1' });
		env.advance(STEP);
		const second = await signIn('eli@example.com', 'first password 1');
		expect((await me(first.json.signIn)).status).toBe(200);
		expect((await me(second.json.signIn)).status).toBe(200);
		env.advance(STEP);
		// the password changed by a way that signs nobody out (for example a move from another system)
		await (await env.store()).users.update(first.json.user.id, { passwordChangedAt: new Date(env.now()) });
		expect(code(await me(first.json.signIn))).toBe('signed_out');
		expect(code(await me(second.json.signIn))).toBe('signed_out');
		// renewing ends the session for good: it was not revoked by anything else
		expect(code(await renew(first.json.refreshToken))).toBe('signed_out');
		expect(code(await renew(second.json.refreshToken))).toBe('signed_out');
		expect(await (await env.store()).sessions.ofUser(first.json.user.id)).toEqual([]);
		// signing in again starts a session that works
		const fresh = await signIn('eli@example.com', 'first password 1');
		expect((await me(fresh.json.signIn)).status).toBe(200);
		expect((await renew(fresh.json.refreshToken)).status).toBe(200);
	});

	it('staff and shoppers alike: a password set by staff ends the user’s sessions', async () => {
		expect((await server('PUT', '/v1/roles/support', { name: 'Support', permissions: ['site:discount'] })).status).toBe(200);
		const made = await server('POST', '/v1/users', {
			name: 'Sam Staff',
			email: 'sam@example.com',
			role: 'support',
			password: 'staff first password 1',
		});
		const open = await signIn('sam@example.com', 'staff first password 1');
		expect((await me(open.json.signIn)).json.role).toBe('support');
		env.advance(STEP);
		const set = await server('PATCH', `/v1/users/${made.json.id}`, { password: 'staff second password 2' });
		expect(set.json.passwordChangedAt).toBe(new Date(env.now()).toISOString());
		expect(code(await me(open.json.signIn))).toBe('signed_out');
		expect(code(await renew(open.json.refreshToken))).toBe('signed_out');
		expect((await me((await signIn('sam@example.com', 'staff second password 2')).json.signIn)).status).toBe(200);
	});
});
