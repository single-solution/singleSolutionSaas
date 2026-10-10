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
