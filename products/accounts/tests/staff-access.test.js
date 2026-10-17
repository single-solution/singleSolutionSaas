/**
 * Accounts' staff routes: users and roles (the permissions every product’s staff hold) are changed by a signed-in staff
 * member of the website with the permission, checked against Accounts’ own keys, the open session and the role as it is
 * now; the server token alone changes no role, no user and no setting (SEC). The narrow lookups the other products make
 * with their pasted token (who holds a permission, is this address a member) stay open to the server token.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => !['consents', 'two_step', 'risk_checks'].includes(key)));
	await env.connectDatabase();
	await env.paste('notifications');
});
afterAll(async () => {
	await env.product.close();
});

/** @param {{ json: any }} response */
const typeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

const ROLE = { name: 'Editor', permissions: ['site:vip.view'] };

describe('Accounts with the server token alone', () => {
	it('changes no role, no user, no setting, no connection: 403 needs_signed_in_staff', async () => {
		for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
			['PUT', '/v1/roles/editor', ROLE],
			['DELETE', '/v1/roles/editor', undefined],
			['PUT', '/v1/roles/permissions', { permissions: [] }],
			['POST', '/v1/users', { name: 'Eve', email: 'eve@example.com', role: 'owner' }],
			['PATCH', '/v1/users/usr_none', { role: 'owner' }],
			['DELETE', '/v1/users/usr_none', { reason: 'x' }],
			['POST', '/v1/users/usr_none/sign-in-code', undefined],
			['POST', '/v1/users/usr_none/setup-link', undefined],
			['GET', '/v1/users/count', undefined],
			['GET', '/v1/users?limit=100', undefined],
			['GET', '/v1/activity-copies', undefined],
			['PUT', '/v1/settings/email_password.minLength', { value: 8 }],
			['PUT', '/v1/connections/notifications', { value: 'x' }],
			['PUT', '/v1/theme', { radius: 3 }],
		])) {
			const refused = await env.call(method, path, { token: env.server, bare: true, ...(body === undefined ? {} : { body }) });
			expect([method, path, refused.status, typeOf(refused)]).toEqual([method, path, 403, 'needs_signed_in_staff']);
		}
	});

	it('still serves the other products’ narrow lookups: who holds a permission, one address, one user by id', async () => {
		const staff = await env.call('GET', '/v1/users?permission=chat:inbox.reply&blocked=false', {
			token: env.server,
			bare: true,
		});
		expect(staff.status).toBe(200);
		const one = await env.call('GET', '/v1/users?email=nobody%40example.com', { token: env.server, bare: true });
		expect(one.status).toBe(200);
		expect((await env.call('GET', '/v1/roles', { token: env.server, bare: true })).status).toBe(200);
		expect((await env.call('GET', '/v1/permissions', { token: env.server, bare: true })).status).toBe(200);
	});
});

describe('every connection of the product (database, storage, provider keys, pasted product tokens)', () => {
	it('cannot be saved, removed or test-called with the server token alone: 403, and the list stays as it was', async () => {
		const listed = await env.call('GET', '/v1/connections', { token: env.server });
		const names = listed.json.connections.map((/** @type {{ name: string }} */ c) => c.name);
		expect(names).toContain('database');
		for (const name of names) {
			for (const [method, path, body] of /** @type {Array<[string, string, unknown]>} */ ([
				['PUT', `/v1/connections/${name}`, { value: 'attacker-value' }],
				['DELETE', `/v1/connections/${name}`, undefined],
				['POST', `/v1/connections/${name}/test`, undefined],
			])) {
				const refused = await env.call(method, path, {
					token: env.server,
					bare: true,
					...(body === undefined ? {} : { body }),
				});
				expect([name, method, refused.status, String(refused.json?.type).split('/').pop()]).toEqual([
					name,
					method,
					403,
					'needs_signed_in_staff',
				]);
			}
		}
		const after = await env.call('GET', '/v1/connections', { token: env.server });
		expect(after.json.connections).toEqual(listed.json.connections);
	});
});

describe('a staff sign-in', () => {
	it('of an Owner makes a role and the change is theirs in the activity log', async () => {
		const made = await env.call('PUT', '/v1/roles/editor', { token: env.server, body: ROLE });
		expect(made.status).toBe(200);
		const log = (await env.call('GET', '/v1/activity?action=role.saved', { token: env.server })).json.items;
		expect(log[0].actor).toMatchObject({ kind: 'user', name: 'Test Staff', role: 'owner' });
	});

	it('of a role without roles.manage cannot define roles; support staff cannot manage users', async () => {
		// a manager manages users but does not define roles
		const manager = { id: 'usr_secmanager', name: 'Mia Manager', role: 'business_manager' };
		const refused = await env.call('PUT', '/v1/roles/editor', { token: env.server, staff: manager, body: ROLE });
		expect([refused.status, typeOf(refused)]).toEqual([403, 'forbidden']);
		const support = { id: 'usr_secsupport', name: 'Sue Support', role: 'support_staff' };
		const noManage = await env.call('POST', '/v1/users', {
			token: env.server,
			staff: support,
			body: { name: 'Eve', email: 'eve@example.com' },
		});
		expect([noManage.status, typeOf(noManage)]).toEqual([403, 'forbidden']);
		// and the customer role has no staff authority at all
		const customer = await env.call('PUT', '/v1/roles/editor', {
			token: env.server,
			staff: { id: 'usr_seccustomer', name: 'Cal', role: 'customer' },
			body: ROLE,
		});
		expect([customer.status, typeOf(customer)]).toEqual([403, 'forbidden']);
	});

	it('is checked live: a blocked user’s sign-in no longer works, a forged or foreign one never did', async () => {
		const sign = await env.staffSignIn({ id: 'usr_secblocked', name: 'Bob Blocked', role: 'owner' });
		const asBob = () =>
			env.call('PUT', '/v1/roles/editor', { token: env.server, bare: true, headers: { 'ss-sign-in': sign }, body: ROLE });
		expect((await asBob()).status).toBe(200);
		const bob = (await env.call('GET', '/v1/users?q=Bob%20Blocked', { token: env.server })).json.items[0];
		await env.call('PATCH', `/v1/users/${bob.id}`, { token: env.server, body: { blocked: true, blockedReason: 'test' } });
		const blocked = await asBob();
		expect([blocked.status, typeOf(blocked)]).toEqual([401, 'invalid_sign_in']);
		for (const junk of ['junk', `${sign}x`, `${sign.split('.')[0]}.${sign.split('.')[1]}.AAAA`]) {
			const refused = await env.call('PUT', '/v1/roles/editor', {
				token: env.server,
				bare: true,
				headers: { 'ss-sign-in': junk },
				body: ROLE,
			});
			expect([junk.slice(0, 8), refused.status, typeOf(refused)]).toEqual([junk.slice(0, 8), 401, 'invalid_sign_in']);
		}
	});

	it('the dashboard session’s writes are unchanged', async () => {
		const saved = await env.dashboard(await env.adminSession(), 'PUT', `/v1/dashboard/websites/${env.websiteId}/theme`, {
			radius: 5,
		});
		expect(saved.status).toBe(200);
	});
});
