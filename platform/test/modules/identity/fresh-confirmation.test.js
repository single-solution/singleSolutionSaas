import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { boot, PASSWORD, setupMongo, teardownMongo } from './boot.js';

vi.setConfig({ testTimeout: 60_000 });
beforeAll(setupMongo, 120_000);
afterAll(teardownMongo, 60_000);

/** @param {{ json: any }} res */
const codeOf = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

describe('Fresh password for turning two-step on (SR-2-4)', () => {
	it('starting two-step needs the current password: without it or with a wrong one nothing is started', async () => {
		const h = await boot();
		const m = await h.merchant('sam@shop.test');
		expect((await m.client.post('/v1/me/two-step/start')).status).toBe(422);
		expect((await m.client.post('/v1/me/two-step/start', {})).status).toBe(422);
		const wrong = await m.client.post('/v1/me/two-step/start', { password: 'not the password!!' });
		expect([wrong.status, codeOf(wrong)]).toEqual([401, 'invalid_credentials']);
		// nothing was started, so a code cannot turn it on
		const early = await m.client.post('/v1/me/two-step/confirm', { code: '123456' });
		expect([early.status, codeOf(early)]).toEqual([409, 'conflict']);

		const started = await m.client.post('/v1/me/two-step/start', { password: PASSWORD });
		expect(started.status).toBe(200);
		expect(started.json.secret).toMatch(/^[A-Z2-7]+$/);
	});

	it('wrong passwords are throttled like sign-in', async () => {
		const h = await boot();
		const m = await h.merchant('sam@shop.test');
		const statuses = [];
		for (let i = 0; i < 12; i += 1)
			statuses.push((await m.client.post('/v1/me/two-step/start', { password: 'nope nope nope' })).status);
		expect(statuses).toContain(429);
	});
});

describe('Fresh password for high-impact admin actions (SR-2-5)', () => {
	/**
	 * Each action: what it sends, what it answers when allowed, and how to see that it happened.
	 * @typedef {{
	 *   name: string,
	 *   setup?: (h: any, o: any) => Promise<any>,
	 *   send: (o: any, state: any, confirmation: Record<string, unknown>) => Promise<{ status: number, json: any }>,
	 *   status: number,
	 *   done: (h: any, o: any, state: any) => Promise<boolean>,
	 * }} Action
	 */
	/** @type {Action[]} */
	const ACTIONS = [
		{
			name: 'invite an admin',
			send: (o, _s, confirmation) =>
				o.client.post('/v1/admin/admins', { email: 'new@portal.test', role: 'owner', ...confirmation }),
			status: 201,
			done: async (_h, o) =>
				(await o.client.get('/v1/admin/admins')).json.items.some((/** @type {any} */ a) => a.email === 'new@portal.test'),
			setup: async () => ({}),
		},
		{
			name: 'invite an admin and copy the link',
			send: (o, _s, confirmation) =>
				o.client.post('/v1/admin/admins', { email: 'new@portal.test', role: 'support', copy: true, ...confirmation }),
			status: 201,
			done: async (_h, o) =>
				(await o.client.get('/v1/admin/admins')).json.items.some((/** @type {any} */ a) => a.email === 'new@portal.test'),
		},
		{
			name: 'change a role',
			setup: (h) => h.admin('support'),
			send: (o, sup, confirmation) => o.client.patch(`/v1/admin/admins/${sup.adminId}`, { role: 'owner', ...confirmation }),
			status: 200,
			done: async (_h, o, sup) =>
				(await o.client.get('/v1/admin/admins')).json.items.find((/** @type {any} */ a) => a.adminId === sup.adminId).role ===
				'owner',
		},
		{
			name: 'correct the email of a pending invite',
			setup: async (_h, o) =>
				(await o.client.post('/v1/admin/admins', { email: 'pending@portal.test', role: 'support', password: PASSWORD })).json
					.admin,
			send: (o, pending, confirmation) =>
				o.client.patch(`/v1/admin/admins/${pending.adminId}`, { email: 'other@portal.test', ...confirmation }),
			status: 200,
			done: async (_h, o) =>
				(await o.client.get('/v1/admin/admins')).json.items.some((/** @type {any} */ a) => a.email === 'other@portal.test'),
		},
		{
			name: 'copy an admin invite link',
			setup: async (_h, o) =>
				(await o.client.post('/v1/admin/admins', { email: 'pending@portal.test', role: 'support', password: PASSWORD })).json
					.admin,
			send: (o, pending, confirmation) =>
				o.client.post(`/v1/admin/admins/${pending.adminId}/invite`, { copy: true, ...confirmation }),
			status: 200,
			done: async (h) => (await h.activity('admin.invite_link_copied')).length > 0,
		},
		{
			name: 'copy a merchant setup link',
			setup: async (_h, o) =>
				(await o.client.post('/v1/admin/merchants', { name: 'Shop', ownerName: 'Sam', email: 'pending@shop.test' })).json
					.merchant,
			send: (o, pending, confirmation) =>
				o.client.post(`/v1/admin/merchants/${pending.merchantId}/setup-link`, { copy: true, ...confirmation }),
			status: 200,
			done: async (h) => (await h.activity('merchant.setup_link_copied')).length > 0,
		},
		{
			name: 'turn off an admin’s two-step',
			setup: async (h) => {
				const sup = await h.admin('support');
				await h.enableTwoStep(sup.client);
				return sup;
			},
			send: (o, sup, confirmation) => o.client.post(`/v1/admin/admins/${sup.adminId}/two-step/off`, { ...confirmation }),
			status: 200,
			done: async (h) => (await h.activity('two_step.turned_off_by_owner')).length > 0,
		},
		{
			name: 'turn off a merchant’s two-step',
			setup: async (h) => {
				const m = await h.merchant('sam@shop.test');
				await h.enableTwoStep(m.client);
				return m;
			},
			send: (o, m, confirmation) => o.client.post(`/v1/admin/merchants/${m.merchantId}/two-step/off`, { ...confirmation }),
			status: 200,
			done: async (h) => (await h.activity('two_step.turned_off_by_owner')).length > 0,
		},
		{
			name: 'remove an admin',
			setup: (h) => h.admin('finance'),
			send: (o, fin, confirmation) => o.client.del(`/v1/admin/admins/${fin.adminId}`, { ...confirmation }),
			status: 204,
			done: async (_h, o, fin) =>
				!(await o.client.get('/v1/admin/admins')).json.items.some((/** @type {any} */ a) => a.adminId === fin.adminId),
		},
		{
			name: 'delete a merchant',
			setup: (h) => h.merchant('sam@shop.test'),
			send: (o, m, confirmation) => o.client.del(`/v1/admin/merchants/${m.merchantId}`, { confirm: 'Shop', ...confirmation }),
			status: 204,
			done: async (_h, o, m) => (await o.client.get(`/v1/admin/merchants/${m.merchantId}`)).status === 404,
		},
	];

	for (const action of ACTIONS) {
		it(`${action.name}: refused without the password or with a wrong one, done with the right one`, async () => {
			const h = await boot();
			const o = await h.owner();
			const state = action.setup ? await action.setup(h, o) : {};
			const none = await action.send(o, state, {});
			expect([none.status, codeOf(none)]).toEqual([422, 'validation_failed']);
			expect(JSON.stringify(none.json.errors)).toContain('/password');
			const wrong = await action.send(o, state, { password: 'not the password!!' });
			expect([wrong.status, codeOf(wrong)]).toEqual([401, 'invalid_credentials']);
			expect(await action.done(h, o, state)).toBe(false);
			const right = await action.send(o, state, { password: PASSWORD });
			expect(right.status).toBe(action.status);
			expect(await action.done(h, o, state)).toBe(true);
		});
	}

	it('no password is asked for a plain resend (the link is only mailed, not shown)', async () => {
		const h = await boot();
		const o = await h.owner();
		const pending = (
			await o.client.post('/v1/admin/admins', { email: 'pending@portal.test', role: 'support', password: PASSWORD })
		).json.admin;
		const resent = await o.client.post(`/v1/admin/admins/${pending.adminId}/invite`, {});
		expect(resent.json).toMatchObject({ mailed: true, link: null });
		const merchant = (
			await o.client.post('/v1/admin/merchants', { name: 'Shop', ownerName: 'Sam', email: 'pending@shop.test' })
		).json.merchant;
		expect((await o.client.post(`/v1/admin/merchants/${merchant.merchantId}/setup-link`, {})).status).toBe(200);
	});

	it('while the Owner has two-step on, a code is needed as well', async () => {
		const h = await boot();
		const o = await h.owner();
		const { secret, recoveryCodes } = await h.enableTwoStep(o.client);
		const invite = { email: 'new@portal.test', role: 'owner' };
		const noCode = await o.client.post('/v1/admin/admins', { ...invite, password: PASSWORD });
		expect([noCode.status, codeOf(noCode)]).toEqual([422, 'validation_failed']);
		const wrongCode = await o.client.post('/v1/admin/admins', { ...invite, password: PASSWORD, code: '000000' });
		expect([wrongCode.status, codeOf(wrongCode)]).toEqual([401, 'invalid_credentials']);
		expect((await o.client.get('/v1/admin/admins')).json.items).toHaveLength(1);
		const right = await o.client.post('/v1/admin/admins', { ...invite, password: PASSWORD, code: h.code(secret) });
		expect(right.status).toBe(201);
		const viaRecovery = await o.client.post('/v1/admin/admins', {
			email: 'two@portal.test',
			role: 'support',
			password: PASSWORD,
			recoveryCode: recoveryCodes[0],
		});
		expect(viaRecovery.status).toBe(201);
	});

	it('a support admin without the right is still refused first (403), whatever the body', async () => {
		const h = await boot();
		await h.owner();
		const sup = await h.admin('support');
		const res = await sup.client.post('/v1/admin/admins', { email: 'x@portal.test', role: 'owner', password: PASSWORD });
		expect(res.status).toBe(403);
	});
});
