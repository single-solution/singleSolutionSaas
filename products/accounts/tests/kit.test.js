/**
 * Accounts on the shared kit's store-conversion features (PLAN 0.8.10 K2–K4, K7–K9): visitor calls from the merchant's
 * server, the acting user and the labels of Accounts' own activity log, counts with the list's filters, activity-log
 * copies with the kit's filters and counts, the Format and the business time zone, and the kit guide in /docs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** @param {{ json: any }} res */
const code = (res) =>
	String(res.json?.type ?? '')
		.split('/')
		.pop();

/** A member of the merchant's staff acting through the merchant's server (K2). */
const ZOE = Object.freeze({
	'ss-actor-id': 'usr_staff1',
	'ss-actor-name': encodeURIComponent('Zoë Staff'),
	'ss-actor-role': encodeURIComponent('Business manager'),
});
const ZOE_ACTOR = { kind: 'user', id: 'usr_staff1', name: 'Zoë Staff', role: 'Business manager' };
const SERVER_ACTOR = { kind: 'server', id: 'server', name: 'Server' };

/**
 * A server-token call (no Origin), optionally for one visitor (`SS-Visitor-IP`) and by an acting user.
 * @param {string} method @param {string} path
 * @param {{ body?: unknown, ip?: string, signIn?: string, headers?: Record<string, string> }} [init]
 */
const fromServer = (method, path, { body, ip, signIn, headers = {} } = {}) =>
	env.call(method, path, {
		token: env.server,
		...(body === undefined ? {} : { body }),
		...(signIn ? { signIn } : {}),
		headers: { ...(ip ? { 'ss-visitor-ip': ip } : {}), ...headers },
	});

/** @param {string} email @param {string} name */
const signUp = (email, name) => env.visitor('POST', '/v1/sign-up/password', { email, name, password: 'correct horse battery' });

/** @param {string} email */
const signIn = (email) => env.visitor('POST', '/v1/sign-in/password', { email, password: 'correct horse battery' });

/** The user with an e-mail address, as the server sees it. @param {string} email */
const userOf = async (email) => (await fromServer('GET', `/v1/users?q=${encodeURIComponent(email)}`)).json.items[0];

/** Accounts' own activity log (the kit's read), newest first. @param {string} query */
const activity = async (query) => (await fromServer('GET', `/v1/activity?${query}`)).json.items;

beforeAll(async () => {
	env = await setup();
	await env.switchOn(['email_password', 'roles', 'approval', 'data_rights', 'activity_copies', 'risk_checks']);
	await env.connectDatabase();
	await env.paste('notifications');
	// the business keeps Karachi time (UTC+5): calendar days are its days (K8)
	env.responders.set(`${ORIGIN}/.well-known/business.json`, () => ({
		status: 200,
		body: { name: 'Shop', timeZone: 'Asia/Karachi' },
	}));
	await env.refreshBusiness();
});
afterAll(async () => {
	await env.product.close();
});

describe('visitor calls from the merchant’s server (K3)', () => {
	it('signs up, reads My account, renews and resets with the server token and SS-Visitor-IP', async () => {
		await env.setting('approval', 'mode', 'open');
		const body = { email: 'srv@example.com', name: 'Sid Server', password: 'correct horse battery' };
		// writes name the visitor
		expect(code(await fromServer('POST', '/v1/sign-up/password', { body }))).toBe('visitor_ip_required');
		const up = await fromServer('POST', '/v1/sign-up/password', { body, ip: '198.51.100.20' });
		expect(up.status).toBe(200);
		expect(up.json.status).toBe('signed_in');
		expect(up.headers.get('access-control-allow-origin')).toBeNull();
		// reads of a signed-in visitor need no address
		expect((await fromServer('GET', '/v1/me', { signIn: up.json.signIn })).json.email).toBe('srv@example.com');
		const renewed = await fromServer('POST', '/v1/session/refresh', {
			body: { refreshToken: up.json.refreshToken },
			ip: '198.51.100.20',
		});
		expect(renewed.json.status).toBe('signed_in');
		// return addresses are still checked against the website's domain, with no Origin to go by
		const forgot = await fromServer('POST', '/v1/password/forgot', {
			body: { email: 'srv@example.com', returnTo: `${ORIGIN}/account/reset` },
			ip: '198.51.100.20',
		});
		expect(forgot.status).toBe(202);
		const elsewhere = await fromServer('POST', '/v1/password/forgot', {
			body: { email: 'srv@example.com', returnTo: 'https://elsewhere.example.net/reset' },
			ip: '198.51.100.20',
		});
		expect(code(elsewhere)).toBe('validation_failed');
		expect(String(env.messages().at(-1)?.values.link)).toContain(`${ORIGIN}/account/reset#`);
	});

	it('risk checks count sign-ups per network by the visitor’s SS-Visitor-IP, not the server’s address', async () => {
		await env.setting('risk_checks', 'maxSignUpsPerNetworkPerDay', 1);
		const body = (/** @type {string} */ email) => ({ email, name: 'Net Test', password: 'correct horse battery' });
		// the server's own address changes on every request (helpers), the visitor's stays the same
		expect(code(await fromServer('POST', '/v1/sign-up/password', { body: body('n2@example.com'), ip: '198.51.100.20' }))).toBe(
			'risk_refused',
		);
		const other = await fromServer('POST', '/v1/sign-up/password', { body: body('n3@example.com'), ip: '198.51.100.21' });
		expect(other.json.status).toBe('signed_in');
		await env.setting('risk_checks', 'maxSignUpsPerNetworkPerDay', 1000);
		await env.setting('approval', 'mode', 'approval');
	});
});

describe('the acting user and the labels of Accounts’ own activity log (K2, K9)', () => {
	it('records the staff member named by SS-Actor headers, the ticket’s user or the server, with labels and details', async () => {
		expect((await signUp('pia@example.com', 'Pia Pending')).json.status).toBe('pending');
		expect((await signUp('quinn@example.com', 'Quinn')).json.status).toBe('pending');
		expect((await signUp('dee@example.com', 'Dee Declined')).json.status).toBe('pending');
		const pia = await userOf('pia@example.com');
		const quinn = await userOf('quinn@example.com');
		const dee = await userOf('dee@example.com');

		// a malformed acting user is refused before anything happens
		const bad = await fromServer('POST', `/v1/users/${pia.id}/approve`, {
			headers: { 'ss-actor-id': 'not valid!', 'ss-actor-name': 'X' },
		});
		expect(code(bad)).toBe('invalid_actor');
		expect((await userOf('pia@example.com')).status).toBe('pending');

		expect((await fromServer('POST', `/v1/users/${pia.id}/approve`, { headers: ZOE })).json.status).toBe('active');
		expect((await fromServer('POST', `/v1/users/${quinn.id}/approve`)).json.status).toBe('active');
		expect((await fromServer('POST', `/v1/users/${dee.id}/decline`, { headers: ZOE })).status).toBe(204);
		const [approvedQuinn, approvedPia] = await activity('action=user.approved');
		expect(approvedPia).toMatchObject({ actor: ZOE_ACTOR, target: pia.id, label: 'Pia Pending', detail: 'Role: customer' });
		expect(approvedQuinn).toMatchObject({ actor: SERVER_ACTOR, label: 'Quinn' });
		expect((await activity('action=user.declined'))[0]).toMatchObject({
			actor: ZOE_ACTOR,
			label: 'Dee Declined',
			detail: 'The sign-up was removed',
		});

		// user changes: role, name, notes (never their text), block (reason and devices signed out), unblock
		const session = await signIn('quinn@example.com');
		expect(session.json.status).toBe('signed_in');
		await fromServer('PATCH', `/v1/users/${pia.id}`, { body: { role: 'support_staff' }, headers: ZOE });
		await fromServer('PATCH', `/v1/users/${quinn.id}`, {
			body: { name: 'Quinn Q', notes: 'secret note', blocked: true, blockedReason: 'Chargebacks' },
		});
		await fromServer('PATCH', `/v1/users/${quinn.id}`, { body: { blocked: false }, headers: ZOE });
		expect((await activity('action=user.role_changed'))[0]).toMatchObject({
			actor: ZOE_ACTOR,
			label: 'Pia Pending',
			detail: 'Role: customer → support_staff',
		});
		expect((await activity('action=user.name_changed'))[0]).toMatchObject({ label: 'Quinn Q', detail: 'Was: Quinn' });
		expect((await activity('action=user.notes_changed'))[0]).toMatchObject({
			actor: SERVER_ACTOR,
			label: 'Quinn Q',
			detail: null,
		});
		expect((await activity('action=user.blocked'))[0]).toMatchObject({
			actor: SERVER_ACTOR,
			detail: 'Reason: Chargebacks; 1 device signed out',
		});
		expect((await activity('action=user.unblocked'))[0]).toMatchObject({ actor: ZOE_ACTOR, label: 'Quinn Q', detail: null });
		expect(JSON.stringify(await activity(''))).not.toContain('secret note');

		// sign out everywhere and a ticket's member of staff
		await signIn('quinn@example.com');
		const t = await env.ticket(['users.read', 'users.manage', 'roles.manage']);
		expect((await env.admin(t, 'POST', `/v1/admin/users/${quinn.id}/sign-out`)).status).toBe(204);
		expect((await activity('action=user.signed_out'))[0]).toMatchObject({
			actor: { kind: 'staff', id: 'usr_staff', name: 'Sam Staff' },
			label: 'Quinn Q',
			detail: '1 device signed out',
		});

		// roles and the merchant's own permissions
		await env.admin(t, 'PUT', '/v1/admin/roles/editor', { name: 'Editor', permissions: ['site:vip.view'] });
		await env.admin(t, 'PUT', '/v1/admin/roles/editor', { name: 'Editor', twoStep: 'required' });
		await fromServer('PATCH', `/v1/users/${quinn.id}`, { body: { role: 'editor' } });
		expect((await env.admin(t, 'DELETE', '/v1/admin/roles/editor')).status).toBe(204);
		const [changed, created] = await activity('action=role.saved');
		expect(created).toMatchObject({ target: 'editor', label: 'Editor', detail: 'New role; 1 permission; two-step optional' });
		expect(changed).toMatchObject({ label: 'Editor', detail: 'Changed; 0 permissions; two-step required' });
		expect((await activity('action=role.deleted'))[0]).toMatchObject({
			label: 'Editor',
			detail: '1 user moved to the role customer',
		});
		await fromServer('PUT', '/v1/roles/permissions', {
			body: { permissions: [{ key: 'vip.view', name: 'VIP' }] },
			headers: ZOE,
		});
		await fromServer('PUT', '/v1/roles/permissions', { body: { permissions: [] } });
		const [none, own] = await activity('action=permissions.saved');
		expect(own).toMatchObject({ actor: ZOE_ACTOR, label: 'Own permissions', detail: 'site:vip.view' });
		expect(none).toMatchObject({ actor: SERVER_ACTOR, detail: 'No own permissions' });

		// invites by e-mail and by phone (the address itself never goes into the log)
		await env.setting('approval', 'invitePageUrl', `${ORIGIN}/join`);
		await fromServer('POST', '/v1/users/invite', { body: { email: 'ivy@example.com', name: 'Ivy' }, headers: ZOE });
		await fromServer('POST', '/v1/users/invite', { body: { phone: '+15550009999', name: 'Pat' } });
		const [byPhone, byEmail] = await activity('action=user.invited');
		expect(byEmail).toMatchObject({
			actor: ZOE_ACTOR,
			label: 'Ivy',
			detail: 'Role: customer; sent by e-mail; valid for 7 days',
		});
		expect(byPhone).toMatchObject({ label: 'Pat', detail: 'Role: customer; sent by SMS; valid for 7 days' });
		expect(JSON.stringify([byPhone, byEmail])).not.toMatch(/ivy@example|5550009999/);

		// deletion requests: rejected, then approved and erased
		const asked = await signIn('pia@example.com');
		await env.visitor('POST', '/v1/me/delete', {}, asked.json.signIn);
		await fromServer('POST', `/v1/users/${pia.id}/deletion/reject`, { headers: ZOE });
		expect((await activity('action=user.deletion_rejected'))[0]).toMatchObject({
			label: 'Pia Pending',
			detail: 'The account stays',
		});
		await env.visitor('POST', '/v1/me/delete', {}, asked.json.signIn);
		const erased = await fromServer('POST', `/v1/users/${pia.id}/deletion/approve`, { headers: ZOE });
		expect(erased.json).toEqual({ deleted: true, pending: [] });
		expect((await activity('action=user.deleted'))[0]).toMatchObject({
			actor: ZOE_ACTOR,
			target: pia.id,
			label: 'Pia Pending',
			detail: 'Deletion request approved',
		});
		// the kit's activity filters work on the labels and the acting user
		expect((await activity('actor=usr_staff1&q=pia')).every((/** @type {any} */ e) => e.actor.id === 'usr_staff1')).toBe(true);
		expect((await activity('q=pia%20pending')).length).toBeGreaterThan(3);
	});
});

describe('counts (K4)', () => {
	/** @param {any} answer @param {string} field */
	const tally = (answer, field) => {
		/** @type {Record<string, number>} */
		const out = {};
		for (const item of answer.json.items) out[item[field] ?? 'none'] = (out[item[field] ?? 'none'] ?? 0) + 1;
		return out;
	};

	it('counts users with exactly the filters of the list, through the server and the admin widgets', async () => {
		// one user who asked to be deleted, one blocked, some waiting
		await env.setting('data_rights', 'deleteAfterDays', 30);
		await env.setting('approval', 'mode', 'open');
		const rae = await signUp('rae@example.com', 'Rae');
		await env.visitor('POST', '/v1/me/delete', {}, rae.json.signIn);
		await env.setting('approval', 'mode', 'approval');
		await signUp('wes@example.com', 'Wes Waiting');
		const quinn = await userOf('quinn@example.com');
		await fromServer('PATCH', `/v1/users/${quinn.id}`, { body: { blocked: true } });

		const t = await env.ticket(['users.read']);
		const filters = [
			'',
			'status=active',
			'status=pending',
			'status=invited',
			'status=blocked',
			'status=bogus',
			'role=customer',
			'role=nobody',
			'q=example.com',
			'q=QUINN',
			'deletion=1',
			'status=active&role=customer&q=r',
		];
		for (const filter of filters) {
			const list = await fromServer('GET', `/v1/users?limit=100&${filter}`);
			const count = await fromServer('GET', `/v1/users/count?${filter}`);
			expect(count.json, filter).toEqual({ count: list.json.items.length, capped: false });
			const twin = await env.admin(t, 'GET', `/v1/admin/users/count?${filter}`);
			expect(twin.json, filter).toEqual(count.json);
		}
		expect((await fromServer('GET', '/v1/users/count?deletion=1')).json.count).toBe(1);
		expect((await fromServer('GET', '/v1/users/count?status=blocked')).json.count).toBe(1);

		const all = await fromServer('GET', '/v1/users?limit=100');
		const byStatus = await fromServer('GET', '/v1/users/counts?by=status');
		expect(byStatus.json).toEqual({ total: all.json.items.length, groups: tally(all, 'status') });
		expect(byStatus.json.groups).toMatchObject({ pending: 1, invited: 2 });
		const byRole = await env.admin(t, 'GET', '/v1/admin/users/counts?by=role&status=active');
		const active = await fromServer('GET', '/v1/users?limit=100&status=active');
		expect(byRole.json).toEqual({ total: active.json.items.length, groups: tally(active, 'role') });

		const wrong = await fromServer('GET', '/v1/users/counts?by=email');
		expect(code(wrong)).toBe('validation_failed');
		expect(wrong.json.errors[0].path).toBe('/by');
		expect(code(await env.admin(await env.ticket(['roles.manage']), 'GET', '/v1/admin/users/count'))).toBe('forbidden');
		expect((await env.call('GET', '/v1/users/count', { token: env.server, origin: ORIGIN })).status).toBe(401);
	});
});

describe('activity-log copies (K9)', () => {
	/** @param {string} at @param {Record<string, unknown>} more */
	const copy = (at, more) => ({ websiteId: env.websiteId, at, ...more });
	const sam = { kind: 'staff', id: 'u_1', name: 'Sam', role: 'Support staff' };

	it('keeps the label, detail and role, filters like the kit’s activity log (business days) and counts', async () => {
		const copies = [
			copy('2026-09-30T18:30:00Z', {
				productId: 'chat',
				actor: sam,
				action: 'conversation.closed',
				target: 'cnv_1',
				label: 'Ana B',
				detail: 'Closed after 3 replies',
			}),
			copy('2026-09-30T19:30:00Z', {
				productId: 'ecommerce',
				actor: { kind: 'user', id: 'usr_9', name: 'Zoë', role: 'Owner' },
				action: 'order.moved',
				target: 'ord_1',
				label: 'IM-2026-0043',
				detail: 'Status: paid → packed',
			}),
			copy('2026-10-01T18:59:00Z', {
				productId: 'ecommerce',
				actor: SERVER_ACTOR,
				action: 'order.refunded',
				target: 'ord_1',
				label: 'IM-2026-0043',
			}),
			copy('2026-10-01T19:00:00Z', { productId: 'notifications', actor: sam, action: 'template.saved', target: 'tpl_1' }),
		];
		for (const body of copies) expect((await fromServer('POST', '/v1/activity-copies', { body })).status).toBe(201);
		const tooLong = copy('2026-10-01T19:00:00Z', {
			productId: 'chat',
			actor: sam,
			action: 'x.y',
			target: 't',
			label: 'x'.repeat(201),
		});
		expect(code(await fromServer('POST', '/v1/activity-copies', { body: tooLong }))).toBe('validation_failed');

		/** @param {string} query */
		const targets = async (query) =>
			(await fromServer('GET', `/v1/activity-copies?${query}`)).json.items.map(
				(/** @type {any} */ item) => `${item.action}@${item.at}`,
			);
		const listed = (await fromServer('GET', '/v1/activity-copies')).json.items;
		expect(listed.map((/** @type {any} */ item) => item.action)).toEqual([
			'template.saved',
			'order.refunded',
			'order.moved',
			'conversation.closed',
		]);
		expect(listed[2]).toEqual({
			id: expect.stringMatching(/^act_/),
			productId: 'ecommerce',
			actor: { kind: 'user', id: 'usr_9', name: 'Zoë', role: 'Owner' },
			action: 'order.moved',
			target: 'ord_1',
			label: 'IM-2026-0043',
			detail: 'Status: paid → packed',
			at: '2026-09-30T19:30:00.000Z',
		});
		expect(listed[1]).toMatchObject({ label: 'IM-2026-0043', detail: null });
		expect(listed[0]).toMatchObject({ label: null, detail: null, actor: sam });

		// days are the business's days (Karachi, UTC+5): 1 Oct runs from 30 Sep 19:00 to 1 Oct 19:00 UTC
		expect(await targets('from=2026-10-01&to=2026-10-01')).toEqual([
			'order.refunded@2026-10-01T18:59:00.000Z',
			'order.moved@2026-09-30T19:30:00.000Z',
		]);
		expect(await targets('to=2026-09-30')).toEqual(['conversation.closed@2026-09-30T18:30:00.000Z']);
		expect(await targets('from=2026-10-01T19:00:00Z')).toEqual(['template.saved@2026-10-01T19:00:00.000Z']);
		expect((await targets('actor=u_1')).length).toBe(2);
		expect((await targets('action=order.moved,order.refunded')).length).toBe(2);
		expect((await targets('target=ord_1&productId=ecommerce')).length).toBe(2);
		expect((await targets('q=im-2026')).length).toBe(2);
		expect((await targets('q=PAID')).length).toBe(1);
		expect((await targets('q=sam')).length).toBe(2);
		expect((await targets('q=cnv_')).length).toBe(1);
		expect(await targets('productId=growth')).toEqual([]);
		// a search keeps its filter across pages
		const first = await fromServer('GET', '/v1/activity-copies?q=sam&limit=1');
		expect(first.json.items[0].action).toBe('template.saved');
		const second = await fromServer('GET', `/v1/activity-copies?q=sam&limit=1&cursor=${first.json.nextCursor}`);
		expect(second.json.items.map((/** @type {any} */ item) => item.action)).toEqual(['conversation.closed']);
		expect(second.json.hasMore).toBe(false);

		for (const [query, field] of [
			['from=yesterday', '/from'],
			['to=2026-02-30', '/to'],
			['action=Not%20an%20action', '/action'],
			['productId=Not!', '/productId'],
			[`actor=${'a'.repeat(257)}`, '/actor'],
			[`target=${'t'.repeat(257)}`, '/target'],
		]) {
			const refused = await fromServer('GET', `/v1/activity-copies?${query}`);
			expect(code(refused), query).toBe('validation_failed');
			expect(refused.json.errors[0].path).toBe(field);
			expect(code(await fromServer('GET', `/v1/activity-copies/count?${query}`))).toBe('validation_failed');
		}

		expect((await fromServer('GET', '/v1/activity-copies/count')).json).toEqual({ count: 4, capped: false });
		expect((await fromServer('GET', '/v1/activity-copies/count?from=2026-10-01&to=2026-10-01')).json.count).toBe(2);
		expect((await fromServer('GET', '/v1/activity-copies/count?q=sam&productId=chat')).json.count).toBe(1);
		expect((await fromServer('GET', '/v1/activity-copies/counts?by=productId')).json).toEqual({
			total: 4,
			groups: { ecommerce: 2, chat: 1, notifications: 1 },
		});
		expect((await fromServer('GET', '/v1/activity-copies/counts?by=actor&from=2026-10-01')).json).toEqual({
			total: 3,
			groups: { u_1: 1, usr_9: 1, server: 1 },
		});
		expect((await fromServer('GET', '/v1/activity-copies/counts?by=action&productId=ecommerce')).json).toEqual({
			total: 2,
			groups: { 'order.moved': 1, 'order.refunded': 1 },
		});
		expect(code(await fromServer('GET', '/v1/activity-copies/counts?by=kind'))).toBe('validation_failed');
	});
});

describe('Format and time zone (K7, K8) and the docs', () => {
	it('the widget config carries the website’s Format and business time zone', async () => {
		const cookie = await env.adminSession();
		const saved = await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/format`, {
			locale: 'en-GB',
			times: 'business',
		});
		expect(saved.status).toBe(200);
		const config = await env.visitor('GET', '/v1/widget/config');
		expect(config.json).toMatchObject({
			format: { locale: 'en-GB', currencyDisplay: 'code', wholeUnits: false, times: 'business' },
			timeZone: 'Asia/Karachi',
		});
		const t = await env.ticket(['users.read']);
		expect((await env.admin(t, 'GET', '/v1/widget/admin/config')).json).toMatchObject({
			format: { locale: 'en-GB' },
			timeZone: 'Asia/Karachi',
		});
	});

	it('/docs explains the kit’s routes for the merchant’s server and lists the counts', async () => {
		const docs = await env.call('GET', '/docs');
		for (const id of ['server-settings', 'acting-user', 'server-visitors', 'counts', 'activity', 'format'])
			expect(docs.text).toContain(`<h2 id="${id}">`);
		expect(docs.text).toContain('SS-Actor-Id');
		expect(docs.text).toContain('GET /v1/users/count');
		expect(docs.text).toContain('GET /v1/admin/users/counts');
		expect(docs.text).toContain('GET /v1/activity-copies/counts');
	});

	it('counts need the feature of their list', async () => {
		await env.switchOn(['email_password', 'approval']);
		expect(code(await fromServer('GET', '/v1/users/count'))).toBe('feature_off');
		expect(code(await fromServer('GET', '/v1/activity-copies/count'))).toBe('feature_off');
	});
});
