/**
 * The merchant's staff and customers (PLAN 0.8.10): staff-issued sign-in codes and setup links (A3), staff and customer
 * management with the guards (A4), and role requests (A5), through the server token and the admin widgets' tickets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ORIGIN, ALL, ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

/**
 * A server-token call, optionally as an acting user (K2).
 * @param {string} method @param {string} path @param {unknown} [body] @param {{ id: string, name: string } | null} [as]
 */
const server = (method, path, body, as = null) =>
	env.call(method, path, {
		token: env.server,
		...(body === undefined ? {} : { body }),
		headers: as ? { 'ss-actor-id': as.id, 'ss-actor-name': encodeURIComponent(as.name) } : {},
	});
/** @param {Record<string, unknown>} body */
const create = async (body) => (await server('POST', '/v1/users', body)).json;
/** @param {string} id */
const asUser = (id, name = 'Staff') => ({ id, name });
/** The claims of a sign-in (other products read `phone_verified` from it). @param {string} signIn */
const claimsOf = (signIn) => JSON.parse(Buffer.from(String(signIn.split('.')[1]), 'base64url').toString('utf8'));
/** The code of a setup link. @param {string} url */
const setupCodeOf = (url) => new URL(url).searchParams.get('ss_setup');

/** @type {Record<string, any>} */
const people = {};

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => !['consents', 'approval', 'two_step', 'risk_checks'].includes(key)));
	await env.connectDatabase();
	await env.paste('notifications');
	await env.setting('phone', 'defaultCallingCode', '+44');
	await env.setting('phone', 'trunkPrefix', '0');
	people.owner = await create({
		name: 'Olga Owner',
		email: 'olga@example.com',
		role: 'owner',
		password: 'correct horse battery',
	});
	people.manager = await create({ name: 'Mo Manager', email: 'mo@example.com', role: 'business_manager' });
	people.support = await create({ name: 'Sue Support', phone: '07700 900001', role: 'support_staff' });
	people.customer = await create({ name: 'Cal Customer', phone: '07700900002' });
});
afterAll(async () => {
	await env.product.close();
});

describe('A4: staff and customer management', () => {
	it('creates active users by phone or email, sends nothing, and refuses duplicates', async () => {
		expect(people.customer).toMatchObject({
			status: 'active',
			role: 'customer',
			phone: '+447700900002',
			phoneVerified: true,
			hasPassword: false,
		});
		expect(people.owner.hasPassword).toBe(true);
		expect(env.messages()).toEqual([]);
		expect(code(await server('POST', '/v1/users', { name: 'Dup', phone: '+447700900002' }))).toBe('already_exists');
		expect(code(await server('POST', '/v1/users', { name: 'No contact' }))).toBe('validation_failed');
		expect(code(await server('POST', '/v1/users', { email: 'x@example.com' }))).toBe('validation_failed');
		expect(code(await server('POST', '/v1/users', { name: 'X', email: 'x@example.com', role: 'nope' }))).toBe(
			'validation_failed',
		);
		const withAddress = await server('POST', '/v1/users', {
			name: 'Ada Address',
			email: 'ada@example.com',
			addresses: [{ line1: '5 Main St', city: 'London', area: 'Camden' }],
			notes: 'Prefers calls',
		});
		expect(withAddress.json.addresses[0]).toMatchObject({ area: 'Camden', default: true });
		expect(withAddress.json.notes).toBe('Prefers calls');
		people.ada = withAddress.json;
	});

	it('edits contacts (normalized, unique, verified), the password (signing out) and addresses', async () => {
		const edited = await server('PATCH', `/v1/users/${people.ada.id}`, { email: 'ADA2@Example.com', phone: '07700 900003' });
		expect(edited.json).toMatchObject({ email: 'ada2@example.com', emailVerified: true, phone: '+447700900003' });
		expect(code(await server('PATCH', `/v1/users/${people.ada.id}`, { phone: '+447700900002' }))).toBe('already_exists');
		expect(code(await server('PATCH', `/v1/users/${people.ada.id}`, { email: 'bad' }))).toBe('validation_failed');
		expect(code(await server('PATCH', `/v1/users/${people.ada.id}`, { phone: 'bad' }))).toBe('validation_failed');
		const signedIn = await env.visitor('POST', '/v1/sign-in/password', {
			email: 'olga@example.com',
			password: 'correct horse battery',
		});
		const changed = await server('PATCH', `/v1/users/${people.owner.id}`, { password: 'another good password' });
		expect(changed.json.hasPassword).toBe(true);
		expect(code(await env.visitor('GET', '/v1/me', undefined, signedIn.json.signIn))).toBe('signed_out');
		expect(
			(await env.visitor('POST', '/v1/sign-in/password', { email: 'olga@example.com', password: 'another good password' }))
				.json.status,
		).toBe('signed_in');
		const log = (await server('GET', '/v1/activity?action=user.password_changed')).json.items[0];
		expect(log).toMatchObject({ label: 'Olga Owner', values: { signedOut: 1 } });
		const removed = await server('PATCH', `/v1/users/${people.ada.id}`, { email: null, addresses: [] });
		expect(removed.json).toMatchObject({ email: null, addresses: [] });
	});

	it('finds users by phone, the end of their national number, a permission, several roles and the time they joined', async () => {
		/** @param {string} query */
		const ids = async (query) => (await server('GET', `/v1/users?${query}`)).json.items.map((/** @type {any} */ u) => u.id);
		expect(await ids('phone=07700900001')).toEqual([people.support.id]);
		expect(code(await server('GET', '/v1/users?phone=abc'))).toBe('validation_failed');
		expect(await ids('phoneDigits=447700900002')).toEqual([people.customer.id]);
		expect(await ids('phoneDigits=7700900002')).toEqual([people.customer.id]);
		expect(await ids(`phoneDigits=${encodeURIComponent('07700 900002')}`)).toEqual([people.customer.id]);
		expect(code(await server('GET', '/v1/users?phoneDigits=12'))).toBe('validation_failed');
		// A7: national numbers of any length, by their own country's rules (not the last 10 digits)
		const berlin = (await server('POST', '/v1/users', { name: 'Bea Berlin', phone: '+49 30 123456' })).json;
		const rome = (await server('POST', '/v1/users', { name: 'Rita Rome', phone: '+39 06 1234 5678' })).json;
		expect(berlin.phone).toBe('+4930123456');
		expect(await ids('phoneDigits=%2B4930123456')).toEqual([berlin.id]);
		expect(await ids('phoneDigits=123456')).toEqual([berlin.id]);
		expect(await ids(`phoneDigits=${encodeURIComponent('030 123456')}`)).toEqual([berlin.id]);
		// Italian numbers keep their 0
		expect(await ids('phoneDigits=0612345678')).toEqual([rome.id]);
		expect(await ids('phoneDigits=5678')).toEqual([rome.id]);
		await server('DELETE', `/v1/users/${berlin.id}`, { reason: 'test' });
		await server('DELETE', `/v1/users/${rome.id}`, { reason: 'test' });
		expect((await ids('permission=chat:inbox.reply')).sort()).toEqual(
			[people.owner.id, people.manager.id, people.support.id].sort(),
		);
		expect(await ids('permission=accounts:users.manage&roles=owner')).toEqual([people.owner.id]);
		// Owner holds every permission
		expect(await ids('permission=nobody:nothing')).toEqual([people.owner.id]);
		expect(code(await server('GET', '/v1/users?permission=bad'))).toBe('validation_failed');
		expect((await ids('roles=owner,support_staff')).sort()).toEqual([people.owner.id, people.support.id].sort());
		expect(await ids(`createdAfter=${encodeURIComponent(new Date(env.now() + 1).toISOString())}`)).toEqual([]);
		expect(code(await server('GET', '/v1/users?createdAfter=yesterday'))).toBe('validation_failed');
		await server('PATCH', `/v1/users/${people.customer.id}`, { blocked: true, blockedReason: 'Test' });
		expect(await ids('blocked=true')).toEqual([people.customer.id]);
		expect(await ids('blocked=false&roles=customer')).toEqual([people.ada.id]);
		expect((await server('GET', '/v1/users/count?blocked=false&permission=chat:inbox.reply')).json.count).toBe(3);
		await server('PATCH', `/v1/users/${people.customer.id}`, { blocked: false });
		// the server answers what Chat and Ecommerce staff alerts read (K6)
		const alerts = await server('GET', '/v1/users?permission=chat:inbox.reply&blocked=false&limit=100');
		expect(alerts.json.items.every((/** @type {any} */ u) => u.blocked === null)).toBe(true);
	});

	it('guards: no own role change or self-block, nobody above you, the last Owner stays', async () => {
		const mo = asUser(people.manager.id, 'Mo Manager');
		expect(code(await server('PATCH', `/v1/users/${people.manager.id}`, { role: 'owner' }, mo))).toBe('forbidden');
		expect(code(await server('PATCH', `/v1/users/${people.manager.id}`, { blocked: true }, mo))).toBe('forbidden');
		expect(code(await server('DELETE', `/v1/users/${people.manager.id}`, {}, mo))).toBe('forbidden');
		expect((await server('PATCH', `/v1/users/${people.manager.id}`, { name: 'Mo M.' }, mo)).status).toBe(200);
		expect(code(await server('PATCH', `/v1/users/${people.owner.id}`, { notes: 'x' }, mo))).toBe('forbidden');
		expect(code(await server('POST', `/v1/users/${people.owner.id}/sign-in-code`, undefined, mo))).toBe('forbidden');
		expect(code(await server('PATCH', `/v1/users/${people.support.id}`, { role: 'owner' }, mo))).toBe('forbidden');
		expect((await server('PATCH', `/v1/users/${people.support.id}`, { role: 'product_manager' }, mo)).status).toBe(200);
		const olga = asUser(people.owner.id, 'Olga Owner');
		expect(code(await server('PATCH', `/v1/users/${people.owner.id}`, { role: 'customer' }, olga))).toBe('forbidden');
		const second = await create({ name: 'Otto Owner', email: 'otto@example.com', role: 'owner' });
		expect(code(await server('PATCH', `/v1/users/${second.id}`, { blocked: true }, olga))).toBe('ok'.slice(2));
		const otto = asUser(second.id, 'Otto Owner');
		const last = await server('PATCH', `/v1/users/${people.owner.id}`, { role: 'customer' }, otto);
		expect(code(last)).toBe('forbidden');
		expect(last.json.detail).toMatch(/last Owner/);
		// an acting user who is not a user of Accounts is checked by id only; without one the server is all-powerful
		expect((await server('PATCH', `/v1/users/${people.owner.id}`, { notes: 'set by the shop' }, asUser('ext_1'))).status).toBe(
			200,
		);
		expect((await server('PATCH', `/v1/users/${second.id}`, { blocked: false })).status).toBe(200);
		// a ticket's user is checked the same way
		const ticket = await env.call('POST', '/v1/tickets', {
			token: env.server,
			body: {
				user: { id: people.manager.id, name: 'Mo', email: 'mo@example.com' },
				permissions: ['users.read', 'users.manage'],
				origin: ADMIN_ORIGIN,
			},
		});
		expect(code(await env.admin(ticket.json.ticket, 'DELETE', `/v1/admin/users/${people.owner.id}`, {}))).toBe('forbidden');
	});

	it('deletes a user at once, as an approved deletion request does', async () => {
		const gone = await create({ name: 'Gus Gone', email: 'gus@example.com' });
		const deleted = await server('DELETE', `/v1/users/${gone.id}`, { reason: 'Asked by phone' });
		expect(deleted.json).toEqual({ deleted: true, pending: [] });
		expect(code(await server('GET', `/v1/users/${gone.id}`))).toBe('not_found');
		const entry = (await server('GET', '/v1/activity?action=user.deleted')).json.items[0];
		expect(entry).toMatchObject({ label: 'Gus Gone', values: { by: 'staff', reason: 'Asked by phone' } });
	});

	it('removes someone from Accounts only: no other product erases anything, so their data stays', async () => {
		/** Data-rights deletes Accounts asked other products for since a call. @param {number} from */
		const erasures = (from) => env.calls.slice(from).filter((c) => c.url.endsWith('/v1/data-rights/delete')).length;
		const lee = await create({
			name: 'Lee Leaving',
			email: 'lee@example.com',
			role: 'support_staff',
			password: 'lee pass 123',
		});
		const signedIn = await env.visitor('POST', '/v1/sign-in/password', { email: 'lee@example.com', password: 'lee pass 123' });
		expect(code(await server('DELETE', `/v1/users/${lee.id}?scope=everything`))).toBe('validation_failed');
		const before = env.calls.length;
		const removed = await server('DELETE', `/v1/users/${lee.id}?scope=accounts`, { reason: 'Left the team' });
		expect(removed.json).toEqual({ deleted: true, pending: [] });
		expect(erasures(before)).toBe(0);
		expect(code(await server('GET', `/v1/users/${lee.id}`))).toBe('not_found');
		expect(code(await env.visitor('POST', '/v1/session/refresh', { refreshToken: signedIn.json.refreshToken }))).toBe(
			'signed_out',
		);
		const entry = (await server('GET', '/v1/activity?action=user.removed')).json.items[0];
		expect(entry).toMatchObject({
			label: 'Lee Leaving',
			values: { scope: 'accounts', reason: 'Left the team' },
		});
		// the default still erases everywhere
		const gone = await create({ name: 'Gil Gone', email: 'gil@example.com' });
		const from = env.calls.length;
		await server('DELETE', `/v1/users/${gone.id}?scope=all`);
		expect(erasures(from)).toBe(1);
	});
});

describe('A3: staff-issued sign-in codes and setup links', () => {
	it('a sign-in code is shown to staff, never sent, works once in the phone-code and phone + password screens', async () => {
		const before = env.messages().length;
		const issued = await server(
			'POST',
			`/v1/users/${people.customer.id}/sign-in-code`,
			undefined,
			asUser(people.manager.id, 'Mo'),
		);
		expect(issued.json.code).toMatch(/^\d{6}$/);
		expect(Date.parse(issued.json.expiresAt) - env.now()).toBe(15 * 60_000);
		expect(env.messages().length).toBe(before);
		const log = (await server('GET', '/v1/activity?action=user.sign_in_code_issued')).json.items[0];
		expect(log).toMatchObject({ actor: { id: people.manager.id }, label: 'Cal Customer' });
		const viaCode = await env.visitor('POST', '/v1/sign-in/phone', { phone: '07700900002', code: issued.json.code });
		expect(viaCode.json.status).toBe('signed_in');
		expect(code(await env.visitor('POST', '/v1/sign-in/phone', { phone: '07700900002', code: issued.json.code }))).toBe(
			'code_invalid',
		);
		const again = await server('POST', `/v1/users/${people.customer.id}/sign-in-code`);
		const newer = await server('POST', `/v1/users/${people.customer.id}/sign-in-code`);
		expect(
			code(await env.visitor('POST', '/v1/sign-in/phone-password', { phone: '+447700900002', password: again.json.code })),
		).toBe('sign_in_failed');
		const viaPassword = await env.visitor('POST', '/v1/sign-in/phone-password', {
			phone: '+447700900002',
			password: newer.json.code,
		});
		expect(viaPassword.json.status).toBe('signed_in');
		const ticket = await env.ticket();
		const fromWidget = await env.admin(ticket, 'POST', `/v1/admin/users/${people.ada.id}/sign-in-code`);
		expect(fromWidget.json.code).toMatch(/^\d{6}$/);
		const viaEmailCode = await env.visitor('POST', '/v1/sign-in/phone', { phone: '+447700900003', code: fromWidget.json.code });
		expect(viaEmailCode.json.status).toBe('signed_in');
	});

	it('a sign-in code from staff opens its user in the email code screen, but proves no address', async () => {
		const up = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: '07700 900390',
			password: 'own pass 12',
			name: 'Pat',
			email: 'pat@example.com',
		});
		expect(up.json.user).toMatchObject({ email: 'pat@example.com', emailVerified: false });
		const issued = await server('POST', `/v1/users/${up.json.user.id}/sign-in-code`);
		const signedIn = await env.visitor('POST', '/v1/sign-in/email', { email: 'pat@example.com', code: issued.json.code });
		expect(signedIn.json).toMatchObject({ status: 'signed_in', user: { id: up.json.user.id, emailVerified: false } });
		// so a code sent to the address still opens nothing
		await env.visitor('POST', '/v1/sign-in/email/code', { email: 'pat@example.com' });
		const sent = env.messages().at(-1);
		expect(sent).toMatchObject({ template: 'accounts.email_code', to: { email: 'pat@example.com' } });
		expect(
			code(await env.visitor('POST', '/v1/sign-in/email', { email: 'pat@example.com', code: sent.values.code, name: 'E' })),
		).toBe('already_exists');
	});

	it('a setup link sets a password (also without an email address) and signs in; a new link cancels the old', async () => {
		const first = await server('POST', `/v1/users/${people.support.id}/setup-link`);
		expect(first.json.url).toMatch(/^https:\/\/shop\.example\.com\/\?ss_setup=cod_/);
		const second = await server('POST', `/v1/users/${people.support.id}/setup-link`);
		const codeOf = (/** @type {string} */ url) => new URL(url).searchParams.get('ss_setup');
		expect(
			code(await env.visitor('POST', '/v1/setup-links/accept', { code: codeOf(first.json.url), password: 'support pass 1' })),
		).toBe('code_invalid');
		const accepted = await env.visitor('POST', '/v1/setup-links/accept', {
			code: codeOf(second.json.url),
			password: 'support pass 1',
		});
		expect(accepted.json.status).toBe('signed_in');
		expect(accepted.json.user.hasPassword).toBe(true);
		expect(
			(await env.visitor('POST', '/v1/sign-in/phone-password', { phone: '+447700900001', password: 'support pass 1' })).json
				.status,
		).toBe('signed_in');
		await env.setting('staff_links', 'setupPageUrl', `${ORIGIN}/account/setup/{code}`);
		const own = await server('POST', `/v1/users/${people.support.id}/setup-link`);
		expect(own.json.url).toMatch(/^https:\/\/shop\.example\.com\/account\/setup\/cod_[0-9a-z]+\.[\w-]+$/);
		await env.setting('staff_links', 'setupPageUrl', 'https://elsewhere.example.org/{code}');
		const elsewhere = await server('POST', `/v1/users/${people.support.id}/setup-link`);
		expect([code(elsewhere), elsewhere.json.errors[0].path]).toEqual(['validation_failed', '/setupPageUrl']);
		await env.setting('staff_links', 'setupPageUrl', '');
	});

	it('a used setup link proves the phone number and signs the other devices out', async () => {
		const up = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: '07700 900200',
			password: 'own pass 12',
			name: 'Pia',
		});
		expect(up.json.user.phoneVerified).toBe(false);
		const link = await server('POST', `/v1/users/${up.json.user.id}/setup-link`);
		const accepted = await env.visitor('POST', '/v1/setup-links/accept', {
			code: setupCodeOf(link.json.url),
			password: 'set by link 1',
		});
		expect(accepted.json.user).toMatchObject({ phone: '+447700900200', phoneVerified: true });
		expect(claimsOf(accepted.json.signIn)).toMatchObject({ phone: '+447700900200', phone_verified: true });
		expect(code(await env.visitor('POST', '/v1/session/refresh', { refreshToken: up.json.refreshToken }))).toBe('signed_out');
		expect((await env.visitor('POST', '/v1/session/refresh', { refreshToken: accepted.json.refreshToken })).status).toBe(200);
	});

	it('invites can answer the link instead of sending it', async () => {
		await env.switchOn(ALL.filter((key) => !['consents', 'two_step', 'risk_checks'].includes(key)));
		await env.setting('approval', 'invitePageUrl', `${ORIGIN}/join`);
		const before = env.messages().length;
		const invited = await server('POST', '/v1/users/invite', { phone: '+447700900099', name: 'Ivy', deliver: 'return' });
		expect(invited.status).toBe(201);
		expect(invited.json.invite.url).toMatch(/^https:\/\/shop\.example\.com\/join#ss_accounts_invite=cod_/);
		expect(env.messages().length).toBe(before);
		expect(code(await server('POST', '/v1/users/invite', { phone: '+447700900098', deliver: 'post' }))).toBe(
			'validation_failed',
		);
		await env.setting('approval', 'mode', 'open');
	});
});

describe('A5: role requests', () => {
	it('a visitor asks; staff invite with a setup link; the password completes it; decline, reopen and expiry', async () => {
		await server('PUT', '/v1/roles/member', { name: 'Member', permissions: ['site:discount'] });
		expect(code(await env.visitor('POST', '/v1/role-requests', { role: 'member', name: 'Nia', phone: '+447700900100' }))).toBe(
			'validation_failed',
		);
		await env.setting('role_requests', 'requestableRoles', ['member']);
		await env.setting('role_requests', 'requireNote', true);
		// private by default (every ask answers the same, role-requests.test.js); these tests read ids and outcomes
		expect((await env.visitor('GET', '/v1/widget/config')).json.settings.roleRequests.revealStatus).toBe(false);
		await env.setting('role_requests', 'revealStatus', true);
		expect(code(await env.visitor('POST', '/v1/role-requests', { role: 'member', name: 'Nia', phone: '+447700900100' }))).toBe(
			'validation_failed',
		);
		expect(code(await env.visitor('POST', '/v1/role-requests', { role: 'member', name: 'Nia', note: 'Hi' }))).toBe(
			'validation_failed',
		);
		const asked = await env.visitor('POST', '/v1/role-requests', {
			role: 'member',
			name: 'Nia',
			phone: '07700 900100',
			note: 'Hi',
		});
		expect(asked.status).toBe(201);
		expect(asked.json).toMatchObject({ outcome: 'requested', status: 'pending' });
		// a repeat ask makes no second request: it answers what is there
		const again = await env.visitor('POST', '/v1/role-requests', {
			role: 'member',
			name: 'Nia',
			phone: '+447700900100',
			note: 'Hi',
		});
		expect([again.status, again.json]).toEqual([201, { outcome: 'already_requested' }]);
		const config = (await env.visitor('GET', '/v1/widget/config')).json.settings.roleRequests;
		expect(config).toEqual({ roles: [{ key: 'member', name: 'Member' }], requireNote: true, revealStatus: true });

		const ticket = await env.ticket();
		const listed = await env.admin(ticket, 'GET', '/v1/admin/role-requests?status=pending');
		expect(listed.json.items).toMatchObject([{ id: asked.json.id, name: 'Nia', phone: '+447700900100', status: 'pending' }]);
		expect((await env.admin(ticket, 'GET', '/v1/admin/role-requests/count?status=pending')).json.count).toBe(1);
		const invited = await env.admin(ticket, 'POST', `/v1/admin/role-requests/${asked.json.id}/invite`);
		expect(invited.json.request).toMatchObject({ status: 'invited', invitedBy: { kind: 'staff', name: 'Sam Staff' } });
		expect(invited.json.user).toMatchObject({ role: 'member', phone: '+447700900100' });
		const setupCode = new URL(invited.json.setupLink.url).searchParams.get('ss_setup');
		expect(code(await env.admin(ticket, 'POST', `/v1/admin/role-requests/${asked.json.id}/invite`))).toBe('conflict');
		const done = await env.visitor('POST', '/v1/setup-links/accept', { code: setupCode, password: 'member pass 1' });
		expect(done.json.user).toMatchObject({ role: 'member', phoneVerified: true });
		// other products join the new member's guest orders and points by the verified phone
		expect(claimsOf(done.json.signIn)).toMatchObject({ phone: '+447700900100', phone_verified: true });
		const completed = await server('GET', '/v1/role-requests?status=completed');
		expect(completed.json.items[0]).toMatchObject({ id: asked.json.id, status: 'completed' });
		expect((await server('GET', `/v1/users/${invited.json.user.id}`)).json.roleSince).toBeTruthy();

		// an existing user with a password gets the role at once
		const cal = await server('POST', '/v1/users', { name: 'Cal Moss', phone: '07700 900077', password: 'cal pass 1234' });
		const calAsk = await env.visitor('POST', '/v1/role-requests', {
			role: 'member',
			name: 'Cal',
			phone: '07700900077',
			note: 'Me',
		});
		const given = await server('POST', `/v1/role-requests/${calAsk.json.id}/invite`);
		expect(given.json).toMatchObject({
			request: { status: 'completed' },
			setupLink: null,
			user: { id: cal.json.id, role: 'member' },
		});
		// one user, one role: staff asking with their own phone number are never moved down to it (ST-9)
		const sue = await env.visitor('POST', '/v1/role-requests', {
			role: 'member',
			name: 'Sue',
			phone: '07700900001',
			note: 'Me',
		});
		expect(code(await server('POST', `/v1/role-requests/${sue.json.id}/invite`))).toBe('conflict');
		expect((await server('GET', `/v1/users/${people.support.id}`)).json.role).toBe('product_manager');
		await server('POST', `/v1/role-requests/${sue.json.id}/decline`);

		// decline and reopen; an invite whose setup link runs out is expired (judged on read)
		const dee = await env.visitor('POST', '/v1/role-requests', {
			role: 'member',
			name: 'Dee',
			email: 'dee@example.com',
			note: 'x',
		});
		expect((await server('POST', `/v1/role-requests/${dee.json.id}/decline`)).json.status).toBe('declined');
		expect(code(await server('POST', `/v1/role-requests/${dee.json.id}/decline`))).toBe('conflict');
		expect((await server('POST', `/v1/role-requests/${dee.json.id}/reopen`)).json.status).toBe('pending');
		expect(code(await server('POST', `/v1/role-requests/${dee.json.id}/reopen`))).toBe('conflict');
		await server('POST', `/v1/role-requests/${dee.json.id}/invite`);
		env.advance(8 * 86_400_000);
		expect((await server('GET', '/v1/role-requests?status=expired')).json.items.map((/** @type {any} */ r) => r.id)).toEqual([
			dee.json.id,
		]);
		expect((await server('GET', '/v1/role-requests?status=invited')).json.items).toEqual([]);
		expect((await server('POST', `/v1/role-requests/${dee.json.id}/reopen`)).json.status).toBe('pending');
		const counts = await server('GET', '/v1/role-requests/counts?by=status');
		expect(counts.json).toEqual({ total: 4, groups: { completed: 2, pending: 1, declined: 1 } });
		expect(code(await server('POST', '/v1/role-requests/rrq_00000000000000000000000000/decline'))).toBe('not_found');
		expect((await env.admin(ticket, 'POST', `/v1/admin/role-requests/${dee.json.id}/decline`)).status).toBe(401);
	});

	it('an invite gives nothing to a user who never proved the number; staff check first; an untouched user is invited again', async () => {
		/** @param {string} name @param {string} phone */
		const ask = async (name, phone) =>
			(await env.visitor('POST', '/v1/role-requests', { role: 'member', name, phone, note: 'Hi' })).json.id;
		// someone signs up first with Rae's number and a password: the number is not proven
		const squatter = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: '+447700900300',
			password: 'taken pass 1',
			name: 'Not Rae',
		});
		const rae = await ask('Rae', '07700 900300');
		const refused = await server('POST', `/v1/role-requests/${rae}/invite`);
		expect(refused.status).toBe(409);
		expect(code(refused)).toBe('contact_unverified');
		expect((await server('GET', `/v1/users/${squatter.json.user.id}`)).json.role).toBe('customer');
		expect((await server('GET', '/v1/role-requests?status=pending')).json.items.map((/** @type {any} */ r) => r.id)).toContain(
			rae,
		);
		// the account was not Rae's: staff remove it, and Rae is invited with a setup link
		await server('DELETE', `/v1/users/${squatter.json.user.id}`, { reason: 'Not the number owner' });
		const invited = await server('POST', `/v1/role-requests/${rae}/invite`);
		expect(invited.json).toMatchObject({ request: { status: 'invited' }, user: { role: 'member', phoneVerified: false } });
		// an untouched user (the link was never used) is invited again once the link ran out
		env.advance(8 * 86_400_000);
		await server('POST', `/v1/role-requests/${rae}/reopen`);
		const again = await server('POST', `/v1/role-requests/${rae}/invite`);
		expect(again.json).toMatchObject({ request: { status: 'invited' }, user: { id: invited.json.user.id } });
		expect(again.json.setupLink.url).toMatch(/ss_setup=cod_/);

		// the account is Sol's own: staff confirm the number on the user, and the role is given at once
		const sol = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: '+447700900301',
			password: 'sols pass 12',
			name: 'Sol',
		});
		const solRequest = await ask('Sol', '+447700900301');
		expect(code(await server('POST', `/v1/role-requests/${solRequest}/invite`))).toBe('contact_unverified');
		await server('PATCH', `/v1/users/${sol.json.user.id}`, { phone: '+447700900301' });
		const given = await server('POST', `/v1/role-requests/${solRequest}/invite`);
		expect(given.json).toMatchObject({ request: { status: 'completed' }, setupLink: null, user: { role: 'member' } });
	});
});

describe('the admin widgets’ reads', () => {
	it('the Activity widget reads the copies with activity.read; My account names the role', async () => {
		await env.paste('chat');
		const chatToken = (await env.portal.issueToken({ websiteId: env.websiteId, productId: 'accounts', kind: 'server' })).token;
		const copy = {
			websiteId: env.websiteId,
			productId: 'chat',
			actor: { kind: 'user', id: people.manager.id, name: 'Mo', role: 'Business manager' },
			action: 'conversation.assigned',
			target: 'cnv_1',
			label: 'Chat with Nia',
			at: new Date(env.now()).toISOString(),
		};
		expect((await env.call('POST', '/v1/activity-copies', { token: chatToken, body: copy })).status).toBe(201);
		const denied = await env.ticket(['users.read']);
		expect(code(await env.admin(denied, 'GET', '/v1/admin/activity-copies'))).toBe('forbidden');
		const ticket = await env.ticket(['activity.read']);
		const listed = await env.admin(ticket, 'GET', '/v1/admin/activity-copies?productId=chat');
		expect(listed.json.items).toMatchObject([{ action: 'conversation.assigned', label: 'Chat with Nia' }]);
		expect((await env.admin(ticket, 'GET', '/v1/admin/activity-copies/count')).json.count).toBe(1);
		expect((await env.admin(ticket, 'GET', '/v1/admin/activity-copies/counts?by=productId')).json.groups).toEqual({ chat: 1 });
		const member = await env.visitor('POST', '/v1/sign-in/phone-password', {
			phone: '+447700900100',
			password: 'member pass 1',
		});
		const me = await env.visitor('GET', '/v1/me', undefined, member.json.signIn);
		expect(me.json).toMatchObject({ role: 'member', roleName: 'Member' });
		expect(me.json.roleSince).toBeTruthy();
	});
});

describe('the Users widget’s actions', () => {
	it('adds a user, gives a setup link, signs them out and removes them; counts, declines and reopens requests', async () => {
		const ticket = await env.ticket();
		const added = await env.admin(ticket, 'POST', '/v1/admin/users', { name: 'Wendy Widget', phone: '07700 900400' });
		expect(added.status).toBe(201);
		expect(added.json).toMatchObject({ name: 'Wendy Widget', phone: '+447700900400', phoneVerified: true, status: 'active' });
		const link = await env.admin(ticket, 'POST', `/v1/admin/users/${added.json.id}/setup-link`);
		const accepted = await env.visitor('POST', '/v1/setup-links/accept', {
			code: setupCodeOf(link.json.url),
			password: 'wendy pass 12',
		});
		expect(accepted.json.status).toBe('signed_in');
		// the merchant's server signs her out everywhere: her refresh token no longer renews
		expect((await server('POST', `/v1/users/${added.json.id}/sign-out`)).status).toBe(204);
		expect(code(await env.visitor('POST', '/v1/session/refresh', { refreshToken: accepted.json.refreshToken }))).toBe(
			'signed_out',
		);
		const removed = await env.admin(ticket, 'DELETE', `/v1/admin/users/${added.json.id}?scope=accounts`, {
			reason: 'Left the team',
		});
		expect(removed.json).toEqual({ deleted: true, pending: [] });
		expect(code(await server('GET', `/v1/users/${added.json.id}`))).toBe('not_found');

		const pending = async () => (await server('GET', '/v1/role-requests/count?status=pending&role=member')).json;
		const before = (await pending()).count;
		const asked = await env.visitor('POST', '/v1/role-requests', {
			role: 'member',
			name: 'Ira',
			email: 'ira@example.com',
			note: 'Hi',
		});
		expect(await pending()).toEqual({ count: before + 1, capped: false });
		const counts = await env.admin(ticket, 'GET', '/v1/admin/role-requests/counts?by=role&status=pending');
		expect(counts.json).toEqual({ total: before + 1, groups: { member: before + 1 } });
		const declined = await env.admin(ticket, 'POST', `/v1/admin/role-requests/${asked.json.id}/decline`);
		expect(declined.json).toMatchObject({ id: asked.json.id, status: 'declined', email: 'ira@example.com' });
		const reopened = await env.admin(ticket, 'POST', `/v1/admin/role-requests/${asked.json.id}/reopen`);
		expect(reopened.json).toMatchObject({ id: asked.json.id, status: 'pending', invitedAt: null });
	});
});

describe('A5: user tags and saved views of the users list', () => {
	it('tags a user, lists the tags with their counts, and finds users by any tag', async () => {
		const tagged = await create({ name: 'Tia Tagged', email: 'tia@example.com', tags: [' VIP ', 'Wholesale', 'vip'] });
		expect(tagged.tags).toEqual(['VIP', 'Wholesale']);
		expect(code(await server('POST', '/v1/users', { name: 'Bad', email: 'bad@example.com', tags: ['x'.repeat(41)] }))).toBe(
			'validation_failed',
		);
		expect(code(await server('PATCH', `/v1/users/${tagged.id}`, { tags: 'VIP' }))).toBe('validation_failed');
		const patched = await server('PATCH', `/v1/users/${tagged.id}`, { tags: ['VIP', 'Newsletter'] });
		expect(patched.json.tags).toEqual(['VIP', 'Newsletter']);
		await server('PATCH', `/v1/users/${people.customer.id}`, { tags: ['VIP'] });
		/** @param {string} query */
		const ids = async (query) =>
			(await server('GET', `/v1/users?${query}`)).json.items.map((/** @type {any} */ u) => u.id).sort();
		expect(await ids('tags=VIP')).toEqual([tagged.id, people.customer.id].sort());
		expect(await ids('tags=Newsletter,Nothing')).toEqual([tagged.id]);
		expect((await server('GET', '/v1/users/count?tags=VIP')).json.count).toBe(2);
		expect((await server('GET', '/v1/users/tags')).json.items).toEqual([
			{ tag: 'Newsletter', users: 1 },
			{ tag: 'VIP', users: 2 },
		]);
		const changed = (await server('GET', `/v1/activity?action=user.tags_changed&target=${tagged.id}`)).json.items[0];
		expect(changed.values).toEqual({ added: 'Newsletter', removed: 'Wholesale' });
	});

	it('saves named views of the list’s filters, renames, orders and deletes them', async () => {
		const saved = await server('PUT', '/v1/users/views/vip_customers', {
			name: 'VIP customers',
			query: { tags: 'VIP', role: 'customer', status: 'active' },
		});
		expect(saved.json).toEqual({
			key: 'vip_customers',
			name: 'VIP customers',
			query: { tags: 'VIP', role: 'customer', status: 'active' },
		});
		await server('PUT', '/v1/users/views/waiting', { name: 'Waiting', query: { status: 'pending' } });
		expect(code(await server('PUT', '/v1/users/views/bad', { name: 'Bad', query: { password: 'x' } }))).toBe(
			'validation_failed',
		);
		expect(code(await server('PUT', '/v1/users/views/bad', { name: '', query: {} }))).toBe('validation_failed');
		expect((await server('GET', '/v1/users/views')).json.items.map((/** @type {any} */ v) => v.key)).toEqual([
			'vip_customers',
			'waiting',
		]);
		await server('PUT', '/v1/users/views/waiting', { name: 'Waiting for approval', query: { status: 'pending' } });
		const ordered = await server('PUT', '/v1/users/views', { order: ['waiting', 'vip_customers'] });
		expect(ordered.json.items.map((/** @type {any} */ v) => v.name)).toEqual(['Waiting for approval', 'VIP customers']);
		expect(code(await server('PUT', '/v1/users/views', { order: ['waiting'] }))).toBe('validation_failed');
		// the admin widget reads them with a ticket and changes them with users.manage
		const reader = await env.ticket(['users.read']);
		expect((await env.admin(reader, 'GET', '/v1/admin/users/views')).json.items).toHaveLength(2);
		expect(code(await env.admin(reader, 'DELETE', '/v1/admin/users/views/waiting'))).toBe('forbidden');
		const manager = await env.ticket(['users.read', 'users.manage']);
		expect((await env.admin(manager, 'DELETE', '/v1/admin/users/views/waiting')).status).toBe(204);
		expect((await server('GET', '/v1/users/views')).json.items.map((/** @type {any} */ v) => v.key)).toEqual(['vip_customers']);
	});
});
