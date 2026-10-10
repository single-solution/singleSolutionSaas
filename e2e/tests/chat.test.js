/**
 * PLAN 0.12 step 8: Chat against the REAL Portal, with the real Accounts and Notifications next to it — connect
 * (manifest and price list), price and feature reports, a guest message answered by a faked AI provider through the
 * browser token the Portal issued, a signed-in visitor trusted through the pasted Accounts token, an inbox reply through
 * a ticket, a `Chat needs you` staff alert delivered through the pasted Notifications token (the e-mail provider is a
 * fake in this process), and the hourly charge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createProductInstance as createAccounts,
	manifest as accountsManifest,
	strings as accountsStrings,
} from '@ss/product-accounts/product';
import { createRoutes as accountsRoutes } from '@ss/product-accounts/routes';
import { createProductInstance, manifest, strings } from '@ss/product-chat/product';
import { createRoutes } from '@ss/product-chat/routes';
import {
	createProductInstance as createNotifications,
	manifest as notifyManifest,
	strings as notifyStrings,
} from '@ss/product-notifications/product';
import { createRoutes as notifyRoutes } from '@ss/product-notifications/routes';
import { HOUR, startSystem } from './helpers.js';

const CHAT = 'https://chat.test';
const ACCOUNTS = 'https://accounts.test';
const NOTIFY = 'https://notifications.test';
const DOMAIN = 'talk.example.com';
const ORIGIN = `https://${DOMAIN}`;
const ADMIN_ORIGIN = 'https://admin.talk.example.com';

/** E-mails the merchant's provider (Resend) received, faked in process. @type {any[]} */
const mails = [];
/** Requests the merchant's AI provider (OpenAI) received, faked in process. @type {any[]} */
const prompts = [];

/** @param {Request} request */
const resend = async (request) => {
	if (request.method === 'POST') mails.push(await request.json());
	return Response.json({ id: `re_${mails.length}` });
};
/** @param {Request} request */
const openai = async (request) => {
	if (request.method === 'GET') return Response.json({ data: [] });
	prompts.push(await request.json());
	return Response.json({
		choices: [{ message: { role: 'assistant', content: 'We ship in two days.' }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 50, completion_tokens: 10 },
	});
};

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let websiteId = '';
/** @type {{ browser: string, server: string }} */
let chatTokens;
/** @type {{ browser: string, server: string }} */
let accountsTokens;
/** @type {{ browser: string, server: string }} */
let notifyTokens;
let conversationId = '';
/** The signed-in visitor's headers. @type {Record<string, string>} */
let signedIn = {};

beforeAll(async () => {
	sys = await startSystem({
		unit: {
			createProductInstance,
			createRoutes,
			manifest,
			strings,
			url: CHAT,
			handlers: { 'https://api.resend.com': resend, 'https://api.openai.com': openai },
		},
		extras: [
			{
				createProductInstance: createAccounts,
				createRoutes: accountsRoutes,
				manifest: accountsManifest,
				strings: accountsStrings,
				url: ACCOUNTS,
			},
			{
				createProductInstance: createNotifications,
				createRoutes: notifyRoutes,
				manifest: notifyManifest,
				strings: notifyStrings,
				url: NOTIFY,
			},
		],
	});
});
afterAll(async () => {
	await sys?.stop();
});

/**
 * A visitor request with the browser token from the website's own domain.
 * @param {string} method @param {string} path @param {{ body?: unknown, headers?: Record<string, string> }} [init]
 */
const visitor = (method, path, { body, headers = {} } = {}) =>
	sys.call(method, path, { token: chatTokens.browser, origin: ORIGIN, ...(body === undefined ? {} : { body }), headers });

describe('Chat on the real Portal', () => {
	it('connects: the Portal keeps its manifest and price list version 1, every feature at 0', async () => {
		expect(await sys.connect()).toMatchObject({ productId: 'chat' });
		await sys.connect({ base: ACCOUNTS });
		await sys.connect({ base: NOTIFY });
		const page = await (await sys.owner()).get('/v1/admin/products/chat');
		expect(page.json.priceListVersion).toBe(1);
		expect(page.json.features.map((/** @type {{ key: string }} */ f) => f.key)).toEqual(manifest.features.map((f) => f.key));
		expect(page.json.features.every((/** @type {{ millicreditsPerHour: number }} */ f) => f.millicreditsPerHour === 0)).toBe(
			true,
		);
		m = await sys.merchant('talk@shop.test', [DOMAIN]);
		websiteId = m.websiteIds[0] ?? '';
		for (const id of ['chat', 'accounts', 'notifications']) await sys.addProduct(m.merchantId, websiteId, id);
		await sys.addCredits(m.merchantId, 100);
		chatTokens = await sys.tokens(m.merchantId, websiteId, 'chat');
		accountsTokens = await sys.tokens(m.merchantId, websiteId, 'accounts');
		notifyTokens = await sys.tokens(m.merchantId, websiteId, 'notifications');
	});

	it('an Owner prices features and a Support admin switches them on: both reports are accepted', async () => {
		expect(await sys.setPrices({ visitor_chat: 1000, ai_replies: 500 })).toMatchObject({ version: 2 });
		const support = await sys.admin('support');
		const cookie = await sys.adminSession(support.client, websiteId);
		const on = ['ai_replies', 'guest_chat', 'handoff', 'inbox', 'signed_in_chat', 'staff_alerts', 'visitor_chat'];
		const report = await sys.switchFeatures(cookie, websiteId, on);
		expect(report.version).toBe(1);
		expect([...report.on].sort()).toEqual(on);
		const [entry] = await sys.activity('product.features_changed');
		expect(entry?.after).toMatchObject({ on });
	});

	it('a guest’s message is answered by the merchant’s AI provider (faked) through the Portal-issued browser token', async () => {
		const cookie = await sys.adminSession(await sys.owner(), websiteId);
		await sys.connectDatabase(cookie, websiteId);
		const ai = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/ai`, {
			value: { provider: 'openai', apiKey: 'sk-merchant-000123', model: 'gpt-4.1-mini' },
		});
		expect(ai.json).toMatchObject({ status: 'connected', last4: '0123' });
		const sent = await visitor('POST', '/v1/chat/messages', { body: { text: 'How fast do you ship?' } });
		expect(sent.status).toBe(201);
		const guestKey = String(sent.json.guestKey);
		const state = await visitor('GET', '/v1/chat', { headers: { 'ss-guest': guestKey } });
		expect(state.json.messages.map((/** @type {any} */ msg) => [msg.author, msg.text])).toEqual([
			['visitor', 'How fast do you ship?'],
			['ai', 'We ship in two days.'],
		]);
		expect(prompts[0].messages[0].content).toContain(`Business: ${DOMAIN}`);
		// another website's origin is refused with the same answer as a bad token
		const elsewhere = await sys.call('GET', '/v1/chat', { token: chatTokens.browser, origin: 'https://elsewhere.example.org' });
		expect(elsewhere.status).toBe(401);
	});

	it('a visitor signed in with Accounts chats as themselves once the Accounts token is pasted', async () => {
		const accountsCookie = await sys.adminSession(await sys.owner(), websiteId, 'accounts');
		const switched = await sys.dashboard(
			accountsCookie,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/features`,
			{ on: ['email_password'] },
			ACCOUNTS,
		);
		expect(switched.status).toBe(200);
		await sys.connectDatabase(accountsCookie, websiteId, ACCOUNTS);
		const up = await sys.call('POST', '/v1/sign-up/password', {
			base: ACCOUNTS,
			token: accountsTokens.browser,
			origin: ORIGIN,
			body: { email: 'reader@example.com', password: 'a long enough password', name: 'Rea Der' },
		});
		expect(up.json.status).toBe('signed_in');
		const headers = { 'ss-sign-in': String(up.json.signIn) };
		signedIn = headers;
		// not trusted until the Accounts server token is pasted: a guest without a key cannot read a chat
		expect((await visitor('GET', '/v1/chat', { headers })).json.visitor.kind).toBe('none');
		const cookie = await sys.adminSession(await sys.owner(), websiteId);
		const pasted = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/accounts`, {
			value: accountsTokens.server,
		});
		expect(pasted.json).toMatchObject({ status: 'connected' });
		const sent = await visitor('POST', '/v1/chat/messages', { body: { text: 'Where is my order?' }, headers });
		expect(sent.status).toBe(201);
		expect(sent.json.chat.visitor).toEqual({ kind: 'user', name: 'Rea Der', email: 'reader@example.com' });
		expect(sent.json.guestKey).toBeUndefined();
		conversationId = sent.json.chat.conversation.id;
	});

	it('the merchant’s staff reply in the inbox with a ticket; the visitor sees the reply', async () => {
		const ticket = await sys.call('POST', '/v1/tickets', {
			token: chatTokens.server,
			body: {
				user: { id: 'u_7', name: 'Sam Staff', email: 'sam@talk.example.com' },
				permissions: ['inbox.read', 'inbox.reply'],
				origin: ADMIN_ORIGIN,
			},
		});
		expect(ticket.status).toBe(200);
		const auth = { token: String(ticket.json.ticket), origin: ADMIN_ORIGIN };
		const list = await sys.call('GET', '/v1/admin/conversations', auth);
		expect(list.json.items).toHaveLength(2);
		const replied = await sys.call('POST', `/v1/admin/conversations/${conversationId}/messages`, {
			...auth,
			body: { text: 'It ships today.' },
		});
		expect(replied.status).toBe(201);
		expect(replied.json.message).toMatchObject({ author: 'staff', name: 'Sam Staff' });
		const seen = await visitor('GET', '/v1/chat', { headers: signedIn });
		expect(seen.json.messages.at(-1)).toMatchObject({ author: 'staff', name: 'Sam Staff', text: 'It ships today.' });
		expect(seen.json.conversation.status).toBe('awaiting_visitor');
		// a ticket works only from its own origin
		expect((await sys.call('GET', '/v1/admin/conversations', { ...auth, origin: ORIGIN })).status).toBe(401);
	});

	it('the merchant’s server replies as a named member of staff (SS-Actor), and counts match the inbox', async () => {
		const actor = {
			'ss-actor-id': 'usr_staff_42',
			'ss-actor-name': encodeURIComponent('Ayesha Khan'),
			'ss-actor-role': 'Support staff',
		};
		const replied = await sys.call('POST', `/v1/conversations/${conversationId}/messages`, {
			token: chatTokens.server,
			headers: actor,
			body: { text: 'Your order is packed.' },
		});
		expect(replied.status).toBe(201);
		expect(replied.json.message).toMatchObject({ author: 'staff', name: 'Ayesha Khan' });
		const seen = await visitor('GET', '/v1/chat', { headers: signedIn });
		expect(seen.json.messages.at(-1)).toMatchObject({ author: 'staff', name: 'Ayesha Khan', text: 'Your order is packed.' });
		// without the headers the server is the team
		const team = await sys.call('POST', `/v1/conversations/${conversationId}/messages`, {
			token: chatTokens.server,
			body: { text: 'Anything else?' },
		});
		expect(team.json.message).toMatchObject({ author: 'staff', name: 'Team' });
		const activity = await sys.call('GET', `/v1/activity?target=${conversationId}&actor=usr_staff_42`, {
			token: chatTokens.server,
		});
		expect(activity.json.items[0]).toMatchObject({
			action: 'conversation.replied',
			actor: { kind: 'user', id: 'usr_staff_42', name: 'Ayesha Khan', role: 'Support staff' },
		});
		// counts equal the inbox list (PLAN 0.8.10 K4)
		const list = await sys.call('GET', '/v1/conversations?limit=100', { token: chatTokens.server });
		const count = await sys.call('GET', '/v1/conversations/count', { token: chatTokens.server });
		expect(count.json).toEqual({ count: list.json.items.length, capped: false });
		const byStatus = await sys.call('GET', '/v1/conversations/counts?by=status', { token: chatTokens.server });
		expect(byStatus.json.total).toBe(list.json.items.length);
	});

	it('a handoff sends `Chat needs you` to the staff through the real Notifications', async () => {
		const notifyCookie = await sys.adminSession(await sys.owner(), websiteId, 'notifications');
		const on = await sys.dashboard(
			notifyCookie,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/features`,
			{ on: ['email'] },
			NOTIFY,
		);
		expect(on.status).toBe(200);
		await sys.connectDatabase(notifyCookie, websiteId, NOTIFY);
		const provider = await sys.dashboard(
			notifyCookie,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/connections/email`,
			{ value: { provider: 'resend', secret: 're_live_key_0002', from: 'Shop <shop@talk.example.com>' } },
			NOTIFY,
		);
		expect(provider.json).toMatchObject({ status: 'connected' });
		const template = await sys.dashboard(
			notifyCookie,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/templates`,
			{ key: 'chat.needs_you', channel: 'email', subject: 'Chat needs you', text: '{visitor}: {preview} {link}' },
			NOTIFY,
		);
		expect(template.status).toBe(200);
		const cookie = await sys.adminSession(await sys.owner(), websiteId);
		const pasted = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/notifications`, {
			value: notifyTokens.server,
		});
		expect(pasted.json).toMatchObject({ status: 'connected' });
		const recipients = await sys.dashboard(
			cookie,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/settings/staff_alerts.recipients`,
			{
				value: ['team@talk.example.com'],
			},
		);
		expect(recipients.status).toBe(204);
		await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/settings/staff_alerts.inboxUrl`, {
			value: `${ADMIN_ORIGIN}/inbox`,
		});
		const before = mails.length;
		const sent = await visitor('POST', '/v1/chat/messages', { body: { text: 'Can I talk to a person?' } });
		expect(sent.json.chat.conversation.waiting).toBe(true);
		const alert = mails.slice(before).find((mail) => mail.subject === 'Chat needs you');
		expect(alert).toMatchObject({ to: ['team@talk.example.com'] });
		expect(alert.text).toContain(`${ADMIN_ORIGIN}/inbox?conversation=${sent.json.chat.conversation.id}`);
	});

	it('Accounts exports a signed-in visitor’s chats through the pasted Chat token', async () => {
		const accountsCookie = await sys.adminSession(await sys.owner(), websiteId, 'accounts');
		const switched = await sys.dashboard(
			accountsCookie,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/features`,
			{ on: ['data_rights', 'email_password'] },
			ACCOUNTS,
		);
		expect(switched.status).toBe(200);
		const pasted = await sys.dashboard(
			accountsCookie,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/connections/chat`,
			{ value: chatTokens.server },
			ACCOUNTS,
		);
		expect(pasted.json).toMatchObject({ status: 'connected' });
		const exported = await sys.call('POST', '/v1/me/export', {
			base: ACCOUNTS,
			token: accountsTokens.browser,
			origin: ORIGIN,
			headers: signedIn,
		});
		const file = await sys.call('GET', new URL(exported.json.url).pathname, { base: ACCOUNTS });
		expect(file.json.records.chat.conversations[0].messages.map((/** @type {any} */ msg) => msg.text)).toContain(
			'It ships today.',
		);
	});

	it('the Portal charges the switched-on features every clock hour', async () => {
		const cards = await m.client.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`);
		expect(cards.json.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ productId: 'chat', hourlyCost: 1500, dailyCost: 36_000 })]),
		);
		const cookie = await sys.merchantSession(m, websiteId);
		const before = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(before.json).toMatchObject({ status: { status: 'active' } });
		sys.clock.advance(HOUR);
		const after = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(after.json.todayMillicredits).toBe(before.json.todayMillicredits + 1500);
	});
});
