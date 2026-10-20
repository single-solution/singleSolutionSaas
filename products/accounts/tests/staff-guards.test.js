/**
 * SR-4-11: the staff actions that sign a user out or answer a sign-up are guarded like the other changes to a user (nobody
 * acts on a user whose role ranks above theirs), and a deletion that runs on its own never erases the last unblocked Owner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

/**
 * A server-token call as an acting staff member.
 * @param {string} method @param {string} path @param {{ id: string, name: string }} as @param {unknown} [body]
 */
const asStaff = (method, path, as, body) =>
	env.call(method, path, {
		token: env.server,
		...(body === undefined ? {} : { body }),
		headers: { 'ss-actor-id': as.id, 'ss-actor-name': encodeURIComponent(as.name) },
	});
/** @param {Record<string, unknown>} body */
const create = async (body) => (await env.serverCall('POST', '/v1/users', body)).json;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => !['consents', 'two_step', 'risk_checks'].includes(key)));
	await env.connectDatabase();
	await env.paste('notifications');
});
afterAll(async () => {
	await env.product.close();
});

describe('staff guards on sign-out, approve and decline', () => {
	it('a manager signs out or answers users below them, never a user whose role ranks above theirs', async () => {
		const mo = await create({ name: 'Mo Manager', email: 'mo@example.com', role: 'business_manager' });
		const moAs = { id: mo.id, name: 'Mo Manager' };
		const boss = await create({
			name: 'Olga Owner',
			email: 'olga@example.com',
			role: 'owner',
			password: 'correct horse battery',
		});
		const cal = await create({ name: 'Cal Customer', email: 'cal@example.com', password: 'cal password 123' });
		const store = await env.store();
		const signedIn = await env.visitor('POST', '/v1/sign-in/password', {
			email: 'olga@example.com',
			password: 'correct horse battery',
		});
		expect(signedIn.json.status).toBe('signed_in');

		// sign out everywhere: not an Owner (the attack), but a customer is fine
		expect(code(await asStaff('POST', `/v1/users/${boss.id}/sign-out`, moAs))).toBe('forbidden');
		expect((await store.sessions.ofUser(boss.id)).length).toBe(1);
		expect((await asStaff('POST', `/v1/users/${cal.id}/sign-out`, moAs)).status).toBe(204);
		expect((await env.serverCall('POST', `/v1/users/${boss.id}/sign-out`)).status).toBe(204);
		expect(await store.sessions.ofUser(boss.id)).toEqual([]);
		// (a manager signs out themselves too: nothing above them)
		expect((await asStaff('POST', `/v1/users/${mo.id}/sign-out`, moAs)).status).toBe(204);

		// approve and decline: a pending user whose role ranks above the manager's is not theirs to answer
		await store.users.update(boss.id, { status: 'pending' });
		expect(code(await asStaff('POST', `/v1/users/${boss.id}/approve`, moAs))).toBe('forbidden');
		expect(code(await asStaff('POST', `/v1/users/${boss.id}/decline`, moAs))).toBe('forbidden');
		expect((await store.users.get(boss.id))?.status).toBe('pending');
		await store.users.update(cal.id, { status: 'pending' });
		expect((await asStaff('POST', `/v1/users/${cal.id}/approve`, moAs)).json.status).toBe('active');
		await store.users.update(cal.id, { status: 'pending' });
		expect((await asStaff('POST', `/v1/users/${cal.id}/decline`, moAs)).status).toBe(204);
		// the server token without an acting user, and an Owner, keep full power
		expect((await env.serverCall('POST', `/v1/users/${boss.id}/approve`)).json.status).toBe('active');
	});
});

describe('a deletion that runs on its own', () => {
	it('never erases the last unblocked Owner: the request waits for staff, and the log says why', async () => {
		await env.setting('data_rights', 'deleteAfterDays', 1);
		// the Owners so far: Olga (above) and the harness' staff Owner; block Olga so one is left
		const owners = (await env.serverCall('GET', '/v1/users?role=owner&limit=10')).json.items;
		const mine = owners.find((/** @type {any} */ u) => u.email === 'staff@shop.example.com');
		for (const other of owners.filter((/** @type {any} */ u) => u.id !== mine.id))
			expect((await env.serverCall('PATCH', `/v1/users/${other.id}`, { blocked: true })).status).toBe(200);
		const signIn = await env.staffSignIn();
		const asked = await env.visitor('POST', '/v1/me/delete', {}, signIn);
		expect(asked.status).toBe(202);
		// a customer who asked too goes on schedule
		const kim = await create({ name: 'Kim Leaving', email: 'kim@example.com', password: 'kim password 123' });
		const kimIn = await env.visitor('POST', '/v1/sign-in/password', { email: 'kim@example.com', password: 'kim password 123' });
		expect((await env.visitor('POST', '/v1/me/delete', {}, kimIn.json.signIn)).status).toBe(202);

		env.advance(86_400_000 + 1000);
		await env.serverCall('GET', '/v1/roles');
		expect(code(await env.serverCall('GET', `/v1/users/${kim.id}`))).toBe('not_found');
		const kept = await env.serverCall('GET', `/v1/users/${mine.id}`);
		expect(kept.status).toBe(200);
		// still pending, now waiting for staff (no due day), and logged once
		expect(kept.json.deletion).toMatchObject({ dueAt: null });
		await env.serverCall('GET', '/v1/roles');
		const held = (await env.serverCall('GET', '/v1/activity?action=user.deletion_held')).json.items;
		expect(held).toHaveLength(1);
		expect(held[0]).toMatchObject({ target: mine.id, values: { reason: 'last_owner' } });
		// the last Owner's deletion cannot be approved either
		expect(code(await env.serverCall('POST', `/v1/users/${mine.id}/deletion/approve`))).toBe('forbidden');
	});
});
