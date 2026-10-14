/**
 * Accounts' sign-in methods, staff and roles on the REAL Portal (PLAN 0.8.10): imported bcrypt and PBKDF2 hashes sign
 * in and are re-hashed; phone + password, staff sign-in codes and setup links, role requests (repeat asks, a new link,
 * a decline, the role given at completion, the setup-link lookup), the guards, paused roles and the remember options
 * (`never` too) work through the widget (Accounts' real `widget.js` code in a browser window, jsdom) and through the
 * merchant's server (server token, `SS-Visitor-IP`, `SS-Actor-*`); an old recovery code works once.
 */
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProductInstance, manifest, strings } from '@ss/product-accounts/product';
import { createRoutes } from '@ss/product-accounts/routes';
import { startWidget } from '@ss/product-accounts/widget';
import { codeOf, startSystem } from './helpers.js';

const ACCOUNTS = 'https://accounts.test';
const DOMAIN = 'members.example.com';
const ORIGIN = `https://${DOMAIN}`;
const ADMIN_ORIGIN = 'https://admin.members.example.com';
const VISITOR = { 'ss-visitor-ip': '198.51.100.9' };

/** @type {import('./helpers.js').System} */
let sys;
/** The browser windows the tests opened (closed at the end). @type {any[]} */
const windows = [];
let websiteId = '';
/** @type {{ browser: string, server: string }} */
let tokens;

/**
 * A visitor's browser on a page of the website running Accounts' widget script: its fetch reaches Accounts through the
 * system with the page's Origin and every header the widget sends.
 * @param {string} key the widget to place (`sign_in`, `role_request`)
 * @param {string} [path] the page (a setup link carries `?ss_setup=`)
 */
const openPage = async (key, path = '/account') => {
	const dom = new JSDOM(`<!doctype html><html><body><div data-ss-accounts="${key}"></div></body></html>`, {
		url: `${ORIGIN}${path}`,
		pretendToBeVisual: true,
	});
	const win = /** @type {any} */ (dom.window);
	windows.push(win);
	win.fetch = async (/** @type {string} */ input, /** @type {RequestInit} */ init = {}) => {
		const url = new URL(input);
		const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
		const { authorization, ...rest } = headers;
		const res = await sys.call(init.method ?? 'GET', `${url.pathname}${url.search}`, {
			token: authorization?.replace('Bearer ', ''),
			origin: ORIGIN,
			headers: rest,
			...(typeof init.body === 'string' ? { body: init.body } : {}),
		});
		return new Response(res.status === 204 ? null : JSON.stringify(res.json), { status: res.status });
	};
	const script = win.document.createElement('script');
	script.src = `${ACCOUNTS}/widget.js`;
	script.dataset.token = tokens.browser;
	// the widget keeps the system's time (its sign-ins expire on the system clock)
	const widget = startWidget({ window: win, script, now: sys.clock.now });
	await widget.ready;
	await settle();
	const root = /** @type {ShadowRoot} */ (win.document.querySelector(`[data-ss-accounts="${key}"]`).shadowRoot);
	return { win, widget, root };
};

/** Let the widget's calls finish. */
const settle = async () => {
	for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Wait until a condition holds (the widget's calls reach the merchant database).
 * @param {() => boolean} done
 */
const until = async (done) => {
	for (let i = 0; i < 250 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
};

/** @param {ShadowRoot} root @param {string} label */
const field = (root, label) => {
	const found = [...root.querySelectorAll('label')].find((l) => l.textContent === label);
	if (!found) throw new Error(`no field ${label}`);
	return /** @type {HTMLInputElement} */ (root.getElementById(/** @type {HTMLLabelElement} */ (found).htmlFor));
};
/** @param {ShadowRoot} root @param {string} text */
const button = (root, text) => {
	const found = [...root.querySelectorAll('button')].find((b) => b.textContent === text);
	if (!found) throw new Error(`no button ${text}`);
	return /** @type {HTMLButtonElement} */ (found);
};
/** Submit the form of a button. @param {any} win @param {HTMLElement} node */
const submit = async (win, node) => {
	/** @type {HTMLFormElement} */ (node.closest('form')).dispatchEvent(new win.Event('submit', { cancelable: true }));
	await settle();
};

/** A server-token call, as a visitor (K3) or as an acting member of staff (K2). */
const server = {
	/** @param {string} method @param {string} path @param {unknown} [body] @param {Record<string, string>} [headers] */
	call: (method, path, body, headers = {}) =>
		sys.call(method, path, { token: tokens.server, ...(body === undefined ? {} : { body }), headers }),
};

/** The users in the merchant database (the importer writes records there directly). */
const users = async () => (await sys.product.data.forWebsite(websiteId)).collection('users');

beforeAll(async () => {
	sys = await startSystem({ unit: { createProductInstance, createRoutes, manifest, strings, url: ACCOUNTS } });
	await sys.connect();
	const m = await sys.merchant('members@shop.test', [DOMAIN]);
	websiteId = m.websiteIds[0] ?? '';
	await sys.addProduct(m.merchantId, websiteId, 'accounts');
	await sys.addCredits(m.merchantId, 100);
	tokens = await sys.tokens(m.merchantId, websiteId, 'accounts');
	const cookie = await sys.adminSession(await sys.owner(), websiteId);
	await sys.switchFeatures(cookie, websiteId, [
		'email_password',
		'phone_password',
		'roles',
		'two_step',
		'staff_links',
		'role_requests',
	]);
	await sys.connectDatabase(cookie, websiteId);
	for (const [key, value] of /** @type {const} */ ([
		['phone.defaultCallingCode', '+44'],
		['phone.trunkPrefix', '0'],
		['phone_password.breachedCheck', false],
		['email_password.breachedCheck', false],
		['role_requests.requestableRoles', ['member']],
	])) {
		const saved = await server.call('PUT', `/v1/settings/${key}`, { value });
		expect(saved.status, key).toBe(200);
	}
	await server.call('PUT', '/v1/roles/member', { name: 'Member', permissions: ['site:discount'] });
});
afterAll(async () => {
	for (const win of windows) win.close();
	await sys?.stop();
});

describe('Accounts sign-in methods, staff and roles on the real Portal', () => {
	it('imported bcrypt and PBKDF2 hashes sign in and are re-hashed', async () => {
		const bcryptUser = await server.call('POST', '/v1/users', { name: 'Alex Morgan', email: 'alex@members.example.com' });
		const pbkdf2User = await server.call('POST', '/v1/users', {
			name: 'Olivia',
			email: 'olivia@members.example.com',
			role: 'owner',
		});
		const col = await users();
		await col.updateOne(
			{ websiteId, id: bcryptUser.json.id },
			{ $set: { passwordHash: bcrypt.hashSync('old bcrypt password', 10) } },
		);
		const salt = randomBytes(16);
		const pbkdf2 = `pbkdf2$100000$${salt.toString('base64')}$${pbkdf2Sync('source-pepper:old pbkdf2 password', salt, 100_000, 32, 'sha256').toString('base64')}`;
		await col.updateOne({ websiteId, id: pbkdf2User.json.id }, { $set: { passwordHash: pbkdf2 } });
		const cookie = await sys.adminSession(await sys.owner(), websiteId);
		const pepper = await sys.dashboard(
			cookie,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/connections/imported_password_pepper`,
			{
				value: 'source-pepper',
			},
		);
		expect(pepper.json).toMatchObject({ status: 'connected' });
		for (const [email, password, id] of [
			['alex@members.example.com', 'old bcrypt password', bcryptUser.json.id],
			['olivia@members.example.com', 'old pbkdf2 password', pbkdf2User.json.id],
		]) {
			const signedIn = await server.call('POST', '/v1/sign-in/password', { email, password }, VISITOR);
			expect(signedIn.json.status, email).toBe('signed_in');
			expect((await col.findOne({ websiteId, id }))?.passwordHash).toMatch(/^scrypt\$/);
			expect((await server.call('POST', '/v1/sign-in/password', { email, password }, VISITOR)).json.status).toBe('signed_in');
		}
	});

	it('phone + password through the widget and through the server', async () => {
		const { win, root, widget } = await openPage('sign_in');
		expect(button(root, strings['method.phone_password'])).toBeTruthy();
		button(root, strings['method.phone_password']).click();
		await settle();
		button(root, strings['signIn.toSignUp']).click();
		await settle();
		field(root, strings['fields.name']).value = 'Nora';
		field(root, strings['fields.phone']).value = '07700 900321';
		field(root, strings['fields.password']).value = 'nora pass 1';
		await submit(win, button(root, strings['signUp.submit']));
		await until(() => widget.user() !== null);
		expect(widget.user()?.phone).toBe('+447700900321');
		const fromServer = await server.call(
			'POST',
			'/v1/sign-in/phone-password',
			{ phone: '07700900321', password: 'nora pass 1' },
			VISITOR,
		);
		expect(fromServer.json).toMatchObject({ status: 'signed_in', user: { name: 'Nora' } });
		expect(fromServer.json.refreshToken).toMatch(/^ses_/);
		expect(codeOf(await server.call('POST', '/v1/sign-in/phone-password', { phone: '07700900321', password: 'x' }))).toBe(
			'visitor_ip_required',
		);
	});

	it('a staff sign-in code and a setup link, issued through the server, work in the widget', async () => {
		const owner = (await server.call('GET', '/v1/users?roles=owner')).json.items[0];
		const actor = { 'ss-actor-id': owner.id, 'ss-actor-name': 'Olivia' };
		const customer = await server.call('POST', '/v1/users', { name: 'Kai', phone: '07700 900233' }, actor);
		const issued = await server.call('POST', `/v1/users/${customer.json.id}/sign-in-code`, undefined, actor);
		expect(issued.json.code).toMatch(/^\d{6}$/);
		const { win, root, widget } = await openPage('sign_in');
		button(root, strings['method.phone_password']).click();
		await settle();
		field(root, strings['fields.phone']).value = '07700900233';
		field(root, strings['fields.password']).value = issued.json.code;
		await submit(win, button(root, strings['signIn.submit']));
		await until(() => widget.user() !== null);
		expect(widget.user()?.name).toBe('Kai');
		const logged = await server.call('GET', '/v1/activity?action=user.sign_in_code_issued');
		expect(logged.json.items[0]).toMatchObject({ actor: { id: owner.id, name: 'Olivia' }, label: 'Kai' });

		const link = await server.call('POST', `/v1/users/${customer.json.id}/setup-link`, undefined, actor);
		const url = new URL(link.json.url);
		expect(url.origin).toBe(ORIGIN);
		const page = await openPage('sign_in', `${url.pathname}${url.search}`);
		expect(page.win.location.search).toBe('');
		field(page.root, strings['fields.password']).value = 'kashif pass 1';
		await submit(page.win, button(page.root, strings['setup.submit']));
		await until(() => page.widget.user() !== null);
		expect(page.widget.user()?.hasPassword).toBe(true);
	});

	it('a role request from the widget is invited by staff and completed with the setup link', async () => {
		/** Ask from the widget; the text it shows after. @param {string} expected */
		const ask = async (expected) => {
			const { win, root } = await openPage('role_request');
			field(root, strings['fields.name']).value = 'Harper';
			field(root, strings['fields.phone']).value = '07700 900887';
			await submit(win, button(root, strings['request.submit']));
			await until(() => (root.textContent ?? '').includes(expected));
			expect(root.textContent).toContain(expected);
		};
		await ask(strings['request.sent']);
		// asked again: nothing new, the widget says it waits
		await ask(strings['request.alreadyRequested']);
		const pending = await server.call('GET', '/v1/role-requests?status=pending');
		expect(pending.json.items).toMatchObject([{ name: 'Harper', phone: '+447700900887', role: 'member' }]);
		const ticket = await sys.call('POST', '/v1/tickets', {
			token: tokens.server,
			body: {
				user: { id: 'staff_1', name: 'Sam', email: 'sam@members.example.com' },
				permissions: ['users.manage'],
				origin: ADMIN_ORIGIN,
			},
		});
		const invited = await sys.call('POST', `/v1/admin/role-requests/${pending.json.items[0].id}/invite`, {
			token: ticket.json.ticket,
			origin: ADMIN_ORIGIN,
		});
		expect(invited.json.request.status).toBe('invited');
		await ask(strings['request.alreadyInvited']);
		const url = new URL(invited.json.setupLink.url);
		const page = await openPage('sign_in', `${url.pathname}${url.search}`);
		// the setup page greets by name with the number's last 4 digits (the lookup)
		await until(() => (page.root.textContent ?? '').includes('Hi Harper!'));
		expect(page.root.textContent).toContain('For the phone number ending in 0887.');
		field(page.root, strings['fields.password']).value = 'harper pass 12';
		await submit(page.win, button(page.root, strings['setup.submit']));
		await until(() => page.widget.user() !== null);
		expect(page.widget.user()?.role).toBe('member');
		expect((await server.call('GET', '/v1/role-requests/count?status=completed')).json.count).toBe(1);
		// the merchant's own setup page asks from its server: the link is used now
		const linkCode = String(url.searchParams.get('ss_setup'));
		const used = await server.call('POST', '/v1/setup-links/lookup', { code: linkCode }, VISITOR);
		expect(used.json).toEqual({ status: 'used' });
		const usedPage = await openPage('sign_in', `${url.pathname}${url.search}`);
		await until(() => (usedPage.root.textContent ?? '').includes(strings['setup.used']));
		expect(usedPage.root.querySelector('form')).toBeNull();
		await ask(strings['request.alreadyMember']);
	});

	it('staff give an invited request a new link or decline it; the role given at completion (settings API)', async () => {
		const saved = await server.call('PUT', '/v1/settings/role_requests.giveRoleAt', { value: 'completion' });
		expect(saved.status).toBe(200);
		const ticket = await sys.call('POST', '/v1/tickets', {
			token: tokens.server,
			body: {
				user: { id: 'staff_2', name: 'Sam', email: 'sam@members.example.com' },
				permissions: ['users.manage'],
				origin: ADMIN_ORIGIN,
			},
		});
		/** @param {string} method @param {string} path */
		const asStaff = (method, path) => sys.call(method, path, { token: ticket.json.ticket, origin: ADMIN_ORIGIN });
		/** @param {string} name @param {string} phone */
		const askFromServer = async (name, phone) =>
			(await server.call('POST', '/v1/role-requests', { role: 'member', name, phone }, VISITOR)).json;
		/** @param {string} linkCode */
		const lookup = async (linkCode) => (await server.call('POST', '/v1/setup-links/lookup', { code: linkCode }, VISITOR)).json;
		/** @param {{ json: any }} answer */
		const codeOfLink = (answer) => String(new URL(answer.json.setupLink.url).searchParams.get('ss_setup'));

		const ivy = await askFromServer('Ivy Stone', '07700 900888');
		expect(ivy.outcome).toBe('requested');
		const first = await asStaff('POST', `/v1/admin/role-requests/${ivy.id}/invite`);
		expect(first.json.user.role).toBe('customer');
		const renewed = await asStaff('POST', `/v1/admin/role-requests/${ivy.id}/setup-link`);
		expect(renewed.json.request).toMatchObject({ status: 'invited', invitedBy: { kind: 'staff', name: 'Sam' } });
		expect(await lookup(codeOfLink(first))).toEqual({ status: 'canceled' });
		expect(await lookup(codeOfLink(renewed))).toMatchObject({ status: 'valid', name: 'Ivy Stone', phoneLast4: '0888' });
		const accepted = await server.call(
			'POST',
			'/v1/setup-links/accept',
			{ code: codeOfLink(renewed), password: 'ivy pass 1234' },
			VISITOR,
		);
		expect(accepted.json.user.role).toBe('member');

		const ned = await askFromServer('Ned Cole', '07700 900889');
		const nedInvite = await asStaff('POST', `/v1/admin/role-requests/${ned.id}/invite`);
		const declined = await asStaff('POST', `/v1/admin/role-requests/${ned.id}/decline`);
		expect(declined.json).toMatchObject({ status: 'declined', userId: null });
		expect(codeOf(await server.call('GET', `/v1/users/${nedInvite.json.user.id}`))).toBe('not_found');
		expect(await lookup(codeOfLink(nedInvite))).toEqual({ status: 'invalid' });
		expect((await server.call('PUT', '/v1/settings/role_requests.giveRoleAt', { value: 'invite' })).status).toBe(200);
	});

	it('the guards refuse through the server and a ticket', async () => {
		const owner = (await server.call('GET', '/v1/users?roles=owner')).json.items[0];
		const manager = await server.call('POST', '/v1/users', {
			name: 'Mia',
			email: 'mia@members.example.com',
			role: 'business_manager',
		});
		const asManager = { 'ss-actor-id': manager.json.id, 'ss-actor-name': 'Mia' };
		expect(codeOf(await server.call('PATCH', `/v1/users/${owner.id}`, { notes: 'x' }, asManager))).toBe('forbidden');
		expect(codeOf(await server.call('PATCH', `/v1/users/${manager.json.id}`, { role: 'owner' }, asManager))).toBe('forbidden');
		const asOwner = { 'ss-actor-id': owner.id, 'ss-actor-name': 'Olivia' };
		const last = await server.call('PATCH', `/v1/users/${owner.id}`, { blocked: true }, asOwner);
		expect(codeOf(last)).toBe('forbidden');
		const ticket = await sys.call('POST', '/v1/tickets', {
			token: tokens.server,
			body: {
				user: { id: manager.json.id, name: 'Mia', email: 'mia@members.example.com' },
				permissions: ['users.manage'],
				origin: ADMIN_ORIGIN,
			},
		});
		const viaTicket = await sys.call('DELETE', `/v1/admin/users/${owner.id}`, {
			token: ticket.json.ticket,
			origin: ADMIN_ORIGIN,
			body: {},
		});
		expect(codeOf(viaTicket)).toBe('forbidden');
	});

	it('remember options and a paused role, in the widget and through the server', async () => {
		const customer = (await server.call('GET', '/v1/roles')).json.items.find((/** @type {any} */ r) => r.key === 'customer');
		await server.call('PUT', '/v1/roles/customer', { ...customer, remember: 'always' });
		const page = await openPage('sign_in');
		const box = [...page.root.querySelectorAll('label.check')].find((l) => l.textContent === strings['signIn.remember']);
		expect(/** @type {HTMLElement} */ (box).hidden).toBe(true);
		const remembered = await server.call(
			'POST',
			'/v1/sign-in/phone-password',
			{ phone: '07700900321', password: 'nora pass 1' },
			VISITOR,
		);
		expect(remembered.json.remember).toBe(true);
		await server.call('PUT', '/v1/roles/customer', { ...customer, signIn: 'paused' });
		const paused = await openPage('sign_in');
		expect(paused.root.textContent).toContain(strings['signIn.paused']);
		expect(paused.root.querySelector('form')).toBeNull();
		expect(
			codeOf(
				await server.call('POST', '/v1/sign-in/phone-password', { phone: '07700900321', password: 'nora pass 1' }, VISITOR),
			),
		).toBe('sign_in_paused');
		expect(
			codeOf(
				await server.call(
					'POST',
					'/v1/sign-in/password',
					{ email: 'alex@members.example.com', password: 'old bcrypt password' },
					VISITOR,
				),
			),
		).toBe('sign_in_paused');
		// staff of another role still sign in
		expect(
			(
				await server.call(
					'POST',
					'/v1/sign-in/password',
					{ email: 'olivia@members.example.com', password: 'old pbkdf2 password' },
					VISITOR,
				)
			).json.status,
		).toBe('signed_in');
		// never: no box, never remembered; the server ends it at the latest after the longer length (30 days here)
		await server.call('PUT', '/v1/roles/customer', { ...customer, remember: 'never' });
		const never = await openPage('sign_in');
		const hidden = [...never.root.querySelectorAll('label.check')].find((l) => l.textContent === strings['signIn.remember']);
		expect(/** @type {HTMLElement} */ (hidden).hidden).toBe(true);
		expect(/** @type {HTMLInputElement} */ (/** @type {HTMLElement} */ (hidden).querySelector('input')).checked).toBe(false);
		const forgotten = await server.call(
			'POST',
			'/v1/sign-in/phone-password',
			{ phone: '07700900321', password: 'nora pass 1', remember: true },
			VISITOR,
		);
		expect(forgotten.json.remember).toBe(false);
		expect(Date.parse(forgotten.json.sessionExpiresAt) - sys.clock.now()).toBeGreaterThan(29 * 24 * 3_600_000);
		await server.call('PUT', '/v1/roles/customer', { ...customer, signIn: 'on', remember: 'ask' });
	});

	it('an imported two-step sign-in: an old recovery code works once', async () => {
		const owner = (await server.call('GET', '/v1/users?roles=owner')).json.items[0];
		const hashes = ['ABCDE-FGHJK'].map((code) =>
			createHash('sha256')
				.update(`recovery:${code.replace('-', '')}`)
				.digest('hex'),
		);
		const col = await users();
		await col.updateOne(
			{ websiteId, id: owner.id },
			{
				$set: {
					twoStep: /** @type {import('@ss/product-accounts/product').Product} */ (
						/** @type {unknown} */ (sys.product)
					).twoStepFromImport(websiteId, owner.id, {
						secret: 'JBSWY3DPEHPK3PXP',
						recoveryHashes: hashes,
					}),
				},
			},
		);
		/** @returns {Promise<string>} */
		const challenge = async () => {
			const first = await server.call(
				'POST',
				'/v1/sign-in/password',
				{ email: 'olivia@members.example.com', password: 'old pbkdf2 password' },
				VISITOR,
			);
			expect(first.json.status).toBe('two_step');
			return first.json.challenge;
		};
		const used = await server.call(
			'POST',
			'/v1/sign-in/two-step',
			{ challenge: await challenge(), recoveryCode: 'abcde-fghjk' },
			VISITOR,
		);
		expect(used.json.status).toBe('signed_in');
		const again = await server.call(
			'POST',
			'/v1/sign-in/two-step',
			{ challenge: await challenge(), recoveryCode: 'ABCDE-FGHJK' },
			VISITOR,
		);
		expect(codeOf(again)).toBe('code_invalid');
	});
});
