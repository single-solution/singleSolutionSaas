/**
 * Role requests and setup links for stores that onboard with their membership flow (P4 of audit/parity-plan.md; PLAN
 * 0.8.10 A3, A5): a repeat ask answers what is already there and changes nothing; staff give an invited request a new
 * link or decline it (the link stops working and what the invite did is undone); `giveRoleAt` gives the role when the
 * setup link is completed instead of at the invite (default unchanged); and the setup-link lookup a setup page reads
 * before the password, which tells only the holder of the whole code anything.
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
 * A server-token call, optionally as an acting user (K2).
 * @param {string} method @param {string} path @param {unknown} [body] @param {string | null} [as] the acting user's id
 */
const server = (method, path, body, as = null) =>
	env.call(method, path, {
		token: env.server,
		...(body === undefined ? {} : { body }),
		headers: as ? { 'ss-actor-id': as, 'ss-actor-name': 'Staff' } : {},
	});
/** A visitor asks for the member role. @param {Record<string, unknown>} body */
const ask = (body) => env.visitor('POST', '/v1/role-requests', { role: 'member', ...body });
/** The code of a setup link. @param {string} url */
const codeOf = (url) => String(new URL(url).searchParams.get('ss_setup'));
/** @param {unknown} linkCode */
const lookup = (linkCode) => env.visitor('POST', '/v1/setup-links/lookup', { code: linkCode });
/** @param {string} linkCode @param {string} password */
const accept = (linkCode, password) => env.visitor('POST', '/v1/setup-links/accept', { code: linkCode, password });
/** @param {string} id */
const userOf = (id) => server('GET', `/v1/users/${id}`);
/** @param {string} id */
const requestOf = async (id) =>
	(await server('GET', '/v1/role-requests?limit=100')).json.items.find((/** @type {any} */ r) => r.id === id);
/** The claims of a sign-in. @param {string} signIn */
const claimsOf = (signIn) => JSON.parse(Buffer.from(String(signIn.split('.')[1]), 'base64url').toString('utf8'));
const DAY = 86_400_000;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL.filter((key) => !['terms', 'approval', 'two_step', 'risk_checks'].includes(key)));
	await env.connectDatabase();
	await env.paste('notifications');
	await env.setting('phone', 'defaultCallingCode', '+44');
	await env.setting('phone', 'trunkPrefix', '0');
	await server('PUT', '/v1/roles/member', { name: 'Member', permissions: ['site:discount'] });
	await server('PUT', '/v1/roles/wholesale', { name: 'Wholesale', permissions: [] });
	await env.setting('role_requests', 'requestableRoles', ['member', 'wholesale']);
});
afterAll(async () => {
	await env.product.close();
});

describe('a repeat ask answers what is there', () => {
	it('already requested, invited, invite expired or already a member; nothing is made or overwritten', async () => {
		const first = await ask({ name: 'Ada Lane', phone: '07700 900500', note: 'First' });
		expect(first.status).toBe(201);
		expect(first.json).toEqual({ outcome: 'requested', id: expect.stringMatching(/^rrq_/), status: 'pending' });
		// someone else typing the same number changes nothing (no name or note is overwritten)
		const repeat = await ask({ name: 'Somebody Else', phone: '+447700900500', note: 'Overwrite' });
		expect([repeat.status, repeat.json]).toEqual([201, { outcome: 'already_requested' }]);
		const mine = (await server('GET', '/v1/role-requests?status=pending')).json.items.filter(
			(/** @type {any} */ r) => r.phone === '+447700900500',
		);
		expect(mine).toEqual([expect.objectContaining({ id: first.json.id, name: 'Ada Lane', note: 'First' })]);
		// a repeat passes the checks of a new ask
		expect(code(await ask({ name: '', phone: '+447700900500' }))).toBe('validation_failed');
		await env.setting('role_requests', 'requireNote', true);
		expect(code(await ask({ name: 'Ada Lane', phone: '+447700900500' }))).toBe('validation_failed');
		await env.setting('role_requests', 'requireNote', false);
		// another role is another request
		expect((await ask({ role: 'wholesale', name: 'Ada Lane', phone: '07700900500' })).json.outcome).toBe('requested');
		// by email when no phone is given (the address as normalized)
		expect((await ask({ name: 'Bo Hart', email: 'bo@example.com' })).json.outcome).toBe('requested');
		expect((await ask({ name: 'Bo Hart', email: 'BO@example.com' })).json).toEqual({ outcome: 'already_requested' });

		// invited: its link works, then runs out
		const invited = await server('POST', `/v1/role-requests/${first.json.id}/invite`);
		expect(invited.json.request.status).toBe('invited');
		expect((await ask({ name: 'Ada Lane', phone: '07700900500' })).json).toEqual({ outcome: 'already_invited' });
		env.advance(8 * DAY);
		expect((await ask({ name: 'Ada Lane', phone: '07700900500' })).json).toEqual({ outcome: 'invite_expired' });
		expect((await requestOf(first.json.id)).status).toBe('expired');

		// a member: the user holding the proven number has the role
		const renewed = await server('POST', `/v1/role-requests/${first.json.id}/setup-link`);
		expect((await accept(codeOf(renewed.json.setupLink.url), 'ada pass 1234')).json.user).toMatchObject({
			role: 'member',
			phoneVerified: true,
		});
		expect((await ask({ name: 'Ada Lane', phone: '07700900500' })).json).toEqual({ outcome: 'already_member' });
		// by email: a proven address
		const cleo = await server('POST', '/v1/users', { name: 'Cleo Park', email: 'cleo@example.com', role: 'member' });
		expect((await ask({ name: 'Cleo Park', email: 'cleo@example.com' })).json).toEqual({ outcome: 'already_member' });
		expect(cleo.json.emailVerified).toBe(true);
		// a number someone typed but never proved is no member: a request is made, and staff check before an invite
		const squatter = await env.visitor('POST', '/v1/sign-up/phone-password', {
			phone: '+447700900510',
			password: 'squat pass 12',
			name: 'Not Cy',
		});
		await server('PATCH', `/v1/users/${squatter.json.user.id}`, { role: 'member' });
		const cy = await ask({ name: 'Cy Moss', phone: '07700 900510' });
		expect(cy.json.outcome).toBe('requested');
		expect(code(await server('POST', `/v1/role-requests/${cy.json.id}/invite`))).toBe('contact_unverified');
	});
});

describe('staff: a new link or a decline for an invited request', () => {
	it('a new link replaces the old one, also once it ran out; a user with a password completes at once', async () => {
		const asked = await ask({ name: 'Nel Ford', phone: '07700 900560' });
		expect(code(await server('POST', `/v1/role-requests/${asked.json.id}/setup-link`))).toBe('conflict');
		const invited = await server('POST', `/v1/role-requests/${asked.json.id}/invite`);
		const old = codeOf(invited.json.setupLink.url);
		env.advance(DAY);
		const fresh = await server('POST', `/v1/role-requests/${asked.json.id}/setup-link`);
		expect(fresh.json.request).toMatchObject({ status: 'invited', setupExpiresAt: fresh.json.setupLink.expiresAt });
		expect(fresh.json.user).toMatchObject({ id: invited.json.user.id, role: 'member' });
		expect(Date.parse(fresh.json.setupLink.expiresAt) - env.now()).toBe(7 * DAY);
		expect((await lookup(old)).json).toEqual({ status: 'canceled' });
		expect(code(await accept(old, 'nel pass 1234'))).toBe('code_invalid');
		// once the link ran out, staff (with a ticket) give another
		env.advance(8 * DAY);
		expect((await requestOf(asked.json.id)).status).toBe('expired');
		const ticket = await env.ticket();
		const again = await env.admin(ticket, 'POST', `/v1/admin/role-requests/${asked.json.id}/setup-link`);
		expect(again.json.request).toMatchObject({ status: 'invited', invitedBy: { kind: 'staff', name: 'Sam Staff' } });
		expect((await lookup(codeOf(fresh.json.setupLink.url))).json).toEqual({ status: 'expired' });
		const done = await accept(codeOf(again.json.setupLink.url), 'nel pass 1234');
		expect(done.json.user.role).toBe('member');
		expect((await requestOf(asked.json.id)).status).toBe('completed');
		expect(code(await server('POST', `/v1/role-requests/${asked.json.id}/setup-link`))).toBe('conflict');
		const logged = await server('GET', '/v1/activity?action=role_request.link_renewed');
		expect(logged.json.items[0]).toMatchObject({ target: asked.json.id, label: 'Nel Ford' });

		// the user has a password by now: the request is completed at once
		const pia = await ask({ name: 'Pia Vale', phone: '07700 900561' });
		const piaInvite = await server('POST', `/v1/role-requests/${pia.json.id}/invite`);
		await server('PATCH', `/v1/users/${piaInvite.json.user.id}`, { password: 'pia pass 1234' });
		const completed = await server('POST', `/v1/role-requests/${pia.json.id}/setup-link`);
		expect(completed.json).toMatchObject({ request: { status: 'completed' }, setupLink: null, user: { role: 'member' } });

		// the user is gone: decline it, open it again and invite
		const quin = await ask({ name: 'Quin Hale', phone: '07700 900562' });
		const quinInvite = await server('POST', `/v1/role-requests/${quin.json.id}/invite`);
		await server('DELETE', `/v1/users/${quinInvite.json.user.id}?scope=accounts`, { reason: 'Test' });
		expect(code(await server('POST', `/v1/role-requests/${quin.json.id}/setup-link`))).toBe('conflict');
		expect(code(await server('POST', '/v1/role-requests/rrq_00000000000000000000000000/setup-link'))).toBe('not_found');

		// a setup link from the Users screen replaces the request's link: the request ends with the new one
		const rio = await ask({ name: 'Rio Dunn', phone: '07700 900563' });
		const rioInvite = await server('POST', `/v1/role-requests/${rio.json.id}/invite`);
		env.advance(2 * DAY);
		const usersLink = await server('POST', `/v1/users/${rioInvite.json.user.id}/setup-link`);
		expect((await requestOf(rio.json.id)).setupExpiresAt).toBe(usersLink.json.expiresAt);
		expect((await lookup(codeOf(rioInvite.json.setupLink.url))).json).toEqual({ status: 'canceled' });
	});

	it('a decline cancels the link and undoes the invite: a user it made is removed, a role it gave goes back', async () => {
		// the invite made the user, who never signed in: removed
		const dee = await ask({ name: 'Dee Park', phone: '07700 900520' });
		const deeInvite = await server('POST', `/v1/role-requests/${dee.json.id}/invite`);
		const deeLink = codeOf(deeInvite.json.setupLink.url);
		expect((await lookup(deeLink)).json.status).toBe('valid');
		const declined = await server('POST', `/v1/role-requests/${dee.json.id}/decline`);
		expect(declined.json).toMatchObject({ status: 'declined', userId: null });
		expect(code(await userOf(deeInvite.json.user.id))).toBe('not_found');
		expect(code(await accept(deeLink, 'dee pass 1234'))).toBe('code_invalid');
		expect((await lookup(deeLink)).json).toEqual({ status: 'invalid' });
		expect(code(await server('POST', `/v1/role-requests/${dee.json.id}/decline`))).toBe('conflict');
		const logged = await server('GET', '/v1/activity?action=role_request.declined');
		expect(logged.json.items[0].detail).toContain('the user the invite made was removed');
		// open again and invite: a new user, a new link
		await server('POST', `/v1/role-requests/${dee.json.id}/reopen`);
		const deeAgain = await server('POST', `/v1/role-requests/${dee.json.id}/invite`);
		expect(deeAgain.json.user.id).not.toBe(deeInvite.json.user.id);

		// an existing user the invite gave the role to: their role from before comes back, the account stays
		const kim = await server('POST', '/v1/users', { name: 'Kim Rae', phone: '07700 900530' });
		const kimAsk = await ask({ name: 'Kim Rae', phone: '07700900530' });
		const kimInvite = await server('POST', `/v1/role-requests/${kimAsk.json.id}/invite`);
		expect(kimInvite.json.user).toMatchObject({ id: kim.json.id, role: 'member' });
		const kimDeclined = await server('POST', `/v1/role-requests/${kimAsk.json.id}/decline`);
		expect(kimDeclined.json).toMatchObject({ status: 'declined', userId: kim.json.id });
		expect((await userOf(kim.json.id)).json.role).toBe('customer');
		expect((await lookup(codeOf(kimInvite.json.setupLink.url))).json).toEqual({ status: 'canceled' });

		// a user the invite made who signed in another way (a phone code) keeps the account, without the role
		const lu = await ask({ name: 'Lu Chen', phone: '07700 900540' });
		const luInvite = await server('POST', `/v1/role-requests/${lu.json.id}/invite`);
		await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '+447700900540' });
		const sent = String(env.messages().at(-1).values.code);
		const signedIn = await env.visitor('POST', '/v1/sign-in/phone', { phone: '+447700900540', code: sent });
		expect(signedIn.json.user.role).toBe('member');
		await server('POST', `/v1/role-requests/${lu.json.id}/decline`);
		expect((await userOf(luInvite.json.user.id)).json).toMatchObject({ role: 'customer', phoneVerified: true });

		// an expired request is declined too; its link stays expired
		const mo = await ask({ name: 'Mo Tran', phone: '07700 900541' });
		const moInvite = await server('POST', `/v1/role-requests/${mo.json.id}/invite`);
		env.advance(8 * DAY);
		expect((await server('POST', `/v1/role-requests/${mo.json.id}/decline`)).json.status).toBe('declined');
		expect(code(await userOf(moInvite.json.user.id))).toBe('not_found');

		// a completed request cannot be declined
		const ned = await ask({ name: 'Ned Cole', phone: '07700 900542' });
		const nedInvite = await server('POST', `/v1/role-requests/${ned.json.id}/invite`);
		await accept(codeOf(nedInvite.json.setupLink.url), 'ned pass 1234');
		expect(code(await server('POST', `/v1/role-requests/${ned.json.id}/decline`))).toBe('conflict');
		expect((await userOf(nedInvite.json.user.id)).json.role).toBe('member');
	});

	it('the guards apply to a decline before anything changes', async () => {
		const max = await ask({ name: 'Max Bell', phone: '07700 900550' });
		const invite = await server('POST', `/v1/role-requests/${max.json.id}/invite`);
		// an acting user whose role ranks below the member role
		const low = await server('POST', '/v1/users', { name: 'Low Rank', email: 'low@example.com' });
		const refused = await server('POST', `/v1/role-requests/${max.json.id}/decline`, undefined, low.json.id);
		expect(code(refused)).toBe('forbidden');
		expect((await lookup(codeOf(invite.json.setupLink.url))).json.status).toBe('valid');
		expect((await requestOf(max.json.id)).status).toBe('invited');
		expect((await userOf(invite.json.user.id)).json.role).toBe('member');
		const ticket = await env.ticket();
		expect((await env.admin(ticket, 'POST', `/v1/admin/role-requests/${max.json.id}/decline`)).json.status).toBe('declined');
	});
});

describe('giveRoleAt: the role when the setup link is completed', () => {
	it('a new user starts as a customer, an existing one keeps their role; the completed setup gives it', async () => {
		// by default the invite gives the role (today's behavior)
		const byDefault = await ask({ name: 'Ola Byrne', phone: '07700 900569' });
		expect((await server('POST', `/v1/role-requests/${byDefault.json.id}/invite`)).json.user.role).toBe('member');
		await env.setting('role_requests', 'giveRoleAt', 'completion');
		const oli = await ask({ name: 'Oli Grant', phone: '07700 900570' });
		const invited = await server('POST', `/v1/role-requests/${oli.json.id}/invite`);
		expect(invited.json.user.role).toBe('customer');
		expect(invited.json.request.status).toBe('invited');
		const done = await accept(codeOf(invited.json.setupLink.url), 'oli pass 1234');
		expect(done.json.user.role).toBe('member');
		expect(claimsOf(done.json.signIn).role).toBe('member');
		expect((await requestOf(oli.json.id)).status).toBe('completed');

		// an existing user keeps their role until the setup is completed
		const pat = await server('POST', '/v1/users', { name: 'Pat Webb', phone: '07700 900571', role: 'support_staff' });
		const patAsk = await ask({ name: 'Pat Webb', phone: '07700900571' });
		const patInvite = await server('POST', `/v1/role-requests/${patAsk.json.id}/invite`);
		expect(patInvite.json.user).toMatchObject({ id: pat.json.id, role: 'support_staff' });
		// a decline before then changes no role
		await server('POST', `/v1/role-requests/${patAsk.json.id}/decline`);
		expect((await userOf(pat.json.id)).json.role).toBe('support_staff');

		// a user with a password: completed at once, the role given now
		const sol = await server('POST', '/v1/users', { name: 'Sol Park', phone: '07700 900572', password: 'sol pass 1234' });
		const solAsk = await ask({ name: 'Sol Park', phone: '07700900572' });
		const solInvite = await server('POST', `/v1/role-requests/${solAsk.json.id}/invite`);
		expect(solInvite.json).toMatchObject({ request: { status: 'completed' }, setupLink: null, user: { role: 'member' } });
		expect((await userOf(sol.json.id)).json.role).toBe('member');

		// a user the invite made, declined before completing: removed
		const tia = await ask({ name: 'Tia Ross', phone: '07700 900573' });
		const tiaInvite = await server('POST', `/v1/role-requests/${tia.json.id}/invite`);
		await server('POST', `/v1/role-requests/${tia.json.id}/decline`);
		expect(code(await userOf(tiaInvite.json.user.id))).toBe('not_found');

		// each request keeps what its invite said, whatever the setting is later
		const uma = await ask({ name: 'Uma Bright', phone: '07700 900574' });
		const umaInvite = await server('POST', `/v1/role-requests/${uma.json.id}/invite`);
		await env.setting('role_requests', 'giveRoleAt', 'invite');
		expect((await accept(codeOf(umaInvite.json.setupLink.url), 'uma pass 1234')).json.user.role).toBe('member');
		const vic = await ask({ name: 'Vic Lowe', phone: '07700 900575' });
		const vicInvite = await server('POST', `/v1/role-requests/${vic.json.id}/invite`);
		expect(vicInvite.json.user.role).toBe('member');
		await env.setting('role_requests', 'giveRoleAt', 'completion');
		// staff moved the user to another role meanwhile: completing the setup leaves that alone
		await server('PATCH', `/v1/users/${vicInvite.json.user.id}`, { role: 'customer' });
		expect((await accept(codeOf(vicInvite.json.setupLink.url), 'vic pass 1234')).json.user.role).toBe('customer');

		// opened again after its link ran out and invited anew under completion: the role the first invite gave stays
		// given, so a decline still takes it back
		await env.setting('role_requests', 'giveRoleAt', 'invite');
		const wes = await ask({ name: 'Wes Kerr', phone: '07700 900576' });
		const wesFirst = await server('POST', `/v1/role-requests/${wes.json.id}/invite`);
		await env.visitor('POST', '/v1/sign-in/phone/code', { phone: '+447700900576' });
		const sent = String(env.messages().at(-1).values.code);
		expect((await env.visitor('POST', '/v1/sign-in/phone', { phone: '+447700900576', code: sent })).json.user.role).toBe(
			'member',
		);
		env.advance(8 * DAY);
		await server('POST', `/v1/role-requests/${wes.json.id}/reopen`);
		await env.setting('role_requests', 'giveRoleAt', 'completion');
		const wesAgain = await server('POST', `/v1/role-requests/${wes.json.id}/invite`);
		expect(wesAgain.json.user).toMatchObject({ id: wesFirst.json.user.id, role: 'member' });
		await server('POST', `/v1/role-requests/${wes.json.id}/decline`);
		expect((await userOf(wesFirst.json.user.id)).json.role).toBe('customer');
		await env.setting('role_requests', 'giveRoleAt', 'invite');
	});
});

describe('the setup-link lookup', () => {
	it('valid with the name and the last 4 digits only; expired, used and canceled; nothing for a wrong code', async () => {
		const rae = await server('POST', '/v1/users', { name: 'Rae Quinn', phone: '07700 900580', email: 'rae@example.com' });
		const link = await server('POST', `/v1/users/${rae.json.id}/setup-link`);
		const linkCode = codeOf(link.json.url);
		const valid = await lookup(linkCode);
		expect(valid.status).toBe(200);
		expect(valid.json).toEqual({ status: 'valid', name: 'Rae Quinn', phoneLast4: '0580', expiresAt: link.json.expiresAt });
		expect(valid.text).not.toContain('rae@example.com');
		expect(valid.text).not.toContain('7700900580');
		// only the whole code learns anything: a wrong secret, an unknown id, another kind of code or nonsense are invalid
		const [id, secret] = linkCode.split('.');
		for (const wrong of [
			`${id}.${'A'.repeat(43)}`,
			`cod_${'0'.repeat(26)}.${secret}`,
			'nonsense',
			'',
			42,
			null,
			`${id}.${secret}.x`,
		])
			expect((await lookup(wrong)).json).toEqual({ status: 'invalid' });
		expect((await env.visitor('POST', '/v1/setup-links/lookup', {})).json).toEqual({ status: 'invalid' });

		// a user without a phone number: no digits
		const em = await server('POST', '/v1/users', { name: 'Em Stone', email: 'em@example.com' });
		const emLink = await server('POST', `/v1/users/${em.json.id}/setup-link`);
		expect((await lookup(codeOf(emLink.json.url))).json).toMatchObject({ status: 'valid', phoneLast4: null });

		// used
		const raeIn = await accept(linkCode, 'rae pass 1234');
		expect((await lookup(linkCode)).json).toEqual({ status: 'used' });
		// the code of another kind of single-use link (a data export) is no setup link
		const exported = await env.visitor('POST', '/v1/me/export', undefined, raeIn.json.signIn);
		expect((await lookup(String(exported.json.url).split('/').pop())).json).toEqual({ status: 'invalid' });
		// canceled by a newer link, which itself runs out
		const first = await server('POST', `/v1/users/${em.json.id}/setup-link`);
		const second = await server('POST', `/v1/users/${em.json.id}/setup-link`);
		expect((await lookup(codeOf(emLink.json.url))).json).toEqual({ status: 'canceled' });
		expect((await lookup(codeOf(first.json.url))).json).toEqual({ status: 'canceled' });
		env.advance(7 * DAY);
		expect((await lookup(codeOf(second.json.url))).json).toEqual({ status: 'expired' });
		// a link is known 30 days past its end, then it is invalid
		env.advance(30 * DAY + 1000);
		expect((await lookup(codeOf(second.json.url))).json).toEqual({ status: 'invalid' });
		expect((await lookup(linkCode)).json).toEqual({ status: 'invalid' });

		// a link made before traces were kept: valid while it works
		const fay = await server('POST', '/v1/users', { name: 'Fay Holt', phone: '07700 900581' });
		const fayLink = await server('POST', `/v1/users/${fay.json.id}/setup-link`);
		await (await env.store()).codes.removeSetupTraces(fay.json.id);
		expect((await lookup(codeOf(fayLink.json.url))).json).toMatchObject({ status: 'valid', name: 'Fay Holt' });
		// its user removed from Accounts: invalid
		await server('DELETE', `/v1/users/${fay.json.id}?scope=accounts`, { reason: 'Test' });
		expect((await lookup(codeOf(fayLink.json.url))).json).toEqual({ status: 'invalid' });
	});

	it('the merchant’s own setup page asks from its server; the lookup is rate-limited per visitor; off with its features', async () => {
		const gus = await server('POST', '/v1/users', { name: 'Gus Hale', phone: '07700 900590' });
		const link = await server('POST', `/v1/users/${gus.json.id}/setup-link`);
		const linkCode = codeOf(link.json.url);
		const viaServer = await env.call('POST', '/v1/setup-links/lookup', {
			token: env.server,
			body: { code: linkCode },
			headers: { 'ss-visitor-ip': '198.51.100.7' },
		});
		expect(viaServer.json).toMatchObject({ status: 'valid', name: 'Gus Hale', phoneLast4: '0590' });
		expect(code(await env.call('POST', '/v1/setup-links/lookup', { token: env.server, body: { code: linkCode } }))).toBe(
			'visitor_ip_required',
		);
		// 6 a minute from one visitor (as accepting a link)
		env.setNetwork('198.51.100.20');
		for (let i = 0; i < 6; i += 1) expect((await lookup(`cod_${'1'.repeat(26)}.${'B'.repeat(43)}`)).status).toBe(200);
		const limited = await lookup(linkCode);
		expect([limited.status, code(limited)]).toEqual([429, 'rate_limited']);
		env.setNetwork(null);
		expect((await lookup(linkCode)).json.status).toBe('valid');
		// with Staff sign-in codes and setup links and Role requests both off, there is no lookup (as no accept)
		await env.switchOn(
			ALL.filter((key) => !['terms', 'approval', 'two_step', 'risk_checks', 'staff_links', 'role_requests'].includes(key)),
		);
		expect(code(await lookup(linkCode))).toBe('feature_off');
		await env.switchOn(ALL.filter((key) => !['terms', 'approval', 'two_step', 'risk_checks'].includes(key)));
	});
});
