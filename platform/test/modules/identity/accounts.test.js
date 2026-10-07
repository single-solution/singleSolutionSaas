import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { C } from '../../../src/modules/identity/schema.js';
import { boot, PASSWORD, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

/** @param {{ json: any }} res */
const codeOf = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

describe('the one sign-in page (PLAN 0.2, 0.8.2)', () => {
	it('opens the console of the login: admins and merchants on the same page; failures are one generic answer', async () => {
		const h = await boot();
		await h.owner();
		await h.merchant('sam@shop.test');
		const asAdmin = await h.client().post('/v1/auth/sign-in', { email: 'Owner@Portal.test', password: PASSWORD });
		expect(asAdmin.json).toMatchObject({
			status: 'ok',
			console: 'admin',
			admin: { email: 'owner@portal.test', role: 'owner' },
		});
		expect(asAdmin.setCookies[0]).toMatch(/^__Host-ss_admin=/);
		const asMerchant = await h.client().post('/v1/auth/sign-in', { email: 'sam@shop.test', password: PASSWORD });
		expect(asMerchant.json).toMatchObject({ status: 'ok', console: 'merchant', merchant: { email: 'sam@shop.test' } });
		expect(asMerchant.setCookies[0]).toMatch(/^__Host-ss_merchant=/);
		// the merchant's own view has no internal fields
		expect(asMerchant.json.merchant).not.toHaveProperty('suspension');

		const wrong = await h.client().post('/v1/auth/sign-in', { email: 'sam@shop.test', password: 'wrong password!!' });
		const unknown = await h.client().post('/v1/auth/sign-in', { email: 'nobody@shop.test', password: 'wrong password!!' });
		expect([wrong.status, codeOf(wrong)]).toEqual([401, 'invalid_credentials']);
		expect([unknown.status, unknown.json.detail]).toEqual([401, wrong.json.detail]);
		// sign-ins and failed sign-ins are in Activity (only for existing logins)
		expect((await h.activity('login.signed_in')).length).toBeGreaterThanOrEqual(2);
		const failed = await h.activity('login.sign_in_failed');
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({ actor: { type: 'merchant' }, target: { type: 'merchant' } });
	});

	it('throttles repeated failures of a login (as today: per account and per IP, progressive)', async () => {
		const h = await boot();
		await h.merchant('sam@shop.test');
		const c = h.client();
		for (let i = 0; i < 4; i += 1)
			expect((await c.post('/v1/auth/sign-in', { email: 'sam@shop.test', password: 'wrong password!!' })).status).toBe(401);
		const locked = await c.post('/v1/auth/sign-in', { email: 'sam@shop.test', password: 'wrong password!!' });
		expect(locked.status).toBe(429);
		expect(locked.headers.get('retry-after')).toBe('900');
		expect((await c.post('/v1/auth/sign-in', { email: 'sam@shop.test', password: PASSWORD })).status).toBe(429);
		h.clock.advance(901_000);
		expect((await c.post('/v1/auth/sign-in', { email: 'sam@shop.test', password: PASSWORD })).status).toBe(200);
	});

	it('Create admin works once, atomically, while no admin exists; it makes an Owner with name, e-mail and password', async () => {
		const h = await boot();
		expect((await h.call('GET', '/v1/auth/first-admin')).json).toEqual({ available: true });
		const body = (/** @type {string} */ email) => ({ name: 'Ada', email, password: PASSWORD });
		const results = await Promise.all([
			h.client().post('/v1/auth/first-admin', body('a@portal.test')),
			h.client().post('/v1/auth/first-admin', body('b@portal.test')),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
		const winner = /** @type {any} */ (results.find((r) => r.status === 201));
		expect(winner.json.admin).toMatchObject({ name: 'Ada', role: 'owner', status: 'active' });
		expect((await h.call('GET', '/v1/auth/first-admin')).json).toEqual({ available: false });
		expect((await h.client().post('/v1/auth/first-admin', body('c@portal.test'))).status).toBe(409);
		expect(await h.db.collection(C.admins).countDocuments({})).toBe(1);
		// weak passwords are refused
		const fresh = await boot();
		expect(
			(await fresh.client().post('/v1/auth/first-admin', { name: 'A', email: 'a@x.test', password: 'short' })).status,
		).toBe(422);
	});

	it('signs out: that session ends', async () => {
		const h = await boot();
		const { client } = await h.owner();
		expect((await client.get('/v1/me')).status).toBe(200);
		expect((await client.post('/v1/auth/sign-out')).status).toBe(204);
		expect((await client.get('/v1/me')).status).toBe(401);
	});
});

describe('two-step sign-in (PLAN 0.2)', () => {
	it('is optional: set up with a code, then asked after the password; recovery codes work once each', async () => {
		const h = await boot();
		const m = await h.merchant('sam@shop.test');
		const { secret, recoveryCodes } = await h.enableTwoStep(m.client);
		expect(recoveryCodes).toHaveLength(10);
		expect((await m.client.get('/v1/me')).json.merchant.twoStep).toEqual({ enabled: true, recoveryCodesLeft: 10 });
		// the stored secret is sealed with ENCRYPTION_KEY (never in clear)
		expect(JSON.stringify(await h.db.collection(C.merchants).findOne({ email: 'sam@shop.test' }))).not.toContain(secret);
		expect(await h.activity('two_step.turned_on')).toHaveLength(1);

		const c = h.client();
		const first = await c.post('/v1/auth/sign-in', { email: 'sam@shop.test', password: PASSWORD });
		expect(first.json).toEqual({ status: 'two_step_required', challenge: expect.any(String) });
		expect(first.setCookies).toEqual([]);
		const bad = await c.post('/v1/auth/sign-in/two-step', { challenge: first.json.challenge, code: '000000' });
		expect(bad.status).toBe(401);
		const okCode = await c.post('/v1/auth/sign-in/two-step', { challenge: first.json.challenge, code: h.code(secret) });
		expect(okCode.json).toMatchObject({ status: 'ok', console: 'merchant' });
		// the challenge is single use
		expect((await c.post('/v1/auth/sign-in/two-step', { challenge: first.json.challenge, code: h.code(secret) })).status).toBe(
			400,
		);

		const second = await h.client().post('/v1/auth/sign-in', { email: 'sam@shop.test', password: PASSWORD });
		const viaRecovery = await h
			.client()
			.post('/v1/auth/sign-in/two-step', { challenge: second.json.challenge, recoveryCode: recoveryCodes[0] });
		expect(viaRecovery.json.status).toBe('ok');
		expect(await h.activity('two_step.recovery_code_used')).toHaveLength(1);
		const third = await h.client().post('/v1/auth/sign-in', { email: 'sam@shop.test', password: PASSWORD });
		expect(
			(await h.client().post('/v1/auth/sign-in/two-step', { challenge: third.json.challenge, recoveryCode: recoveryCodes[0] }))
				.status,
		).toBe(401);
		expect((await m.client.get('/v1/me')).json.merchant.twoStep.recoveryCodesLeft).toBe(9);
	});

	it('a new set of codes (password + code) cancels the old set; turning off needs the password and a code', async () => {
		const h = await boot();
		const o = await h.owner();
		const { secret, recoveryCodes } = await h.enableTwoStep(o.client);
		expect((await o.client.post('/v1/me/two-step/recovery-codes', { password: PASSWORD })).status).toBe(422);
		expect(
			(await o.client.post('/v1/me/two-step/recovery-codes', { password: 'wrong password!!', code: h.code(secret) })).status,
		).toBe(401);
		const fresh = await o.client.post('/v1/me/two-step/recovery-codes', { password: PASSWORD, recoveryCode: recoveryCodes[1] });
		expect(fresh.json.recoveryCodes).toHaveLength(10);
		const signIn = await h.client().post('/v1/auth/sign-in', { email: o.email, password: PASSWORD });
		expect(
			(
				await h
					.client()
					.post('/v1/auth/sign-in/two-step', { challenge: signIn.json.challenge, recoveryCode: recoveryCodes[2] })
			).status,
		).toBe(401);
		h.clock.advance(30_000);
		expect((await o.client.post('/v1/me/two-step/off', { password: 'wrong password!!', code: h.code(secret) })).status).toBe(
			401,
		);
		const off = await o.client.post('/v1/me/two-step/off', { password: PASSWORD, recoveryCode: fresh.json.recoveryCodes[0] });
		expect(off.json).toEqual({ twoStep: { enabled: false, recoveryCodesLeft: 0 } });
		expect((await h.client().post('/v1/auth/sign-in', { email: o.email, password: PASSWORD })).json.status).toBe('ok');
		expect(await h.activity('two_step.turned_off')).toHaveLength(1);
	});

	it('Require two-step for admins: an admin without it reaches only the setup until it is on', async () => {
		const h = await boot({ settings: { security: { requireTwoStepForAdmins: true } } });
		const o = await h.owner();
		const blocked = await o.client.get('/v1/admin/merchants');
		expect([blocked.status, codeOf(blocked)]).toEqual([403, 'two_step_required']);
		expect((await o.client.get('/v1/me')).json.twoStepRequired).toBe(true);
		await h.enableTwoStep(o.client);
		expect((await o.client.get('/v1/admin/merchants')).status).toBe(200);
		expect((await o.client.get('/v1/me')).json.twoStepRequired).toBe(false);
		// merchants are not affected
		const m = await h.merchant('sam@shop.test');
		expect((await m.client.get(`/v1/merchants/${m.merchantId}/websites`)).status).toBe(200);
	});
});

describe('links (PLAN 0.2 Logins)', () => {
	it('setup links: single use, only while the login has no password; an invited admin also sets a name', async () => {
		const h = await boot();
		const o = await h.owner();
		const created = await o.client.post('/v1/admin/merchants', { name: 'Shop', ownerName: 'Sam', email: 'sam@shop.test' });
		expect(created.json.setup).toMatchObject({ mailed: true, link: null });
		const token = h.mailer.token('sam@shop.test', 'merchant_setup');
		expect(h.mailer.sent.at(-1)?.data.link).toMatch(/^https:\/\/portal\.test\/set-password#token=/);
		expect((await h.call('POST', '/v1/auth/set-password/check', { body: { token } })).json).toEqual({
			console: 'merchant',
			email: 'sam@shop.test',
			needsName: false,
		});
		// expires after 72 hours for merchants
		h.clock.advance(72 * 3_600_000 + 1);
		expect((await h.client().post('/v1/auth/set-password', { token, password: PASSWORD })).status).toBe(400);
		// the Owner's sign-in lasted 12 hours (Session length): sign in again
		expect((await o.client.get('/v1/me')).status).toBe(401);
		o.client.setCookie((await h.signIn(o.email)).cookie);
		const resent = await o.client.post(`/v1/admin/merchants/${created.json.merchant.merchantId}/setup-link`, {});
		expect(resent.json).toMatchObject({ mailed: true, link: null });
		const fresh = h.mailer.token('sam@shop.test', 'merchant_setup');
		const c = h.client();
		const set = await c.post('/v1/auth/set-password', { token: fresh, password: PASSWORD });
		expect(set.json).toMatchObject({ status: 'ok', console: 'merchant' });
		expect((await c.get('/v1/me')).json.merchant.setupPending).toBe(false);
		expect((await h.client().post('/v1/auth/set-password', { token: fresh, password: PASSWORD })).status).toBe(400);
		// no admin can get a link that replaces an existing password
		expect((await o.client.post(`/v1/admin/merchants/${created.json.merchant.merchantId}/setup-link`, {})).status).toBe(409);
		expect(await h.activity('merchant.setup_link_sent')).toHaveLength(2);

		const invited = await o.client.post('/v1/admin/admins', { email: 'sue@portal.test', role: 'support' });
		const inviteToken = h.mailer.token('sue@portal.test', 'admin_invite');
		expect((await h.call('POST', '/v1/auth/set-password/check', { body: { token: inviteToken } })).json.needsName).toBe(true);
		expect((await h.client().post('/v1/auth/set-password', { token: inviteToken, password: PASSWORD })).status).toBe(422);
		const accepted = await h.client().post('/v1/auth/set-password', { token: inviteToken, password: PASSWORD, name: 'Sue' });
		expect(accepted.json).toMatchObject({ console: 'admin', admin: { name: 'Sue', role: 'support', status: 'active' } });
		expect(invited.json.invite).toMatchObject({ mailed: true });
		// admin invites last 24 hours
		await o.client.post('/v1/admin/admins', { email: 'late@portal.test', role: 'finance' });
		const late = h.mailer.token('late@portal.test', 'admin_invite');
		h.clock.advance(23 * 3_600_000);
		expect((await h.call('POST', '/v1/auth/set-password/check', { body: { token: late } })).status).toBe(200);
		h.clock.advance(3_600_000 + 1);
		expect((await h.client().post('/v1/auth/set-password', { token: late, password: PASSWORD, name: 'L' })).status).toBe(400);
	});

	it('Forgot password: the same answer always; a 30-minute link for logins with a password; every session ends', async () => {
		const h = await boot();
		const m = await h.merchant('sam@shop.test');
		await h.owner();
		const before = h.mailer.sent.length;
		expect((await h.call('POST', '/v1/auth/forgot-password', { body: { email: 'nobody@shop.test' } })).status).toBe(202);
		expect(h.mailer.sent.length).toBe(before);
		expect((await h.call('POST', '/v1/auth/forgot-password', { body: { email: 'sam@shop.test' } })).json).toEqual({
			status: 'reset_sent',
		});
		const token = h.mailer.token('sam@shop.test', 'password_reset');
		expect(h.mailer.sent.at(-1)?.data.link).toMatch(/\/reset-password#token=/);
		expect(await h.activity('login.reset_link_issued')).toHaveLength(1);
		const next = 'another long passphrase';
		expect((await h.call('POST', '/v1/auth/reset-password', { body: { token, password: next } })).status).toBe(204);
		expect((await m.client.get('/v1/me')).status).toBe(401);
		expect((await h.call('POST', '/v1/auth/reset-password', { body: { token, password: next } })).status).toBe(400);
		await h.signIn('sam@shop.test', next);
		// a second link expires after 30 minutes
		await h.call('POST', '/v1/auth/forgot-password', { body: { email: 'sam@shop.test' } });
		const second = h.mailer.token('sam@shop.test', 'password_reset');
		h.clock.advance(30 * 60_000 + 1);
		expect((await h.call('POST', '/v1/auth/reset-password', { body: { token: second, password: next } })).status).toBe(400);
		// a login still waiting for its setup link gets no reset link
		const o = (await h.owner()).client;
		await o.post('/v1/admin/merchants', { name: 'New', ownerName: 'N', email: 'new@shop.test' });
		const count = h.mailer.sent.length;
		await h.call('POST', '/v1/auth/forgot-password', { body: { email: 'new@shop.test' } });
		expect(h.mailer.sent.length).toBe(count);
	});
});

describe('changing a login (PLAN 0.2)', () => {
	it('a new e-mail takes effect only once confirmed from the new address; the old address gets a notice', async () => {
		const h = await boot();
		const m = await h.merchant('sam@shop.test');
		expect((await m.client.post('/v1/me/email', { email: 'sam2@shop.test', password: 'wrong password!!' })).status).toBe(401);
		const asked = await m.client.post('/v1/me/email', { email: 'Sam2@Shop.test', password: PASSWORD });
		expect(asked.status).toBe(202);
		expect(h.mailer.sent.slice(-2).map((x) => [x.to, x.template])).toEqual([
			['sam2@shop.test', 'email_change_confirm'],
			['sam@shop.test', 'email_change_notice'],
		]);
		expect((await m.client.get('/v1/me')).json.merchant.email).toBe('sam@shop.test');
		const token = h.mailer.token('sam2@shop.test', 'email_change_confirm');
		expect((await h.call('POST', '/v1/auth/confirm-email', { body: { token } })).json).toEqual({
			console: 'merchant',
			email: 'sam2@shop.test',
		});
		expect((await m.client.get('/v1/me')).json.merchant.email).toBe('sam2@shop.test');
		await h.signIn('sam2@shop.test');
		await expect(h.signIn('sam@shop.test')).rejects.toThrow(/sign-in 401/);
		// the old address is free again, the new one taken
		expect(await h.db.collection(C.logins).findOne({ _id: /** @type {any} */ ('sam@shop.test') })).toBeNull();
		expect(await h.activity('login.email_changed')).toHaveLength(1);
	});

	it('refuses an e-mail used by another login, at the request and at the confirmation', async () => {
		const h = await boot();
		const a = await h.merchant('a@shop.test');
		await h.merchant('b@shop.test');
		const o = await h.owner();
		expect(codeOf(await a.client.post('/v1/me/email', { email: 'b@shop.test', password: PASSWORD }))).toBe('email_taken');
		expect(codeOf(await a.client.post('/v1/me/email', { email: o.email, password: PASSWORD }))).toBe('email_taken');
		await a.client.post('/v1/me/email', { email: 'c@shop.test', password: PASSWORD });
		const token = h.mailer.token('c@shop.test', 'email_change_confirm');
		await o.client.post('/v1/admin/merchants', { name: 'C', ownerName: 'C', email: 'c@shop.test' });
		const refused = await h.call('POST', '/v1/auth/confirm-email', { body: { token } });
		expect([refused.status, codeOf(refused)]).toEqual([409, 'email_taken']);
	});

	it('changing the password needs the current one (and a code while two-step is on) and ends every other session', async () => {
		const h = await boot();
		const m = await h.merchant('sam@shop.test');
		const other = await h.signIn('sam@shop.test');
		const { secret } = await h.enableTwoStep(m.client);
		const body = { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' };
		expect((await m.client.post('/v1/me/password', body)).status).toBe(422);
		expect((await m.client.post('/v1/me/password', { ...body, code: h.code(secret) })).status).toBe(204);
		expect((await m.client.get('/v1/me')).status).toBe(200);
		expect((await other.get('/v1/me')).status).toBe(401);
		expect(await h.activity('login.password_changed')).toHaveLength(1);
	});

	it('an admin edits their own name in My account; a merchant edits its business details in Account', async () => {
		const h = await boot();
		const o = await h.owner();
		expect((await o.client.patch('/v1/me', { name: 'Olivia O.' })).json).toMatchObject({ name: 'Olivia O.' });
		expect((await o.client.patch('/v1/me', { role: 'finance' })).status).toBe(422);
		const m = await h.merchant('sam@shop.test');
		const edited = await m.client.patch('/v1/me', { phone: '+92 300 1234567', country: 'pk', address: 'Lahore' });
		expect(edited.json).toMatchObject({ phone: '+92 300 1234567', country: 'PK', address: 'Lahore' });
		expect((await m.client.patch('/v1/me', { email: 'x@shop.test' })).status).toBe(422);
		expect((await m.client.patch('/v1/me', { country: 'XX' })).status).toBe(422);
		const entry = (await h.activity('merchant.edited'))[0];
		expect(entry?.after).toEqual({ fields: ['phone', 'address', 'country'] });
		expect(JSON.stringify(entry)).not.toContain('Lahore');
	});
});

describe('suspended merchants (PLAN 0.2 Suspend and resume)', () => {
	it('cannot sign in or use links; all their sessions end; resume restores', async () => {
		const h = await boot();
		const m = await h.merchant('sam@shop.test');
		const support = await h.admin('support');
		const suspended = await support.client.post(`/v1/admin/merchants/${m.merchantId}/suspend`, { reason: 'unpaid invoice' });
		expect(suspended.json).toMatchObject({ status: 'suspended', suspension: { reason: 'unpaid invoice' } });
		expect((await m.client.get('/v1/me')).status).toBe(401);
		const refused = await h.client().post('/v1/auth/sign-in', { email: 'sam@shop.test', password: PASSWORD });
		expect([refused.status, codeOf(refused)]).toEqual([403, 'merchant_suspended']);
		// Forgot password sends nothing while suspended
		const count = h.mailer.sent.length;
		await h.call('POST', '/v1/auth/forgot-password', { body: { email: 'sam@shop.test' } });
		expect(h.mailer.sent.length).toBe(count);
		expect(h.commerce.calls.at(-1)).toEqual({ merchantId: m.merchantId, status: 'suspended' });
		await support.client.post(`/v1/admin/merchants/${m.merchantId}/resume`, {});
		await h.signIn('sam@shop.test');
		expect(h.commerce.calls.at(-1)).toEqual({ merchantId: m.merchantId, status: 'active' });
	});
});
