/**
 * The inbox through tickets and the server API: filters and search, unread, replies, notes, status, AI pause,
 * assignment with presence and max chats, custom fields, the context panel, the AI summary, transcripts, rating
 * requests, saved replies, the staff list, attachments, deletion (one conversation, or every one, C20) and the activity
 * log copied to Accounts; knowledge and reports.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { AI_KEY, ORIGIN, STORAGE_KEY, ready } from './helpers.js';

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

const INBOX = [
	'visitor_chat',
	'guest_chat',
	'ai_replies',
	'inbox',
	'handoff',
	'assignment',
	'presence_queue',
	'internal_notes',
	'saved_replies',
	'context_panel',
	'custom_fields',
	'ai_summary',
	'typing_receipts',
	'ratings',
	'transcripts',
	'attachments',
	'staff_alerts',
];

describe('inbox', () => {
	it('staff read, reply, note, assign, pause the AI and resolve; the visitor sees Seen and replies', async () => {
		const sys = await start(INBOX);
		await sys.connect('ai', AI_KEY);
		await sys.paste('notifications');
		await sys.setting('staff_alerts', 'recipients', ['team@shop.example.com']);
		await sys.list('custom_fields', [{ key: 'tier', label: 'Tier', type: 'choice', options: ['Gold', 'Silver'] }]);
		const ann = sys.visitor();
		await ann('POST', '/v1/chat/messages', {
			text: 'Where is my package?',
			page: { url: `${ORIGIN}/orders`, title: 'Orders', kind: 'other' },
		});
		sys.advance(1000);
		const bob = sys.visitor();
		await bob('POST', '/v1/chat/messages', { text: 'Do you sell kettles?' });
		const ticket = await sys.ticket();
		const lee = await sys.ticket(undefined, { id: 'usr_lee', name: 'Lee', email: 'lee@shop.example.com' });
		await sys.admin(lee, 'GET', '/v1/admin/conversations');

		const list = await sys.admin(ticket, 'GET', '/v1/admin/conversations');
		expect(list.status).toBe(200);
		expect(list.json.items.map((/** @type {any} */ c) => c.preview)).toEqual(['Hello from the AI.', 'Hello from the AI.']);
		expect(list.json.unread).toBe(2);
		const search = await sys.admin(ticket, 'GET', '/v1/admin/conversations?q=package');
		expect(search.json.items).toHaveLength(1);
		const id = search.json.items[0].id;
		expect((await sys.admin(ticket, 'GET', '/v1/admin/conversations?status=resolved')).json.items).toEqual([]);
		expect((await sys.admin(ticket, 'GET', '/v1/admin/conversations?limit=1')).json).toMatchObject({ hasMore: true });

		const opened = await sys.admin(ticket, 'GET', `/v1/admin/conversations/${id}`);
		expect(opened.json.conversation.context).toMatchObject({
			page: { title: 'Orders' },
			device: 'Computer · Safari',
			conversations: 1,
		});
		expect((await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/read`)).status).toBe(204);
		expect((await sys.admin(ticket, 'GET', '/v1/admin/inbox/unread')).json).toEqual({ unread: 1, conversations: 1, open: 2 });
		expect((await ann('GET', '/v1/chat')).json.conversation.staffSeenSeq).toBe(2);

		const replied = await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/messages`, { text: 'On its way.' });
		expect(replied.status).toBe(201);
		expect(replied.json.message).toMatchObject({ author: 'staff', name: 'Sam Staff', internal: false });
		const note = await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/notes`, { text: 'Courier delayed' });
		expect(note.json.message.internal).toBe(true);
		const visitorView = await ann('GET', '/v1/chat');
		expect(visitorView.json.conversation.status).toBe('awaiting_visitor');
		expect(visitorView.json.messages.map((/** @type {any} */ m) => m.text)).toEqual([
			'Where is my package?',
			'Hello from the AI.',
			'On its way.',
		]);
		await ann('POST', '/v1/chat/read');
		const staffView = await sys.admin(ticket, 'GET', `/v1/admin/conversations/${id}`);
		expect(staffView.json.conversation.visitorSeenSeq).toBe(4);
		expect(staffView.json.messages.at(-1)).toMatchObject({ internal: true, text: 'Courier delayed' });

		// assignment respects max chats (Lee can take one)
		const staffList = await sys.admin(ticket, 'GET', '/v1/admin/staff');
		expect(staffList.json.items.map((/** @type {any} */ m) => m.name)).toEqual(['Lee', 'Sam Staff']);
		expect((await sys.admin(ticket, 'PATCH', '/v1/admin/staff/usr_lee', { maxChats: 0 })).status).toBe(422);
		expect((await sys.admin(ticket, 'PATCH', '/v1/admin/staff/usr_lee', { maxChats: 1 })).json.staff.maxChats).toBe(1);
		const reopened = await sys.admin(ticket, 'PATCH', `/v1/admin/conversations/${id}`, {
			status: 'open',
			assignedTo: 'usr_lee',
			aiPaused: true,
			fields: { tier: 'Gold' },
		});
		expect(reopened.json.conversation).toMatchObject({
			status: 'open',
			aiPaused: true,
			assignedTo: { id: 'usr_lee', name: 'Lee' },
			fields: { tier: 'Gold' },
		});
		const other = list.json.items.find((/** @type {any} */ c) => c.id !== id).id;
		const full = await sys.admin(ticket, 'PATCH', `/v1/admin/conversations/${other}`, { assignedTo: 'usr_lee' });
		expect(full.status).toBe(409);
		expect((await sys.admin(ticket, 'GET', '/v1/admin/staff')).json.items[0]).toMatchObject({
			open: 1,
			full: true,
			presence: 'online',
		});
		expect((await sys.admin(ticket, 'PATCH', `/v1/admin/conversations/${id}`, { fields: { tier: 'Bronze' } })).status).toBe(
			422,
		);
		expect((await sys.admin(ticket, 'PATCH', `/v1/admin/conversations/${id}`, { assignedTo: 'nobody' })).status).toBe(422);
		expect((await sys.admin(ticket, 'PATCH', `/v1/admin/conversations/${id}`, {})).status).toBe(422);
		expect(
			(await sys.admin(ticket, 'GET', '/v1/admin/conversations?assigned=unassigned')).json.items.map(
				(/** @type {any} */ c) => c.id,
			),
		).toEqual([other]);
		expect(
			(await sys.admin(lee, 'GET', '/v1/admin/conversations?assigned=me')).json.items.map((/** @type {any} */ c) => c.id),
		).toEqual([id]);

		// the AI is paused for this chat: a visitor message waits for staff
		const aiBefore = sys.aiCalls().length;
		await ann('POST', '/v1/chat/messages', { text: 'Any news?' });
		expect(sys.aiCalls()).toHaveLength(aiBefore);

		// presence: away, then offline after 5 minutes without a check-in
		expect((await sys.admin(lee, 'PUT', '/v1/admin/staff/me/presence', { presence: 'away' })).json).toEqual({
			presence: 'away',
		});
		expect((await sys.admin(lee, 'PUT', '/v1/admin/staff/me/presence', { presence: 'busy' })).status).toBe(422);
		sys.advance(6 * 60_000);
		await sys.admin(ticket, 'GET', '/v1/admin/conversations');
		const later = await sys.admin(ticket, 'GET', '/v1/admin/staff');
		expect(later.json.items.map((/** @type {any} */ m) => m.presence)).toEqual(['offline', 'online']);

		// summary, transcript, rating request, resolve
		sys.ai({ text: 'Package question; answered.' });
		expect((await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/summary`)).json).toEqual({
			summary: 'Package question; answered.',
		});
		expect(
			(await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/transcript`, { email: 'ann@example.com' })).status,
		).toBe(202);
		expect((await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/rating-request`)).status).toBe(204);
		expect((await ann('GET', '/v1/chat')).json.conversation.ratingRequested).toBe(true);
		// the same from the merchant's server
		sys.ai({ text: 'Asked about a package.' });
		expect((await sys.serverCall('POST', `/v1/conversations/${id}/summary`)).json).toEqual({
			summary: 'Asked about a package.',
		});
		const copy = await sys.serverCall('POST', `/v1/conversations/${id}/transcript`, { email: 'ann@example.com' });
		expect([copy.status, copy.json]).toEqual([202, { sent: true }]);
		expect((await sys.serverCall('POST', `/v1/conversations/${id}/rating-request`)).status).toBe(204);
		const resolved = await sys.admin(ticket, 'PATCH', `/v1/admin/conversations/${id}`, { status: 'resolved' });
		expect(resolved.json.conversation.status).toBe('resolved');
		expect((await sys.admin(ticket, 'PATCH', `/v1/admin/conversations/${id}`, { status: 'closed' })).status).toBe(422);
		expect((await sys.admin(ticket, 'GET', '/v1/admin/conversations/conv_nope')).status).toBe(404);
	});

	it('saved replies, staff attachments and the permissions of a ticket', async () => {
		const sys = await start(INBOX);
		const reader = await sys.ticket(['inbox.read']);
		const ticket = await sys.ticket();
		expect((await sys.admin(reader, 'POST', '/v1/admin/saved-replies', { title: 'Hi', text: 'Hello!' })).status).toBe(403);
		const created = await sys.admin(ticket, 'POST', '/v1/admin/saved-replies', { title: 'Hi', text: 'Hello!' });
		expect(created.status).toBe(201);
		const rid = created.json.reply.id;
		expect(
			(await sys.admin(ticket, 'PUT', `/v1/admin/saved-replies/${rid}`, { title: 'Hi', text: 'Hello there!' })).json.reply
				.text,
		).toBe('Hello there!');
		expect((await sys.admin(reader, 'GET', '/v1/admin/saved-replies')).json.items).toEqual([
			{ id: rid, title: 'Hi', text: 'Hello there!' },
		]);
		expect((await sys.admin(ticket, 'PUT', '/v1/admin/saved-replies/nope', { title: 'x', text: 'y' })).status).toBe(404);
		expect((await sys.admin(ticket, 'POST', '/v1/admin/saved-replies', { title: '', text: 'y' })).status).toBe(422);
		expect((await sys.admin(ticket, 'DELETE', `/v1/admin/saved-replies/${rid}`)).status).toBe(204);
		expect((await sys.admin(ticket, 'DELETE', `/v1/admin/saved-replies/${rid}`)).status).toBe(404);

		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', { text: 'hello' });
		const id = sent.json.chat.conversation.id;
		await sys.connect('storage', STORAGE_KEY);
		const upload = await sys.admin(ticket, 'POST', '/v1/admin/uploads', {
			name: 'invoice.pdf',
			type: 'application/pdf',
			size: 2000,
		});
		expect(upload.json.attachment.key).toMatch(/^chat\/staff\//);
		const replied = await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/messages`, {
			attachment: upload.json.attachment,
		});
		expect((await sys.open(replied.json.message.attachment.url)).location).toContain('response-content-disposition');
		expect(
			(await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/messages`, { attachment: { key: 'elsewhere' } })).status,
		).toBe(422);
		expect((await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/messages`, { text: '' })).status).toBe(422);
		expect((await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/notes`, { text: '' })).status).toBe(422);
		expect((await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/summary`)).status).toBe(503);
		expect((await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/transcript`, { email: 'x' })).status).toBe(422);
	});

	it('the server API lists, replies, changes and deletes conversations; staff actions reach Accounts', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'attachments']);
		await sys.paste('accounts');
		await sys.connect('storage', STORAGE_KEY);
		await sys.setting('attachments', 'visitorUploads', 'everyone');
		const v = sys.visitor();
		const upload = await v('POST', '/v1/chat/uploads', { name: 'a.jpg', type: 'image/jpeg', size: 10 });
		const sent = await v('POST', '/v1/chat/messages', { text: 'photo', attachment: upload.json.attachment });
		const id = sent.json.chat.conversation.id;
		expect((await sys.serverCall('GET', '/v1/conversations')).json.items).toHaveLength(1);
		expect((await sys.serverCall('GET', '/v1/inbox/unread')).json).toEqual({ unread: 1, conversations: 1, open: 1 });
		const replied = await sys.serverCall('POST', `/v1/conversations/${id}/messages`, { text: 'Nice photo.' });
		expect(replied.json.message.name).toBe('Team');
		expect((await sys.serverCall('PATCH', `/v1/conversations/${id}`, { assignedTo: null })).status).toBe(403);
		const ticket = await sys.ticket(['inbox.read', 'inbox.reply']);
		await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/messages`, { text: 'From Sam.' });
		// the conversation's copies (settings saves reach Accounts too)
		const copies = sys.accounts.copies
			.filter((c) => c.copy.action.startsWith('conversation.'))
			.map((c) => [c.copy.action, c.copy.actor.kind]);
		expect(copies).toEqual([
			['conversation.replied', 'server'],
			['conversation.replied', 'staff'],
		]);
		expect((await sys.serverCall('DELETE', `/v1/conversations/${id}`)).status).toBe(204);
		expect(sys.calls.some((c) => c.method === 'DELETE' && c.url.includes('/chat/guest-'))).toBe(true);
		expect((await sys.serverCall('GET', `/v1/conversations/${id}`)).status).toBe(404);
		expect((await v('GET', '/v1/chat')).json.conversation).toBeNull();
	});
});

describe('delete every conversation (C20)', () => {
	it('deletes every conversation and what belongs to it, with the server token and the domain typed', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'attachments', 'staff_alerts', 'leads_flows']);
		await sys.connect('storage', STORAGE_KEY);
		await sys.paste('notifications');
		await sys.setting('attachments', 'visitorUploads', 'everyone');
		await sys.setting('staff_alerts', 'recipients', ['boss@shop.example.com']);
		// Notifications does not take the staff alerts: they are saved to be tried again
		sys.responders.set('https://notifications.example.dev', () => ({ status: 503, body: {} }));
		const ann = sys.visitor();
		const upload = await ann('POST', '/v1/chat/uploads', { name: 'a.jpg', type: 'image/jpeg', size: 10 });
		await ann('POST', '/v1/chat/messages', { text: 'photo', attachment: upload.json.attachment });
		await ann('POST', '/v1/chat/leads', { fields: { name: 'Ann', email: 'ann@example.com' } });
		await sys.visitor()('POST', '/v1/chat/messages', { text: 'second' });
		const body = { scope: 'conversations', confirm: 'shop.example.com' };
		// the server token only; the domain typed; no other scope
		const browser = await sys.call('POST', '/v1/data/delete-all', { token: sys.browser, origin: ORIGIN, body });
		expect(browser.status).toBe(401);
		const ticket = await sys.call('POST', '/v1/data/delete-all', {
			token: await sys.ticket(),
			origin: 'https://admin.shop.example.com',
			body,
		});
		expect(ticket.status).toBe(401);
		const typo = await sys.serverCall('POST', '/v1/data/delete-all', { ...body, confirm: 'shop.example.org' });
		expect(typo.status).toBe(422);
		expect(typo.json.errors).toEqual([
			{ path: '/confirm', message: "Type the website's domain (shop.example.com) to confirm." },
		]);
		const scope = await sys.serverCall('POST', '/v1/data/delete-all', { ...body, scope: 'leads' });
		expect(scope.json.errors[0].path).toBe('/scope');
		expect((await sys.serverCall('GET', '/v1/conversations')).json.items).toHaveLength(2);
		const done = await sys.serverCall('POST', '/v1/data/delete-all', body);
		expect(done.status).toBe(200);
		expect(done.json).toEqual({
			scope: 'conversations',
			deleted: { conversations: 2, messages: 2, guests: 2, files: 1, alerts: 2 },
			more: false,
		});
		expect(sys.calls.filter((c) => c.method === 'DELETE' && c.url.includes(upload.json.attachment.key))).toHaveLength(1);
		expect((await sys.serverCall('GET', '/v1/conversations')).json.items).toEqual([]);
		// the guest's device key is gone with its chats; leads are records of their own and stay
		expect((await ann('GET', '/v1/chat')).json).toMatchObject({ conversation: null, visitor: { kind: 'none' } });
		expect((await sys.serverCall('GET', '/v1/leads')).json.items).toHaveLength(1);
		const data = await sys.product.data.forWebsite(sys.websiteId);
		expect(await data.collection('staff_alerts').countDocuments({ websiteId: sys.websiteId })).toBe(0);
		const [entry] = (await sys.serverCall('GET', '/v1/activity?action=data.deleted_all')).json.items;
		expect(entry).toMatchObject({
			action: 'data.deleted_all',
			target: 'conversations',
			detail: '2 conversations, 2 messages, 1 file',
		});
		// nothing left: nothing to delete
		expect((await sys.serverCall('POST', '/v1/data/delete-all', body)).json).toEqual({
			scope: 'conversations',
			deleted: { conversations: 0, messages: 0, guests: 0, files: 0, alerts: 0 },
			more: false,
		});
	});

	it('deleting one conversation also deletes the staff alerts still waiting to be sent about it', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'staff_alerts']);
		await sys.paste('notifications');
		await sys.setting('staff_alerts', 'recipients', ['boss@shop.example.com']);
		sys.responders.set('https://notifications.example.dev', () => ({ status: 503, body: {} }));
		const sent = await sys.visitor()('POST', '/v1/chat/messages', { text: 'Is the lamp in stock?' });
		await sys.visitor()('POST', '/v1/chat/messages', { text: 'someone else' });
		const data = await sys.product.data.forWebsite(sys.websiteId);
		const saved = async () =>
			(await data.collection('staff_alerts').find({ websiteId: sys.websiteId }).toArray()).map((row) => row.values.message);
		expect((await saved()).sort()).toEqual(['Is the lamp in stock?', 'someone else']);
		expect((await sys.serverCall('DELETE', `/v1/conversations/${sent.json.chat.conversation.id}`)).status).toBe(204);
		// its alert would have carried the deleted words for up to a day
		expect(await saved()).toEqual(['someone else']);
	});

	it('answers more when there is more than one call deletes, and the next call goes on', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'attachments']);
		await sys.connect('storage', STORAGE_KEY);
		const data = await sys.product.data.forWebsite(sys.websiteId);
		const at = new Date(sys.now());
		await data.collection('conversations').insertMany(
			Array.from({ length: 150 }, (_, i) => ({
				id: `conv_old${String(i).padStart(4, '0')}`,
				visitor: { kind: 'guest', id: `guest_old${i}` },
				guestIds: [],
				lastMessageAt: at,
			})),
		);
		await data.collection('messages').insertOne({
			id: 'msg_old0',
			conversationId: 'conv_old0000',
			seq: 1,
			author: 'visitor',
			text: '',
			internal: false,
			attachment: { key: 'chat/guest-old0/a.jpg', name: 'a.jpg', type: 'image/jpeg', size: 10 },
		});
		// a slow storage: the first batch takes longer than one call goes on
		sys.responders.set(STORAGE_KEY.endpoint, (call) => {
			if (call.method === 'DELETE') sys.advance(9_000);
			return { status: 204 };
		});
		const body = { scope: 'conversations', confirm: 'shop.example.com' };
		// the call stops after the slow group (ten conversations at a time), never redoing it
		const first = await sys.serverCall('POST', '/v1/data/delete-all', body);
		expect(first.json).toMatchObject({ deleted: { messages: 1, files: 1 }, more: true });
		expect(first.json.deleted.conversations % 10).toBe(0);
		expect(first.json.deleted.conversations).toBeLessThan(100);
		let total = first.json.deleted.conversations;
		let calls = 1;
		for (let answer = first.json; answer.more; calls += 1) {
			answer = (await sys.serverCall('POST', '/v1/data/delete-all', body)).json;
			expect(answer.deleted).toMatchObject({ messages: 0, files: 0 });
			total += answer.deleted.conversations;
		}
		expect([total, calls]).toEqual([150, 2]);
		expect(await data.collection('conversations').countDocuments({ websiteId: sys.websiteId })).toBe(0);
		expect(sys.calls.filter((call) => call.url.startsWith(STORAGE_KEY.endpoint) && call.method === 'DELETE')).toHaveLength(1);
	});

	it('stops between groups of ten when the attachments are slow, so the next call goes on after them', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'attachments']);
		await sys.connect('storage', STORAGE_KEY);
		const data = await sys.product.data.forWebsite(sys.websiteId);
		const at = new Date(sys.now());
		await data.collection('conversations').insertMany(
			Array.from({ length: 30 }, (_, i) => ({
				id: `conv_slow${String(i).padStart(4, '0')}`,
				visitor: { kind: 'guest', id: `guest_slow${i}` },
				guestIds: [],
				lastMessageAt: at,
			})),
		);
		await data.collection('messages').insertMany(
			Array.from({ length: 30 }, (_, i) => ({
				id: `msg_slow${i}`,
				conversationId: `conv_slow${String(i).padStart(4, '0')}`,
				seq: 1,
				author: 'visitor',
				text: '',
				internal: false,
				attachment: { key: `chat/guest-slow${i}/a.jpg`, name: 'a.jpg', type: 'image/jpeg', size: 10 },
			})),
		);
		// every file takes a second: one group of ten is past the eight seconds a call goes on
		sys.responders.set(STORAGE_KEY.endpoint, (call) => {
			if (call.method === 'DELETE') sys.advance(1_000);
			return { status: 204 };
		});
		const body = { scope: 'conversations', confirm: 'shop.example.com' };
		const answers = [];
		for (let more = true; more;) {
			const answer = (await sys.serverCall('POST', '/v1/data/delete-all', body)).json;
			answers.push(answer.deleted.conversations);
			more = answer.more;
		}
		expect(answers).toEqual([10, 10, 10]);
		// each file deleted once
		expect(sys.calls.filter((call) => call.url.startsWith(STORAGE_KEY.endpoint) && call.method === 'DELETE')).toHaveLength(30);
	});
});

describe('knowledge and reports', () => {
	it('edits knowledge entries and pages through tickets and the server API', async () => {
		const sys = await start(['visitor_chat', 'ai_replies', 'knowledge_base', 'knowledge_pages', 'knowledge_editor']);
		const ticket = await sys.ticket(['knowledge.edit']);
		expect((await sys.admin(ticket, 'POST', '/v1/admin/knowledge/entries', { kind: 'faq', title: '', text: 'x' })).status).toBe(
			422,
		);
		const article = await sys.serverCall('POST', '/v1/knowledge/entries', {
			kind: 'article',
			title: 'Care',
			text: 'Wash cold.\n\nDry flat.',
		});
		expect(article.status).toBe(201);
		const eid = article.json.entry.id;
		const updated = await sys.admin(ticket, 'PUT', `/v1/admin/knowledge/entries/${eid}`, {
			kind: 'article',
			title: 'Care guide',
			text: 'Wash cold.',
		});
		expect(updated.json.entry.title).toBe('Care guide');
		expect(
			(await sys.admin(ticket, 'PUT', '/v1/admin/knowledge/entries/kb_nope', { kind: 'faq', title: 'a', text: 'b' })).status,
		).toBe(404);
		expect((await sys.admin(ticket, 'GET', '/v1/admin/knowledge/entries?q=care')).json.items).toHaveLength(1);
		expect((await sys.serverCall('GET', '/v1/knowledge/entries?q=nothing')).json.items).toEqual([]);
		const changed = await sys.serverCall('PUT', `/v1/knowledge/entries/${eid}`, {
			kind: 'faq',
			title: 'How do I wash it?',
			text: 'Cold.',
		});
		expect(changed.json.entry).toMatchObject({ id: eid, kind: 'faq', title: 'How do I wash it?' });
		expect((await sys.admin(ticket, 'DELETE', `/v1/admin/knowledge/entries/${eid}`)).status).toBe(204);
		expect((await sys.admin(ticket, 'DELETE', `/v1/admin/knowledge/entries/${eid}`)).status).toBe(404);

		sys.responders.set(`${ORIGIN}/gone`, () => ({ status: 404, body: 'no' }));
		expect((await sys.admin(ticket, 'POST', '/v1/admin/knowledge/pages', { url: 'http://insecure.example.com' })).status).toBe(
			422,
		);
		const page = await sys.admin(ticket, 'POST', '/v1/admin/knowledge/pages', { url: `${ORIGIN}/gone` });
		expect(page.json.page).toMatchObject({
			status: 'failed',
			reason: 'http_status',
			httpStatus: 404,
			error: 'The page answered 404.',
		});
		sys.responders.set(`${ORIGIN}/gone`, () => ({
			status: 200,
			type: 'text/html',
			body: '<title>Back</title><p>Here again.</p>',
		}));
		const again = await sys.serverCall('POST', `/v1/knowledge/pages/${page.json.page.id}/fetch`);
		expect(again.json.page).toMatchObject({ status: 'ok', title: 'Back' });
		expect((await sys.serverCall('GET', '/v1/knowledge/pages')).json.items).toHaveLength(1);
		const fetched = await sys.admin(ticket, 'POST', `/v1/admin/knowledge/pages/${page.json.page.id}/fetch`);
		expect(fetched.json.page).toMatchObject({ status: 'ok', reason: null, httpStatus: null, error: null });
		expect((await sys.admin(ticket, 'GET', '/v1/admin/knowledge/pages')).json.items).toEqual([fetched.json.page]);
		expect((await sys.admin(ticket, 'DELETE', `/v1/admin/knowledge/pages/${page.json.page.id}`)).status).toBe(204);
		expect((await sys.admin(ticket, 'DELETE', `/v1/admin/knowledge/pages/${page.json.page.id}`)).status).toBe(404);
		expect((await sys.admin(ticket, 'POST', '/v1/admin/knowledge/pages/page_nope/fetch')).status).toBe(404);
		// a page with no answer at all: unreachable
		const nowhere = await sys.serverCall('POST', '/v1/knowledge/pages', { url: 'https://nowhere.example.org/faq' });
		expect(nowhere.json.page).toMatchObject({ status: 'failed', reason: 'unreachable', httpStatus: null });
	});

	it('reports count conversations, answers, reply times, ratings, leads and AI tokens', async () => {
		const sys = await start([
			'visitor_chat',
			'guest_chat',
			'ai_replies',
			'inbox',
			'handoff',
			'ratings',
			'leads_flows',
			'reports',
		]);
		await sys.connect('ai', AI_KEY);
		const a = sys.visitor();
		await a('POST', '/v1/chat/messages', { text: 'question' });
		await a('POST', '/v1/chat/end');
		await a('POST', '/v1/chat/rating', { score: 4 });
		sys.advance(86_400_000);
		const b = sys.visitor();
		const sent = await b('POST', '/v1/chat/messages', { text: 'I need a human' });
		await b('POST', '/v1/chat/leads', { fields: { name: 'B', email: 'b@example.com' } });
		sys.advance(90_000);
		await sys.serverCall('POST', `/v1/conversations/${sent.json.chat.conversation.id}/messages`, { text: 'Here.' });
		const ticket = await sys.ticket(['reports.read']);
		const report = await sys.admin(ticket, 'GET', '/v1/admin/reports?from=2026-10-05&to=2026-10-06');
		expect(report.json).toMatchObject({
			from: '2026-10-05',
			to: '2026-10-06',
			timeZone: 'UTC',
			days: [
				{ date: '2026-10-05', conversations: 1 },
				{ date: '2026-10-06', conversations: 1 },
			],
			conversations: 2,
			visitorMessages: 2,
			aiOnly: 1,
			handedOff: 1,
			medianFirstReplySeconds: 90,
			resolved: 1,
			rating: { average: 4, count: 1 },
			leads: 1,
			aiTokens: 120,
		});
		expect((await sys.serverCall('GET', '/v1/reports')).json.days).toHaveLength(30);
		expect((await sys.serverCall('GET', '/v1/reports?from=2026-10-06&to=2026-10-01')).status).toBe(422);
	});
});
