import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

const PASSWORD = 'correct horse battery';

describe('merchant accounts', () => {
	it('signup → verify → login → MFA → invite → accept → website-scoped access', async () => {
		const h = await boot();
		const { client: owner, merchantId, userId } = await h.signupOwner('Owner@Example.com', { merchantName: 'Acme' });
		expect(merchantId).toMatch(/^mer_/);
		expect(h.commerce.calls).toEqual([]);

		const me = await owner.get('/v1/me');
		expect(me.status).toBe(200);
		expect(me.json).toMatchObject({
			kind: 'merchant',
			user: { userId, email: 'owner@example.com', mfa: { enabled: false } },
			merchantId,
			memberships: [{ merchantId, name: 'Acme', status: 'active', roles: ['owner'] }],
		});

		// the verification link is single use
		expect(
			(await h.call('POST', '/v1/auth/merchant/verify-email', { body: { token: h.mailer.token('owner@example.com') } }))
				.status,
		).toBe(400);

		// enrol TOTP
		const enrol = await owner.post('/v1/me/mfa/enrol');
		expect(enrol.status).toBe(200);
		expect(enrol.json.uri).toMatch(/^otpauth:\/\/totp\/Single%20Solution:owner%40example.com\?secret=/);
		expect((await owner.post('/v1/me/mfa/enrol')).status).toBe(200); // restart allowed until confirmed
		const secret = (await owner.post('/v1/me/mfa/enrol')).json.secret;
		expect((await owner.post('/v1/me/mfa/confirm', { code: '000000' })).status).toBe(401);
		h.clock.advance(30_000);
		const confirm = await owner.post('/v1/me/mfa/confirm', { code: h.code(secret) });
		expect(confirm.status).toBe(200);
		expect(confirm.json.recoveryCodes).toHaveLength(10);
		expect((await owner.post('/v1/me/mfa/enrol')).status).toBe(409);
		expect((await owner.get('/v1/me')).json.user.mfa).toEqual({ enabled: true, recoveryCodesLeft: 10 });

		// login now needs the second factor
		const fresh = h.client();
		const step1 = await fresh.post('/v1/auth/merchant/login', { email: 'owner@example.com', password: PASSWORD });
		expect(step1.status).toBe(200);
		expect(step1.json.status).toBe('mfa_required');
		expect(fresh.cookie).toBe('');
		expect((await fresh.post('/v1/auth/merchant/login/mfa', { challenge: step1.json.challenge, code: '123456' })).status).toBe(
			401,
		);
		const reused = h.code(secret); // the step used at confirmation cannot be replayed
		expect((await fresh.post('/v1/auth/merchant/login/mfa', { challenge: step1.json.challenge, code: reused })).status).toBe(
			401,
		);
		h.clock.advance(30_000);
		const step2 = await fresh.post('/v1/auth/merchant/login/mfa', { challenge: step1.json.challenge, code: h.code(secret) });
		expect(step2.status).toBe(200);
		expect(step2.json).toMatchObject({ status: 'ok', merchantId });
		expect(fresh.cookie).toMatch(/^__Host-ss_merchant=/);
		expect(
			(await fresh.post('/v1/auth/merchant/login/mfa', { challenge: step1.json.challenge, code: h.code(secret) })).status,
		).toBe(400);

		// recovery code path (single use)
		const viaRecovery = h.client();
		const r1 = await viaRecovery.post('/v1/auth/merchant/login', { email: 'owner@example.com', password: PASSWORD });
		const recovery = confirm.json.recoveryCodes[0];
		expect(
			(await viaRecovery.post('/v1/auth/merchant/login/mfa', { challenge: r1.json.challenge, recoveryCode: recovery })).status,
		).toBe(200);
		const r2 = await h.client().post('/v1/auth/merchant/login', { email: 'owner@example.com', password: PASSWORD });
		expect(
			(await h.call('POST', '/v1/auth/merchant/login/mfa', { body: { challenge: r2.json.challenge, recoveryCode: recovery } }))
				.status,
		).toBe(401);
		expect(
			(
				await h.call('POST', '/v1/auth/merchant/login/mfa', {
					body: { challenge: r2.json.challenge, code: '1', recoveryCode: recovery },
				})
			).status,
		).toBe(422);

		// a website, then an invite scoped to it
		const site = await owner.post(`/v1/merchants/${merchantId}/websites`, { domain: 'https://Shop.Example.com/home' });
		expect(site.status).toBe(201);
		const websiteId = site.json.website.websiteId;
		const twinId = site.json.twin.websiteId;
		const other = await owner.post(`/v1/merchants/${merchantId}/websites`, { domain: 'other.example.com' });
		const otherId = other.json.website.websiteId;

		const invite = await owner.post(`/v1/merchants/${merchantId}/team/invites`, {
			email: 'Dev@Example.com',
			grants: [{ websiteId, roles: ['developer'] }],
		});
		expect(invite.status).toBe(201);
		expect(invite.json).toMatchObject({ email: 'dev@example.com', roles: [], status: 'pending' });
		expect(JSON.stringify(invite.json)).not.toMatch(/token/i);
		const inviteToken = h.mailer.token('dev@example.com', 'invite');
		expect(inviteToken).toHaveLength(43);

		const bad = await h.call('POST', '/v1/auth/invites/accept', { body: { token: inviteToken, password: 'short' } });
		expect(bad.status).toBe(422);
		const dev = h.client();
		const accepted = await dev.post('/v1/auth/invites/accept', {
			token: inviteToken,
			password: 'developer password',
			name: 'Dev',
		});
		expect(accepted.status).toBe(200);
		expect(accepted.json).toMatchObject({ status: 'ok', merchantId });
		expect(
			(await h.call('POST', '/v1/auth/invites/accept', { body: { token: inviteToken, password: 'developer password' } }))
				.status,
		).toBe(400);

		// scoped access: the granted website (and its twin), nothing else
		const visible = await dev.get(`/v1/merchants/${merchantId}/websites`);
		expect(visible.json.items.map((/** @type {any} */ w) => w.websiteId).sort()).toEqual([websiteId, twinId].sort());
		expect((await dev.get(`/v1/merchants/${merchantId}/websites/${websiteId}`)).status).toBe(200);
		expect((await dev.get(`/v1/merchants/${merchantId}/websites/${twinId}`)).status).toBe(200);
		expect((await dev.get(`/v1/merchants/${merchantId}/websites/${otherId}`)).status).toBe(403);
		const key = await dev.post(`/v1/merchants/${merchantId}/websites/${twinId}/keys`, {
			kind: 'pk',
			scopes: ['events.write'],
		});
		expect(key.status).toBe(201);
		expect(key.json.env).toBe('test');
		expect(
			(await dev.post(`/v1/merchants/${merchantId}/websites/${otherId}/keys`, { kind: 'pk', scopes: ['elements.read'] }))
				.status,
		).toBe(403);
		expect((await dev.del(`/v1/merchants/${merchantId}/websites/${websiteId}`)).status).toBe(403);
		expect((await dev.get(`/v1/merchants/${merchantId}`)).status).toBe(403);
		expect((await dev.get(`/v1/merchants/${merchantId}/team`)).status).toBe(403);
		expect((await dev.post(`/v1/merchants/${merchantId}/websites`, { domain: 'third.example.com' })).status).toBe(403);

		// owner widens the grant to merchant-wide editor; the live session picks it up (sessionActor port)
		const team = await owner.get(`/v1/merchants/${merchantId}/team`);
		const devId = team.json.members.find((/** @type {any} */ m) => m.email === 'dev@example.com').userId;
		const updated = await owner.patch(`/v1/merchants/${merchantId}/team/members/${devId}`, { roles: ['admin'] });
		expect(updated.status).toBe(200);
		expect((await dev.get(`/v1/merchants/${merchantId}/team`)).status).toBe(200);
		expect((await dev.get(`/v1/merchants/${merchantId}/websites/${otherId}`)).status).toBe(200);

		// removal ends access at once
		expect((await owner.del(`/v1/merchants/${merchantId}/team/members/${devId}`)).status).toBe(204);
		expect((await dev.get(`/v1/merchants/${merchantId}/websites`)).status).toBe(401);

		const audit = await h.portal.shared.audit.list({ merchantId });
		expect(audit.map((e) => e.action)).toEqual(
			expect.arrayContaining([
				'merchant.created',
				'website.created',
				'team.invited',
				'team.invite_accepted',
				'team.member_updated',
				'team.member_removed',
				'key.issued',
			]),
		);
	});

	it('signup does not reveal existing accounts and needs a mailer', async () => {
		const h = await boot();
		await h.signupOwner('a@example.com');
		const again = await h.call('POST', '/v1/auth/merchant/signup', {
			body: { email: 'a@example.com', password: 'another long password', merchantName: 'X' },
		});
		expect([again.status, again.json]).toEqual([202, { status: 'verification_sent' }]);
		expect(h.mailer.sent.at(-1)?.template).toBe('account_exists');

		// two pending signups for one address: the first verified wins, the second conflicts
		await h.call('POST', '/v1/auth/merchant/signup', {
			body: { email: 'b@example.com', password: PASSWORD, merchantName: 'B1' },
		});
		const t1 = h.mailer.token('b@example.com', 'verify_email');
		await h.call('POST', '/v1/auth/merchant/signup', {
			body: { email: 'b@example.com', password: PASSWORD, merchantName: 'B2' },
		});
		const t2 = h.mailer.token('b@example.com', 'verify_email');
		expect((await h.call('POST', '/v1/auth/merchant/verify-email', { body: { token: t2 } })).status).toBe(201);
		expect((await h.call('POST', '/v1/auth/merchant/verify-email', { body: { token: t1 } })).status).toBe(409);

		// expired verification
		await h.call('POST', '/v1/auth/merchant/signup', {
			body: { email: 'c@example.com', password: PASSWORD, merchantName: 'C' },
		});
		h.clock.advance(25 * 3600_000);
		expect(
			(await h.call('POST', '/v1/auth/merchant/verify-email', { body: { token: h.mailer.token('c@example.com') } })).status,
		).toBe(400);

		const invalid = await h.call('POST', '/v1/auth/merchant/signup', {
			body: { email: 'nope', password: 'x', merchantName: '' },
		});
		expect(invalid.status).toBe(422);
		expect(invalid.json.errors.map((/** @type {any} */ e) => e.path).sort()).toEqual(['/email', '/merchantName', '/password']);

		h.mailer.setFailing(true);
		expect(
			(
				await h.call('POST', '/v1/auth/merchant/signup', {
					body: { email: 'd@example.com', password: PASSWORD, merchantName: 'D' },
				})
			).status,
		).toBe(202);
		expect(h.entries.some((e) => e.msg === 'mail could not be sent')).toBe(true);
		h.mailer.setAvailable(false);
		const down = await h.call('POST', '/v1/auth/merchant/signup', {
			body: { email: 'e@example.com', password: PASSWORD, merchantName: 'E' },
		});
		expect([down.status, down.headers.get('retry-after')]).toEqual([503, '3600']);
		expect((await h.call('POST', '/v1/auth/merchant/password-reset', { body: { email: 'a@example.com' } })).status).toBe(503);
	});

	it('locks accounts after repeated failures, with progressive lockouts, and resets clear them', async () => {
		const h = await boot();
		await h.signupOwner('lock@example.com');
		const attempt = (password = 'wrong password!!') =>
			h.call('POST', '/v1/auth/merchant/login', { body: { email: 'lock@example.com', password } });
		for (let i = 0; i < 4; i += 1) expect((await attempt()).status).toBe(401);
		const locked = await attempt();
		expect(locked.status).toBe(429);
		expect(Number(locked.headers.get('retry-after'))).toBe(900);
		expect((await attempt(PASSWORD)).status).toBe(429); // even the right password while locked
		h.clock.advance(15 * 60_000 + 1000);
		expect((await attempt(PASSWORD)).status).toBe(200);

		// unknown accounts fail identically
		const unknown = await h.call('POST', '/v1/auth/merchant/login', {
			body: { email: 'ghost@example.com', password: 'whatever!!' },
		});
		expect([unknown.status, unknown.json.detail]).toEqual([401, 'The e-mail or password is incorrect.']);

		// reset: request (same answer for unknown accounts), single-use 30-minute token, sessions revoked
		const session = h.client();
		await session.post('/v1/auth/merchant/login', { email: 'lock@example.com', password: PASSWORD });
		expect((await session.get('/v1/me')).status).toBe(200);
		for (let i = 0; i < 5; i += 1) await attempt();
		expect((await attempt(PASSWORD)).status).toBe(429);
		expect((await h.call('POST', '/v1/auth/merchant/password-reset', { body: { email: 'ghost@example.com' } })).status).toBe(
			202,
		);
		expect(h.mailer.sent.filter((m) => m.to === 'ghost@example.com')).toHaveLength(0);
		await h.call('POST', '/v1/auth/merchant/password-reset', { body: { email: 'lock@example.com' } });
		const first = h.mailer.token('lock@example.com', 'password_reset');
		await h.call('POST', '/v1/auth/merchant/password-reset', { body: { email: 'lock@example.com' } });
		const second = h.mailer.token('lock@example.com', 'password_reset');
		expect(h.mailer.sent.at(-1)?.data.link).toMatch(/^https:\/\/portal\.test\/reset-password#token=/);
		const confirm = (/** @type {string} */ token, password = 'brand new password') =>
			h.call('POST', '/v1/auth/merchant/password-reset/confirm', { body: { token, password } });
		expect((await confirm(first)).status).toBe(400); // superseded
		expect((await confirm(second, 'short')).status).toBe(422);
		expect((await confirm(second)).status).toBe(204);
		expect((await confirm(second)).status).toBe(400); // single use
		expect((await session.get('/v1/me')).status).toBe(401); // sessions revoked
		expect((await attempt('brand new password')).status).toBe(200); // lockout cleared
		expect((await attempt(PASSWORD)).status).toBe(401);

		await h.call('POST', '/v1/auth/merchant/password-reset', { body: { email: 'lock@example.com' } });
		h.clock.advance(31 * 60_000);
		expect((await confirm(h.mailer.token('lock@example.com', 'password_reset'))).status).toBe(400); // expired
		// a merchant token cannot reset a staff account
		await h.call('POST', '/v1/auth/merchant/password-reset', { body: { email: 'lock@example.com' } });
		expect(
			(
				await h.call('POST', '/v1/auth/staff/password-reset/confirm', {
					body: { token: h.mailer.token('lock@example.com', 'password_reset'), password: 'brand new password' },
				})
			).status,
		).toBe(400);
	});

	it('password change, sessions list/revoke, MFA disable and recovery-code regeneration', async () => {
		const h = await boot();
		const { client: owner } = await h.signupOwner('me@example.com');
		const second = h.client();
		await second.post('/v1/auth/merchant/login', { email: 'me@example.com', password: PASSWORD });
		const sessions = await owner.get('/v1/me/sessions');
		expect(sessions.json.items).toHaveLength(2);
		expect(sessions.json.items.filter((/** @type {any} */ s) => s.current)).toHaveLength(1);
		const other = sessions.json.items.find((/** @type {any} */ s) => !s.current);
		expect((await owner.del(`/v1/me/sessions/${other.sessionId}`)).status).toBe(204);
		expect((await owner.del(`/v1/me/sessions/${other.sessionId}`)).status).toBe(404);
		expect((await second.get('/v1/me')).status).toBe(401);

		await second.post('/v1/auth/merchant/login', { email: 'me@example.com', password: PASSWORD });
		expect((await owner.post('/v1/me/password', { currentPassword: 'wrong one', newPassword: 'a new password!' })).status).toBe(
			401,
		);
		expect((await owner.post('/v1/me/password', { currentPassword: PASSWORD, newPassword: 'a new password!' })).status).toBe(
			204,
		);
		expect((await owner.get('/v1/me')).status).toBe(200);
		expect((await second.get('/v1/me')).status).toBe(401);

		const secret = (await owner.post('/v1/me/mfa/enrol')).json.secret;
		h.clock.advance(30_000);
		const codes = (await owner.post('/v1/me/mfa/confirm', { code: h.code(secret) })).json.recoveryCodes;
		h.clock.advance(30_000);
		expect((await owner.post('/v1/me/mfa/recovery-codes', { code: '999999' })).status).toBe(401);
		const regenerated = await owner.post('/v1/me/mfa/recovery-codes', { code: h.code(secret) });
		expect(regenerated.json.recoveryCodes).toHaveLength(10);
		expect(regenerated.json.recoveryCodes).not.toContain(codes[0]);
		h.clock.advance(30_000);
		expect((await owner.post('/v1/me/mfa/disable', { password: 'wrong password', code: h.code(secret) })).status).toBe(401);
		h.clock.advance(30_000);
		const disabled = await owner.post('/v1/me/mfa/disable', { password: 'a new password!', code: h.code(secret) });
		expect([disabled.status, disabled.json.mfa.enabled]).toEqual([200, false]);
		expect((await owner.post('/v1/me/mfa/disable', { password: 'a new password!', code: h.code(secret) })).status).toBe(409);
		expect((await owner.post('/v1/me/mfa/recovery-codes', { code: h.code(secret) })).status).toBe(409);
		expect((await owner.post('/v1/me/mfa/confirm', { code: h.code(secret) })).status).toBe(409);

		expect((await owner.post('/v1/auth/merchant/logout')).status).toBe(204);
		expect(owner.cookie).toBe('');
		expect((await h.call('GET', '/v1/me')).status).toBe(401);
	});

	it('users in several merchants pick and switch merchants', async () => {
		const h = await boot();
		const a = await h.signupOwner('a@example.com', { merchantName: 'A' });
		const b = await h.signupOwner('b@example.com', { merchantName: 'B' });
		await b.client.post(`/v1/merchants/${b.merchantId}/team/invites`, { email: 'a@example.com', roles: ['billing'] });
		const wrongPassword = await h.call('POST', '/v1/auth/invites/accept', {
			body: { token: h.mailer.token('a@example.com', 'invite'), password: 'not my password' },
		});
		expect(wrongPassword.status).toBe(401);
		// an existing account proves itself with its own password
		expect(
			(
				await a.client.post('/v1/auth/invites/accept', {
					token: h.mailer.token('a@example.com', 'invite'),
					password: a.password,
				})
			).status,
		).toBe(200);
		expect((await a.client.get('/v1/me')).json.merchantId).toBe(b.merchantId);
		expect((await a.client.get('/v1/me')).json.memberships).toHaveLength(2);
		expect((await a.client.get(`/v1/merchants/${a.merchantId}`)).status).toBe(403);
		const switched = await a.client.post('/v1/me/merchant', { merchantId: a.merchantId });
		expect([switched.status, switched.json.merchantId]).toEqual([200, a.merchantId]);
		expect((await a.client.get(`/v1/merchants/${a.merchantId}`)).status).toBe(200);
		expect((await a.client.post('/v1/me/merchant', { merchantId: 'mer_0000000000000000000000000z' })).status).toBe(403);

		const pick = await h.call('POST', '/v1/auth/merchant/login', {
			body: { email: 'a@example.com', password: a.password, merchantId: b.merchantId },
		});
		expect(pick.json.merchantId).toBe(b.merchantId);
		const notMine = await h.call('POST', '/v1/auth/merchant/login', {
			body: { email: 'b@example.com', password: b.password, merchantId: a.merchantId },
		});
		expect(notMine.status).toBe(403);
	});
});

describe('staff accounts', () => {
	it('first admin from the sign-in page → optional profile and MFA → MFA required once enrolled', async () => {
		const h = await boot();
		const first = h.client();
		expect((await first.post('/v1/auth/staff/first-admin', { password: 'short' })).status).toBe(422);
		const created = await first.post('/v1/auth/staff/first-admin', { password: 'root password 123' });
		expect(created.status).toBe(201);
		expect(created.json).toMatchObject({ status: 'ok', staff: { login: 'admin', email: null, roles: ['superadmin'] } });
		const staffId = created.json.staff.staffId;
		expect(first.cookie).toMatch(/^__Host-ss_staff=/);
		// only once: afterwards the page is a normal sign-in
		expect((await h.client().post('/v1/auth/staff/first-admin', { password: 'another password 1' })).status).toBe(409);
		expect(await h.service.hasStaff()).toBe(true);

		// no MFA until enrolled: the admin works at once; sign-in by the name `admin`
		expect((await first.get('/v1/admin/merchants')).status).toBe(200);
		const root = h.client();
		const login = await root.post('/v1/auth/staff/login', { email: 'admin', password: 'root password 123' });
		expect(login.json).toMatchObject({ status: 'ok', staff: { staffId } });
		expect((await root.post('/v1/auth/staff/login', { email: 'admin', password: 'wrong password 12' })).status).toBe(401);

		// e-mail and name are optional, added whenever; then the e-mail signs in too
		const named = await root.send('PATCH', '/v1/me', { email: 'root@example.com', name: 'Root' });
		expect(named.json).toMatchObject({ login: 'admin', email: 'root@example.com', name: 'Root' });
		expect(
			(await h.call('POST', '/v1/auth/staff/login', { body: { email: 'root@example.com', password: 'root password 123' } }))
				.json.status,
		).toBe('ok');

		expect((await root.post('/v1/auth/staff/mfa/verify', { code: '123456' })).status).toBe(409);
		expect((await root.post('/v1/auth/staff/mfa/confirm', { code: '123456' })).status).toBe(409);
		const enrol = await root.post('/v1/auth/staff/mfa/enrol');
		h.clock.advance(30_000);
		const confirmed = await root.post('/v1/auth/staff/mfa/confirm', { code: h.code(enrol.json.secret) });
		expect(confirmed.status).toBe(200);
		expect((await root.get('/v1/me')).json).toMatchObject({ kind: 'staff', staff: { staffId, mfa: { enabled: true } } });
		expect((await root.get('/v1/admin/merchants')).status).toBe(200);

		const next = h.client();
		const second = await next.post('/v1/auth/staff/login', { email: 'root@example.com', password: 'root password 123' });
		expect(second.json.status).toBe('mfa_required');
		expect((await next.get('/v1/admin/staff')).status).toBe(403);
		expect((await next.post('/v1/auth/staff/mfa/verify', { code: '000000' })).status).toBe(401);
		h.clock.advance(30_000);
		expect((await next.post('/v1/auth/staff/mfa/verify', { code: h.code(enrol.json.secret) })).status).toBe(200);
		expect((await next.get('/v1/admin/staff')).status).toBe(200);
		const recovery = h.client();
		await recovery.post('/v1/auth/staff/login', { email: 'root@example.com', password: 'root password 123' });
		expect((await recovery.post('/v1/auth/staff/mfa/verify', { recoveryCode: confirmed.json.recoveryCodes[3] })).status).toBe(
			200,
		);
		expect((await recovery.post('/v1/auth/staff/logout')).status).toBe(204);
		expect((await recovery.get('/v1/me')).status).toBe(401);

		const audit = await h.portal.shared.audit.list({ targetId: staffId });
		expect(audit.map((e) => e.action)).toEqual(
			expect.arrayContaining(['staff.bootstrapped', 'staff.profile_updated', 'staff.mfa_enabled', 'staff.recovery_code_used']),
		);
		// MFA codes are throttled like passwords
		const brute = h.client();
		await brute.post('/v1/auth/staff/login', { email: 'root@example.com', password: 'root password 123' });
		const statuses = [];
		for (let i = 0; i < 6; i += 1) statuses.push((await brute.post('/v1/auth/staff/mfa/verify', { code: '000000' })).status);
		expect(statuses).toEqual([401, 401, 401, 401, 429, 429]);
	});

	it('staff management: roles, last superadmin, disable, MFA reset, permissions', async () => {
		const h = await boot();
		const root = await h.staffUser('root@example.com');
		const support = await h.staffUser('support@example.com', ['support'], { creator: root.client });
		expect(h.mailer.sent.find((m) => m.template === 'staff_welcome')?.data.link).toMatch(/staff\/reset-password#token=/);
		expect((await support.client.get('/v1/admin/staff')).status).toBe(403);
		expect((await support.client.get('/v1/admin/merchants')).status).toBe(200);
		expect((await root.client.post('/v1/admin/staff', { email: 'support@example.com', roles: ['support'] })).status).toBe(409);
		expect((await root.client.post('/v1/admin/staff', { email: 'x@example.com', roles: ['wizard'] })).status).toBe(422);

		const list = await root.client.get('/v1/admin/staff');
		expect(list.json.items.map((/** @type {any} */ s) => s.email)).toEqual(['root@example.com', 'support@example.com']);
		expect(JSON.stringify(list.json)).not.toMatch(/passwordHash|scrypt|secret/);

		expect((await root.client.patch(`/v1/admin/staff/${root.staffId}`, { roles: ['admin'] })).status).toBe(409);
		expect((await root.client.patch(`/v1/admin/staff/${root.staffId}`, { status: 'disabled' })).status).toBe(409);
		const promoted = await root.client.patch(`/v1/admin/staff/${support.staffId}`, { roles: ['finance'] });
		expect(promoted.json.roles).toEqual(['finance']);
		expect((await support.client.get('/v1/admin/merchants')).status).toBe(200); // finance reads merchants
		expect((await support.client.get('/v1/admin/developers')).status).toBe(403); // live roles from the port

		expect((await root.client.post(`/v1/admin/staff/${root.staffId}/mfa/reset`, { reason: 'lost' })).status).toBe(409);
		expect((await root.client.post(`/v1/admin/staff/${support.staffId}/mfa/reset`, { reason: 'lost phone' })).status).toBe(204);
		expect((await support.client.get('/v1/me')).status).toBe(401);
		const relogin = h.client();
		const again = await relogin.post('/v1/auth/staff/login', { email: 'support@example.com', password: support.password });
		expect(again.json.status).toBe('ok'); // no authenticator any more: MFA is no longer asked

		expect((await root.client.patch(`/v1/admin/staff/${support.staffId}`, { status: 'disabled' })).status).toBe(200);
		expect((await relogin.post('/v1/auth/staff/mfa/enrol')).status).toBe(401);
		expect(
			(await h.call('POST', '/v1/auth/staff/login', { body: { email: 'support@example.com', password: support.password } }))
				.status,
		).toBe(401);
		expect((await root.client.patch('/v1/admin/staff/stf_00000000000000000000000000', { status: 'active' })).status).toBe(404);
		expect((await root.client.post('/v1/me/mfa/recovery-codes', { code: '000000' })).status).toBe(401);
		h.clock.advance(30_000);
		expect(
			(await root.client.post('/v1/me/mfa/recovery-codes', { code: h.code(root.secret) })).json.recoveryCodes,
		).toHaveLength(10);
		expect(
			(await root.client.post('/v1/me/password', { currentPassword: root.password, newPassword: 'another staff pw' })).status,
		).toBe(204);

		// a second superadmin can be demoted while one remains
		const second = await h.staffUser('second@example.com', ['superadmin'], { creator: root.client });
		expect((await root.client.patch(`/v1/admin/staff/${second.staffId}`, { roles: ['admin'] })).status).toBe(200);
		expect((await second.client.get('/v1/admin/staff')).status).toBe(403);
	});
});
