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

describe('Admins (PLAN 0.8.2; Owner only)', () => {
	it('invites with an email and a role; resend or copy and correct the email only until the invite is accepted', async () => {
		const h = await boot();
		const o = await h.owner();
		const invited = await o.client.post('/v1/admin/admins', { email: 'Sue@Portal.test', role: 'support', password: PASSWORD });
		expect(invited.status).toBe(201);
		expect(invited.json.admin).toMatchObject({ email: 'sue@portal.test', role: 'support', status: 'invited', name: null });
		const adminId = invited.json.admin.adminId;
		// the email is unique across admins and merchants
		expect(
			codeOf(await o.client.post('/v1/admin/admins', { email: 'sue@portal.test', role: 'finance', password: PASSWORD })),
		).toBe('email_taken');
		await h.merchant('sam@shop.test');
		expect(
			codeOf(await o.client.post('/v1/admin/admins', { email: 'sam@shop.test', role: 'finance', password: PASSWORD })),
		).toBe('email_taken');
		expect(
			(await o.client.post('/v1/admin/admins', { email: 'x@portal.test', role: 'auditor', password: PASSWORD })).status,
		).toBe(422);

		// copy: shown once, only to that admin, logged
		const copied = await o.client.post(`/v1/admin/admins/${adminId}/invite`, { copy: true, password: PASSWORD });
		expect(copied.json.link).toMatch(/^https:\/\/portal\.test\/set-password#token=/);
		expect(await h.activity('admin.invite_link_copied')).toHaveLength(1);
		// a resend cancels the copied link
		const resent = await o.client.post(`/v1/admin/admins/${adminId}/invite`, {});
		expect(resent.json).toMatchObject({ mailed: true, link: null });
		const oldToken = decodeURIComponent(copied.json.link.split('#token=')[1]);
		expect((await h.call('POST', '/v1/auth/set-password/check', { body: { token: oldToken } })).status).toBe(400);

		// correct the invite email: the old address is free and the old link stops working
		const corrected = await o.client.patch(`/v1/admin/admins/${adminId}`, { email: 'susan@portal.test', password: PASSWORD });
		expect(corrected.json.email).toBe('susan@portal.test');
		expect(await h.db.collection(C.logins).findOne({ _id: /** @type {any} */ ('sue@portal.test') })).toBeNull();
		await o.client.post(`/v1/admin/admins/${adminId}/invite`, {});
		const token = h.mailer.token('susan@portal.test', 'admin_invite');
		await h.client().post('/v1/auth/set-password', { token, password: PASSWORD, name: 'Susan' });
		expect((await o.client.post(`/v1/admin/admins/${adminId}/invite`, {})).status).toBe(409);
		expect(
			(await o.client.patch(`/v1/admin/admins/${adminId}`, { email: 'other@portal.test', password: PASSWORD })).status,
		).toBe(409);
		const list = await o.client.get('/v1/admin/admins');
		const rows = [...list.json.items].sort((/** @type {any} */ a, /** @type {any} */ b) => a.email.localeCompare(b.email));
		expect(rows.map((/** @type {any} */ a) => [a.email, a.role, a.status])).toEqual([
			['owner@portal.test', 'owner', 'active'],
			['susan@portal.test', 'support', 'active'],
		]);
		expect(rows[1]).toMatchObject({ name: 'Susan', twoStep: { enabled: false }, lastSignInAt: expect.any(String) });
		expect(JSON.stringify(list.json)).not.toMatch(/passwordHash|recoveryHashes|totp/);
	});

	it('without email sending the invite is skipped and the link can be copied', async () => {
		const h = await boot({ mail: false });
		const o = await h.owner();
		const invited = await o.client.post('/v1/admin/admins', { email: 'sue@portal.test', role: 'support', password: PASSWORD });
		expect(invited.json.invite).toMatchObject({ mailed: false, link: null });
		const copied = await o.client.post('/v1/admin/admins', {
			email: 'fin@portal.test',
			role: 'finance',
			copy: true,
			password: PASSWORD,
		});
		expect(copied.json.invite.link).toMatch(/#token=/);
		expect(h.mailer.sent).toEqual([]);
	});

	it('a role change takes effect at once and ends every session of that admin; the last Owner stays', async () => {
		const h = await boot();
		const o = await h.owner();
		const sup = await h.admin('support');
		expect((await sup.client.get('/v1/admin/admins')).status).toBe(403);
		const changed = await o.client.patch(`/v1/admin/admins/${sup.adminId}`, { role: 'owner', password: PASSWORD });
		expect(changed.json.role).toBe('owner');
		expect((await sup.client.get('/v1/me')).status).toBe(401);
		const again = await h.signIn(sup.email);
		expect((await again.get('/v1/admin/admins')).status).toBe(200);
		expect(await h.activity('admin.role_changed')).toHaveLength(1);
		// nobody changes their own role; the last Owner cannot be demoted
		expect((await o.client.patch(`/v1/admin/admins/${o.adminId}`, { role: 'finance', password: PASSWORD })).status).toBe(409);
		await o.client.patch(`/v1/admin/admins/${sup.adminId}`, { role: 'finance', password: PASSWORD });
		const solo = await boot();
		const only = await solo.owner();
		const other = await solo.admin('owner');
		await other.client.patch(`/v1/admin/admins/${only.adminId}`, { role: 'support', password: PASSWORD });
		const last = await solo.signIn(only.email);
		const refused = await last.patch(`/v1/admin/admins/${other.adminId}`, { role: 'support', password: PASSWORD });
		expect([refused.status]).toEqual([403]); // a Support admin cannot manage admins at all
		const lastOwner = await solo.signIn(other.email);
		expect(codeOf(await lastOwner.patch(`/v1/admin/admins/${other.adminId}`, { role: 'support', password: PASSWORD }))).toBe(
			'conflict',
		);
	});

	it('removes an admin (never yourself, never the last Owner): sessions end, the email is free, Activity keeps the name', async () => {
		const h = await boot();
		const o = await h.owner();
		const fin = await h.admin('finance', 'fin@portal.test');
		expect((await o.client.del(`/v1/admin/admins/${o.adminId}`, { password: PASSWORD })).status).toBe(409);
		expect((await o.client.del(`/v1/admin/admins/${fin.adminId}`, { password: PASSWORD })).status).toBe(204);
		expect((await fin.client.get('/v1/me')).status).toBe(401);
		await expect(h.signIn('fin@portal.test')).rejects.toThrow(/sign-in 401/);
		expect(await h.db.collection(C.logins).findOne({ _id: /** @type {any} */ ('fin@portal.test') })).toBeNull();
		const removed = (await h.activity('admin.removed'))[0];
		expect(removed?.before).toEqual({ name: 'finance admin', role: 'finance' });
		expect(removed?.actor).toMatchObject({ type: 'admin', id: o.adminId, name: 'Olivia Owner' });
		// the finance admin's own entries keep their name
		const signedIn = (await h.activity('login.signed_in')).find((e) => e.actor.id === fin.adminId);
		expect(signedIn?.actor.name).toBe('finance admin');
		expect((await o.client.del(`/v1/admin/admins/${fin.adminId}`, { password: PASSWORD })).status).toBe(404);
		// the email can be invited again
		expect(
			(await o.client.post('/v1/admin/admins', { email: 'fin@portal.test', role: 'finance', password: PASSWORD })).status,
		).toBe(201);
	});

	it('an Owner turns off someone else’s two-step (email, Activity, recovery codes deleted), never their own', async () => {
		const h = await boot();
		const o = await h.owner();
		const sup = await h.admin('support');
		const m = await h.merchant('sam@shop.test');
		await h.enableTwoStep(sup.client);
		await h.enableTwoStep(m.client);
		// the Owner has two-step on too, so each confirmation carries a (single-use) recovery code
		const { recoveryCodes } = await h.enableTwoStep(o.client);
		const sure = () => ({ password: PASSWORD, recoveryCode: /** @type {string} */ (recoveryCodes.shift()) });
		expect((await o.client.post(`/v1/admin/admins/${o.adminId}/two-step/off`, sure())).status).toBe(409);
		expect((await sup.client.post(`/v1/admin/merchants/${m.merchantId}/two-step/off`, sure())).status).toBe(403);
		const offAdmin = await o.client.post(`/v1/admin/admins/${sup.adminId}/two-step/off`, sure());
		expect(offAdmin.json.twoStep).toEqual({ enabled: false, recoveryCodesLeft: 0 });
		const offMerchant = await o.client.post(`/v1/admin/merchants/${m.merchantId}/two-step/off`, sure());
		expect(offMerchant.json.twoStep).toEqual({ enabled: false, recoveryCodesLeft: 0 });
		expect(h.mailer.sent.filter((x) => x.template === 'two_step_off').map((x) => x.to)).toEqual([sup.email, 'sam@shop.test']);
		expect(await h.activity('two_step.turned_off_by_owner')).toHaveLength(2);
		expect((await o.client.post(`/v1/admin/merchants/${m.merchantId}/two-step/off`, sure())).status).toBe(409);
		expect((await h.client().post('/v1/auth/sign-in', { email: sup.email, password: PASSWORD })).json.status).toBe('ok');
	});
});
