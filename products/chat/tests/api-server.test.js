/**
 * Chat for the merchant's server (PLAN 0.8.10 K1–K9): the list settings through the settings API, the acting member
 * of staff of a server-token call (names on replies, the activity log, the staff list, `assigned=me`), visitor calls
 * from the server with `SS-Visitor-IP`, conversation counts equal to the list's lengths, activity labels and details,
 * and the website's Format and business time zone in the widget config and in text the server makes.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { AI_KEY, ORIGIN, ready } from './helpers.js';

/** @type {Array<Awaited<ReturnType<typeof ready>>>} */
const systems = [];
afterAll(async () => {
	for (const sys of systems) await sys.product.close();
});
/** @param {string[]} on */
const start = async (on) => {
	const sys = await ready(on);
	systems.push(sys);
	return sys;
};

/** The headers of a server call acting for Ayşe of the merchant's staff. */
const AYSE = Object.freeze({
	'ss-actor-id': 'usr_ayse',
	'ss-actor-name': encodeURIComponent('Ayşe Khan'),
	'ss-actor-role': 'Support',
	'ss-actor-email': 'ayse@shop.example.com',
});

/**
 * A server-token call, optionally acting for a member of staff.
 * @param {Awaited<ReturnType<typeof ready>>} sys
 * @param {string} method
 * @param {string} path
 * @param {{ body?: unknown, headers?: Record<string, string> }} [init]
 */
const server = (sys, method, path, { body, headers = {} } = {}) =>
	sys.call(method, path, { token: sys.server, headers, ...(body === undefined ? {} : { body }) });

describe('list settings from the merchant’s server (K1)', () => {
	it('reads and saves Chat’s lists with { value }, checked as in the dashboard', async () => {
		const sys = await start(['visitor_chat', 'ai_replies', 'webhook_tools', 'proactive_pages']);
		expect((await server(sys, 'GET', '/v1/lists/tools')).json).toEqual({ value: [] });
		const tool = {
			name: 'stock_check',
			description: 'Stock of a product',
			url: 'https://tools.example.com/stock',
			parameters: [],
		};
		const bad = await server(sys, 'PUT', '/v1/lists/tools', { body: { value: [{ ...tool, url: 'http://x.example.com' }] } });
		expect(bad.status).toBe(422);
		expect(bad.json.errors.length).toBeGreaterThan(0);
		const saved = await server(sys, 'PUT', '/v1/lists/tools', { body: { value: [tool] }, headers: AYSE });
		expect(saved.status).toBe(200);
		expect(saved.json.value).toMatchObject([{ name: 'stock_check' }]);
		// the dashboard's own list route answers the same list
		const cookie = await sys.adminSession();
		const dashboard = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${sys.websiteId}/lists/tools`);
		expect(dashboard.json.items).toEqual(saved.json.value);
		const rules = await server(sys, 'PUT', '/v1/lists/page_rules', {
			body: { value: [{ path: '/products/**', delay: 5, message: 'Need help?' }] },
		});
		expect(rules.json.value).toEqual([{ path: '/products/**', delay: 5, message: 'Need help?' }]);
		// a list of a feature that is off cannot be changed; an unknown list is not found
		expect((await server(sys, 'PUT', '/v1/lists/flows', { body: { value: [] } })).json.type).toMatch(/feature_off$/);
		expect((await server(sys, 'GET', '/v1/lists/nope')).status).toBe(404);
		const changes = await sys.product.recentChanges.list(sys.websiteId);
		expect(changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ who: expect.objectContaining({ name: 'Ayşe Khan' }), detail: 'Webhook tools: changed' }),
				expect.objectContaining({ who: expect.objectContaining({ name: 'Server' }), detail: 'Page rules: changed' }),
			]),
		);
	});
});

describe('the acting member of staff (K2)', () => {
	it('a server reply with SS-Actor headers carries that person; without them, Team', async () => {
		const sys = await start([
			'visitor_chat',
			'guest_chat',
			'inbox',
			'handoff',
			'assignment',
			'presence_queue',
			'internal_notes',
		]);
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', { text: 'Hello' });
		const id = sent.json.chat.conversation.id;
		const named = await server(sys, 'POST', `/v1/conversations/${id}/messages`, {
			body: { text: 'Hi, Ayşe here.' },
			headers: AYSE,
		});
		expect(named.status).toBe(201);
		expect(named.json.message).toMatchObject({ author: 'staff', name: 'Ayşe Khan', staffId: 'usr_ayse' });
		const team = await server(sys, 'POST', `/v1/conversations/${id}/messages`, { body: { text: 'The team again.' } });
		expect(team.json.message).toMatchObject({ name: 'Team', staffId: 'server' });
		// the conversation's messages, for staff and for the visitor
		const messages = (await server(sys, 'GET', `/v1/conversations/${id}`)).json.messages;
		expect(messages.filter((/** @type {any} */ m) => m.author === 'staff').map((/** @type {any} */ m) => m.name)).toEqual([
			'Ayşe Khan',
			'Team',
		]);
		expect((await v('GET', '/v1/chat')).json.messages.map((/** @type {any} */ m) => m.name)).toEqual([
			null,
			'Ayşe Khan',
			'Team',
		]);
		// the activity log, with the role and the visitor's label (never the message)
		const activity = (await server(sys, 'GET', '/v1/activity?action=conversation.replied')).json.items;
		expect(activity.map((/** @type {any} */ e) => [e.actor, e.label, e.detail])).toEqual([
			[{ kind: 'server', id: 'server', name: 'Team' }, 'Guest', 'Reply'],
			[{ kind: 'user', id: 'usr_ayse', name: 'Ayşe Khan', role: 'Support' }, 'Guest', 'Reply'],
		]);
		expect(JSON.stringify(activity)).not.toContain('Ayşe here');

		// the staff list: Ayşe joined; listing as her checks her in, and assigned=me means her
		const ticket = await sys.ticket(['inbox.read', 'inbox.manage']);
		const staff = async () =>
			(await sys.admin(ticket, 'GET', '/v1/admin/staff')).json.items.find((/** @type {any} */ m) => m.id === 'usr_ayse');
		expect(await staff()).toMatchObject({ name: 'Ayşe Khan', email: 'ayse@shop.example.com', presence: 'offline' });
		expect((await server(sys, 'GET', '/v1/conversations', { headers: AYSE })).json.items).toHaveLength(1);
		expect(await staff()).toMatchObject({ presence: 'online' });
		const assigned = await server(sys, 'PATCH', `/v1/conversations/${id}`, {
			body: { assignedTo: 'usr_ayse' },
			headers: AYSE,
		});
		expect(assigned.json.conversation.assignedTo).toEqual({ id: 'usr_ayse', name: 'Ayşe Khan' });
		expect((await server(sys, 'GET', '/v1/conversations?assigned=me', { headers: AYSE })).json.items).toHaveLength(1);
		expect((await server(sys, 'GET', '/v1/conversations/count?assigned=me', { headers: AYSE })).json).toEqual({
			count: 1,
			capped: false,
		});
		expect((await server(sys, 'GET', '/v1/conversations?assigned=me')).json.items).toHaveLength(0);
		const moves = (await server(sys, 'GET', '/v1/activity?actor=usr_ayse&action=conversation.assigned')).json.items;
		expect(moves.map((/** @type {any} */ e) => e.detail)).toEqual(['Assigned to Ayşe Khan']);

		// a ticket's note keeps the ticket's user; malformed actor headers are refused
		const note = await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/notes`, { text: 'VIP' });
		expect(note.json.message).toMatchObject({ name: 'Sam Staff', staffId: 'usr_sam', internal: true });
		const malformed = await server(sys, 'POST', `/v1/conversations/${id}/messages`, {
			body: { text: 'x' },
			headers: { 'ss-actor-id': 'not valid!', 'ss-actor-name': 'X' },
		});
		expect(malformed.status).toBe(400);
		expect(malformed.json.type).toMatch(/invalid_actor$/);
	});
});

describe('visitor calls from the merchant’s server (K3)', () => {
	it('act for one visitor with SS-Guest and SS-Visitor-IP; AI limits per network count by that address', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies']);
		await sys.connect('ai', AI_KEY);
		await sys.setting('ai_replies', 'repliesPerNetworkPerDay', 1);
		/** @param {string} method @param {string} path @param {{ body?: unknown, ip?: string, guest?: string }} [init] */
		const visit = (method, path, { body, ip, guest } = {}) =>
			server(sys, method, path, {
				...(body === undefined ? {} : { body }),
				headers: { ...(ip ? { 'ss-visitor-ip': ip } : {}), ...(guest ? { 'ss-guest': guest } : {}) },
			});
		const unnamed = await visit('POST', '/v1/chat/messages', { body: { text: 'Hi' } });
		expect(unnamed.status).toBe(400);
		expect(unnamed.json.type).toMatch(/visitor_ip_required$/);
		const first = await visit('POST', '/v1/chat/messages', { body: { text: 'Hello' }, ip: '198.51.100.7' });
		expect(first.status).toBe(201);
		expect(first.headers.get('access-control-allow-origin')).toBeNull();
		const guest = first.json.guestKey;
		const state = await visit('GET', '/v1/chat', { guest });
		expect(state.status).toBe(200);
		expect(state.json.messages.map((/** @type {any} */ m) => m.author)).toEqual(['visitor', 'ai']);
		expect(sys.aiCalls()).toHaveLength(1);
		// another visitor from the same address: the network's one AI reply is used up
		await visit('POST', '/v1/chat/messages', { body: { text: 'Hello' }, ip: '198.51.100.7' });
		expect(sys.aiCalls()).toHaveLength(1);
		await visit('POST', '/v1/chat/messages', { body: { text: 'Hello' }, ip: '198.51.100.8' });
		expect(sys.aiCalls()).toHaveLength(2);
		// the same visitor keeps their conversation
		const again = await visit('POST', '/v1/chat/messages', { body: { text: 'More' }, ip: '198.51.100.9', guest });
		expect(again.json.chat.conversation.id).toBe(first.json.chat.conversation.id);
	});
});

describe('conversation counts (K4)', () => {
	it('count and counts take the list’s filters and equal its lengths; the ticket twins too', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'signed_in_chat', 'inbox', 'handoff', 'assignment']);
		await sys.paste('accounts');
		const ann = sys.visitor();
		await ann('POST', '/v1/chat/messages', { text: 'Where is my parcel?' });
		await ann('POST', '/v1/chat/handoff');
		const bob = sys.visitor();
		const sent = await bob('POST', '/v1/chat/messages', { text: 'Do you sell kettles?' });
		await server(sys, 'POST', `/v1/conversations/${sent.json.chat.conversation.id}/messages`, { body: { text: 'Yes.' } });
		await server(sys, 'PATCH', `/v1/conversations/${sent.json.chat.conversation.id}`, { body: { status: 'resolved' } });
		const signIn = await sys.accounts.signIn({ websiteId: sys.websiteId, sub: 'usr_1', name: 'Rea Der' });
		await sys.visitor({ signIn })('POST', '/v1/chat/messages', { text: 'Hello from my account' });

		const filters = [
			'',
			'status=open',
			'status=resolved',
			'waiting=1',
			'visitor=guest',
			'visitor=user',
			'assigned=unassigned',
			'q=kettles',
			'status=open&visitor=guest',
			'status=nonsense',
		];
		for (const filter of filters) {
			const items = (await server(sys, 'GET', `/v1/conversations?${filter}`)).json.items;
			const counted = (await server(sys, 'GET', `/v1/conversations/count?${filter}`)).json;
			expect([filter, counted]).toEqual([filter, { count: items.length, capped: false }]);
		}
		expect((await server(sys, 'GET', '/v1/conversations/counts?by=status')).json).toEqual({
			total: 3,
			groups: { open: 2, resolved: 1 },
		});
		expect((await server(sys, 'GET', '/v1/conversations/counts?by=waiting')).json.groups).toEqual({ false: 2, true: 1 });
		expect((await server(sys, 'GET', '/v1/conversations/counts?by=guest')).json.groups).toEqual({ true: 2, false: 1 });
		expect((await server(sys, 'GET', '/v1/conversations/counts?by=unread&status=open')).json).toEqual({
			total: 2,
			groups: { true: 2 },
		});
		const unknown = await server(sys, 'GET', '/v1/conversations/counts?by=colour');
		expect(unknown.status).toBe(422);
		expect(unknown.json.detail).toBe('by is one of: status, waiting, guest, unread.');

		const ticket = await sys.ticket(['inbox.read']);
		const listed = (await sys.admin(ticket, 'GET', '/v1/admin/conversations?waiting=1')).json.items;
		expect((await sys.admin(ticket, 'GET', '/v1/admin/conversations/count?waiting=1')).json.count).toBe(listed.length);
		expect((await sys.admin(ticket, 'GET', '/v1/admin/conversations/counts?by=guest')).json.total).toBe(3);
		const reports = await sys.ticket(['reports.read']);
		expect((await sys.admin(reports, 'GET', '/v1/admin/conversations/count')).status).toBe(403);
		await sys.switchOn(['visitor_chat', 'guest_chat']);
		expect((await server(sys, 'GET', '/v1/conversations/count')).json.type).toMatch(/feature_off$/);
	});
});

describe('activity labels (K9)', () => {
	it('labels entries with a name or title and a short detail, never contents', async () => {
		const sys = await start([
			'visitor_chat',
			'guest_chat',
			'ai_replies',
			'inbox',
			'saved_replies',
			'knowledge_base',
			'knowledge_pages',
		]);
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', { text: 'My secret question' });
		const id = sent.json.chat.conversation.id;
		await v('POST', '/v1/chat/contact', { name: 'Ann Lee', email: 'ann@example.com' });
		await server(sys, 'PATCH', `/v1/conversations/${id}`, { body: { status: 'resolved', aiPaused: true } });
		const entry = await server(sys, 'POST', '/v1/knowledge/entries', {
			body: { kind: 'faq', title: 'Returns', text: 'Within 14 days.' },
			headers: AYSE,
		});
		await server(sys, 'DELETE', `/v1/knowledge/entries/${entry.json.entry.id}`);
		sys.responders.set(`${ORIGIN}/about`, () => ({ status: 200, type: 'text/html', body: '<title>About us</title><p>Hi</p>' }));
		const page = await server(sys, 'POST', '/v1/knowledge/pages', { body: { url: `${ORIGIN}/about` } });
		await server(sys, 'DELETE', `/v1/knowledge/pages/${page.json.page.id}`);
		const ticket = await sys.ticket(['inbox.read', 'inbox.manage']);
		const reply = await sys.admin(ticket, 'POST', '/v1/admin/saved-replies', { title: 'Hello', text: 'Hello there!' });
		await sys.admin(ticket, 'DELETE', `/v1/admin/saved-replies/${reply.json.reply.id}`);
		const items = (await server(sys, 'GET', '/v1/activity')).json.items;
		expect(items.map((/** @type {any} */ e) => [e.action, e.label, e.detail]).reverse()).toEqual([
			['conversation.status_changed', 'Ann Lee', 'Status: open → resolved'],
			['conversation.ai_paused_changed', 'Ann Lee', 'AI paused'],
			['knowledge.entry_created', 'Returns', 'FAQ'],
			['knowledge.entry_deleted', 'Returns', 'FAQ'],
			['knowledge.page_added', 'About us', 'Fetched'],
			['knowledge.page_deleted', 'About us', null],
			['saved_reply.created', 'Hello', null],
			['saved_reply.deleted', 'Hello', null],
		]);
		expect(JSON.stringify(items)).not.toMatch(/secret question|ann@example\.com|Within 14 days|Hello there/);
	});
});

describe('Format and business time zone (K7, K8)', () => {
	it('reach the widget config and the text the server makes', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'handoff', 'transcripts']);
		await sys.paste('notifications');
		sys.responders.set(`${ORIGIN}/.well-known/business.json`, () => ({
			status: 200,
			body: { version: 1, name: 'Shop', timeZone: 'Asia/Karachi' },
		}));
		const cookie = await sys.adminSession();
		await sys.dashboard(cookie, 'POST', `/v1/dashboard/websites/${sys.websiteId}/business/refresh`);
		const saved = await server(sys, 'PUT', '/v1/format', { body: { locale: 'en-GB' }, headers: AYSE });
		expect(saved.json.format).toMatchObject({ locale: 'en-GB', times: 'viewer' });
		const config = await sys.call('GET', '/v1/widget/config', { token: sys.browser, origin: ORIGIN });
		expect(config.json).toMatchObject({ format: { locale: 'en-GB' }, timeZone: 'Asia/Karachi' });
		const ticket = await sys.ticket(['inbox.read']);
		const admin = await sys.admin(ticket, 'GET', '/v1/widget/admin/config');
		expect(admin.json).toMatchObject({ format: { locale: 'en-GB' }, timeZone: 'Asia/Karachi' });

		// office hours in Karachi: 09:00–10:00 on weekdays; it is Monday 15:00 there
		await sys.setting('handoff', 'officeHours', ['mon-fri 09:00-10:00']);
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'hi' });
		const asked = await v('POST', '/v1/chat/handoff');
		expect(asked.json.chat.conversation.officeHours).toEqual({ open: false, backAt: '2026-10-06T04:00:00.000Z' });
		const state = await v('GET', '/v1/chat');
		expect(state.json.messages[1].text).toBe('Our team is away right now. They are back 6 Oct 2026, 09:00.');
		// the transcript's date: the business day the chat started, in the Format
		await v('POST', '/v1/chat/transcript', { email: 'ann@example.com' });
		const transcript = sys.messages().find((m) => m.template === 'chat.transcript');
		expect(transcript?.values.date).toBe('5 Oct 2026');
	});
});
