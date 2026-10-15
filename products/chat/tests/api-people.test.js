/**
 * PLAN 0.8.10 Chat, the people: handoff options (C4), staff alerts through the kit with phones and Accounts staff (C5),
 * reply alerts to visitors (C6), guests and sign-ins with imported keys, merges by time and claims by phone (C7),
 * older messages (C8), typing, Seen and the paused notice (C9), the inbox options (C11) and staff attachments (C12).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@ss/protocol';
import { AI_KEY, STORAGE_KEY, ready } from './helpers.js';

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
/** @param {any} json */
const authors = (json) => json.messages.map((/** @type {any} */ m) => [m.author, m.text]);

describe('handoff options (C4)', () => {
	it('the AI answers the message that asked for a person first, with no notice; then reassures later', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'inbox', 'handoff']);
		await sys.connect('ai', AI_KEY);
		await sys.setting('handoff', 'answerFirst', true);
		await sys.setting('handoff', 'notice', '');
		await sys.setting('handoff', 'showButton', false);
		await sys.setting('handoff', 'reassureAfterMinutes', 3);
		sys.ai({ text: 'Our lamps come with a year of warranty.' });
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', { text: 'warranty? I want to talk to someone' });
		expect(sent.json.chat.conversation.waiting).toBe(false);
		let state = await v('GET', '/v1/chat');
		expect(authors(state.json)).toEqual([
			['visitor', 'warranty? I want to talk to someone'],
			['ai', 'Our lamps come with a year of warranty.'],
			['system', 'Please leave your name and how we can reach you, and we will reply.'],
		]);
		expect(state.json.conversation.waiting).toBe(true);
		const config = await sys.call('GET', '/v1/widget/config', { token: sys.browser, origin: 'https://shop.example.com' });
		expect(config.json.settings.handoff.showButton).toBe(false);
		// quiet until 3 minutes after the handoff, then reassurance only
		await v('POST', '/v1/chat/messages', { text: 'hello?' });
		expect(sys.aiCalls()).toHaveLength(1);
		sys.advance(3 * 60_000);
		sys.ai({ text: 'A person will reply here soon.' });
		await v('POST', '/v1/chat/messages', { text: 'anyone?' });
		state = await v('GET', '/v1/chat');
		expect(authors(state.json).at(-1)).toEqual(['ai', 'A person will reply here soon.']);
		const prompt = sys.aiCalls().at(-1);
		expect(prompt.messages[0].content).toContain('Only reassure them');
		expect(prompt.tools ?? []).toEqual([]);
		// a failed reassurance says nothing
		sys.ai({ status: 500 });
		await v('POST', '/v1/chat/messages', { text: 'still there?' });
		expect(authors((await v('GET', '/v1/chat')).json).at(-1)).toEqual(['visitor', 'still there?']);
	});

	it('without answerFirst the chat goes to a person at once with the notice', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'signed_in_chat', 'ai_replies', 'inbox', 'handoff']);
		await sys.connect('ai', AI_KEY);
		await sys.setting('handoff', 'notice', 'Hold on, a person is coming.');
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'talk to someone' });
		expect(authors((await v('GET', '/v1/chat')).json).slice(1, 2)).toEqual([['system', 'Hold on, a person is coming.']]);
		expect(sys.aiCalls()).toHaveLength(0);
	});
});

describe('staff alerts and reply alerts (C5, C6)', () => {
	it('alerts emails and phones (SMS, or WhatsApp), Accounts staff who can reply, on every message when asked', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'staff_alerts', 'assignment']);
		await sys.paste('notifications');
		await sys.paste('accounts');
		sys.accounts.setUsers([
			{ id: 'usr_a', email: 'agent@shop.example.com', permissions: ['chat:inbox.reply'] },
			{ id: 'usr_b', phone: '+12025550143', permissions: ['chat:inbox.reply'] },
			{ id: 'usr_c', email: 'blocked@shop.example.com', blocked: true, permissions: ['*'] },
		]);
		await sys.setting('staff_alerts', 'recipients', ['boss@shop.example.com', '+44 20 7946 0958']);
		await sys.setting('staff_alerts', 'staffPermission', 'inbox.reply');
		await sys.setting('staff_alerts', 'frequency', 'every_message');
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'one' });
		await v('POST', '/v1/chat/messages', { text: 'two' });
		const sent = sys.messages();
		expect(sent).toHaveLength(8);
		expect(new Set(sent.map((m) => m.template))).toEqual(new Set(['chat.staff_new_message']));
		// phones get SMS by default: Chat's staff alerts have default words for SMS, none for WhatsApp
		expect(sent.slice(0, 4).map((m) => [m.channel, m.to])).toEqual([
			['email', { email: 'boss@shop.example.com' }],
			['sms', { phone: '+442079460958' }],
			['email', { email: 'agent@shop.example.com' }],
			['sms', { phone: '+12025550143' }],
		]);
		await sys.setting('staff_alerts', 'phoneChannel', 'whatsapp');
		await sys.setting('staff_alerts', 'frequency', 'first_unanswered');
		const other = sys.visitor();
		await other('POST', '/v1/chat/messages', { text: 'three' });
		await other('POST', '/v1/chat/messages', { text: 'four' });
		expect(
			sys
				.messages()
				.slice(8)
				.map((m) => m.channel),
		).toEqual(['email', 'whatsapp', 'email', 'whatsapp']);
	});

	it('a staff reply alerts a visitor who left, once until they check again', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'visitor_alerts']);
		await sys.paste('notifications');
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', {
			text: 'call me',
			page: { url: 'https://shop.example.com/lamps/a', kind: 'product' },
		});
		await v('POST', '/v1/chat/contact', { name: 'Ann', phone: '+447700900123' });
		const ticket = await sys.ticket();
		const path = `/v1/admin/conversations/${sent.json.chat.conversation.id}/messages`;
		// still here: no alert
		await sys.admin(ticket, 'POST', path, { text: 'Hi Ann' });
		expect(sys.messages()).toHaveLength(0);
		sys.advance(61_000);
		await sys.admin(ticket, 'POST', path, { text: 'We have **two** colors.' });
		await sys.admin(ticket, 'POST', path, { text: 'Anything else?' });
		expect(sys.messages()).toEqual([
			expect.objectContaining({
				channel: 'sms',
				template: 'chat.staff_reply',
				to: { phone: '+447700900123' },
				values: expect.objectContaining({
					name: 'Ann',
					staff: 'Sam Staff',
					preview: 'We have two colors.',
					link: 'https://shop.example.com/lamps/a',
				}),
			}),
		]);
		sys.advance(1000);
		await v('GET', '/v1/chat');
		sys.advance(61_000);
		await sys.admin(ticket, 'POST', path, { text: 'Back?' });
		expect(sys.messages()).toHaveLength(2);
	});

	it('a reply from the merchant’s server alerts with the staff name of the widget texts (C24)', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'visitor_alerts', 'transcripts']);
		await sys.paste('notifications');
		await sys.text('chat.staff', 'Équipe');
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', { text: 'call me' });
		await v('POST', '/v1/chat/contact', { name: 'Ann', email: 'ann@example.com' });
		sys.advance(61_000);
		await sys.serverCall('POST', `/v1/conversations/${sent.json.chat.conversation.id}/messages`, { text: 'Bonjour' });
		expect(sys.messages().map((m) => [m.template, m.values.staff])).toEqual([['chat.staff_reply', 'Équipe']]);
		// the transcript names the team the same way
		expect((await v('POST', '/v1/chat/transcript', { email: 'ann@example.com' })).status).toBe(202);
		expect(sys.messages().at(-1)?.values.transcript).toBe('You: call me\nÉquipe: Bonjour');
	});

	it('with How often every_reply each staff reply alerts a visitor who is away (C16)', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'visitor_alerts']);
		await sys.paste('notifications');
		await sys.setting('visitor_alerts', 'frequency', 'every_reply');
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', { text: 'call me' });
		await v('POST', '/v1/chat/contact', { name: 'Ann', email: 'ann@example.com' });
		const ticket = await sys.ticket();
		const path = `/v1/admin/conversations/${sent.json.chat.conversation.id}/messages`;
		// still here: no alert, whatever the frequency
		await sys.admin(ticket, 'POST', path, { text: 'Hi Ann' });
		expect(sys.messages()).toHaveLength(0);
		sys.advance(61_000);
		await sys.admin(ticket, 'POST', path, { text: 'We have two colors.' });
		await sys.admin(ticket, 'POST', path, { text: 'Anything else?' });
		expect(sys.messages().map((m) => [m.channel, m.values.preview])).toEqual([
			['email', 'We have two colors.'],
			['email', 'Anything else?'],
		]);
		// back in the chat: none until they are away again
		sys.advance(1000);
		await v('GET', '/v1/chat');
		await sys.admin(ticket, 'POST', path, { text: 'Great!' });
		expect(sys.messages()).toHaveLength(2);
		// the setting back to once: one alert until they check again
		await sys.setting('visitor_alerts', 'frequency', 'once');
		sys.advance(61_000);
		await sys.admin(ticket, 'POST', path, { text: 'One more thing' });
		await sys.admin(ticket, 'POST', path, { text: 'And another' });
		expect(sys.messages()).toHaveLength(3);
	});

	/**
	 * A visitor with these contacts who left the chat, and a staff reply to them: the reply alert's calls to
	 * Notifications as [channel, to].
	 * @param {Awaited<ReturnType<typeof start>>} sys
	 * @param {{ email?: string, phone?: string }} contact
	 */
	const alertOf = async (sys, contact) => {
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', { text: 'hello' });
		await v('POST', '/v1/chat/contact', { name: 'Ann', ...contact });
		sys.advance(61_000);
		const before = sys.messages().length;
		const path = `/v1/admin/conversations/${sent.json.chat.conversation.id}/messages`;
		await sys.admin(await sys.ticket(), 'POST', path, { text: 'Hi Ann' });
		return sys
			.messages()
			.slice(before)
			.map((m) => [m.channel, m.to]);
	};
	const both = { email: 'ann@example.com', phone: '+447700900123' };

	it('a reply alert goes by the channels in the order set: the first the visitor has an address for', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'visitor_alerts']);
		await sys.paste('notifications');
		// the default (none chosen): the channels Notifications takes, email, then SMS, then WhatsApp (C23)
		expect(await alertOf(sys, both)).toEqual([['email', { email: 'ann@example.com' }]]);
		expect(await alertOf(sys, { phone: '+447700900123' })).toEqual([['sms', { phone: '+447700900123' }]]);
		await sys.setting('visitor_alerts', 'channels', ['email', 'sms']);
		expect(await alertOf(sys, both)).toEqual([['email', { email: 'ann@example.com' }]]);
		expect(await alertOf(sys, { phone: '+447700900123' })).toEqual([['sms', { phone: '+447700900123' }]]);
		await sys.setting('visitor_alerts', 'channels', ['sms', 'whatsapp', 'email']);
		expect(await alertOf(sys, both)).toEqual([['sms', { phone: '+447700900123' }]]);
		// a channel the visitor has no address for is passed over; none left: no alert
		await sys.setting('visitor_alerts', 'channels', ['whatsapp']);
		expect(await alertOf(sys, { email: 'ann@example.com' })).toEqual([]);
	});

	it('by default the alert goes by the channels switched on in Notifications (C23)', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'visitor_alerts']);
		await sys.paste('notifications');
		const off = () => ({
			status: 403,
			body: { type: 'https://errors.example.dev/feature_off', title: 'Feature off', status: 403 },
		});
		// email and SMS are off in Notifications: WhatsApp takes it
		sys.responders.set('https://notifications.example.dev/v1/messages/email', off);
		sys.responders.set('https://notifications.example.dev/v1/messages/sms', off);
		expect(await alertOf(sys, both)).toEqual([
			['email', { email: 'ann@example.com' }],
			['sms', { phone: '+447700900123' }],
			['whatsapp', { phone: '+447700900123' }],
		]);
	});

	it('a channel Notifications does not take passes the alert to the next one', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'visitor_alerts']);
		await sys.paste('notifications');
		await sys.setting('visitor_alerts', 'channels', ['whatsapp', 'email']);
		const whatsapp = 'https://notifications.example.dev/v1/messages/whatsapp';
		// WhatsApp is off in Notifications
		sys.responders.set(whatsapp, () => ({
			status: 403,
			body: { type: 'https://errors.example.dev/feature_off', title: 'Feature off', status: 403 },
		}));
		const sent = [
			['whatsapp', { phone: '+447700900123' }],
			['email', { email: 'ann@example.com' }],
		];
		expect(await alertOf(sys, both)).toEqual(sent);
		// WhatsApp has no provider there: the message fails at once
		sys.responders.set(whatsapp, () => ({ status: 201, body: { id: 'msg_failed', status: 'failed' } }));
		expect(await alertOf(sys, both)).toEqual(sent);
		// the last channel not taken: nothing more to try
		expect(await alertOf(sys, { phone: '+447700900123' })).toEqual([['whatsapp', { phone: '+447700900123' }]]);
		// Notifications itself unreachable: the next channel is not tried
		sys.responders.set(whatsapp, () => ({ status: 503, body: {} }));
		expect(await alertOf(sys, both)).toEqual([['whatsapp', { phone: '+447700900123' }]]);
	});
});

describe('guests and sign-ins (C7)', () => {
	it('an imported guest cookie works; a guest chat merges by time into the account’s own; claims by phone', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'signed_in_chat', 'inbox']);
		await sys.paste('accounts');
		// a store's own guest cookie, imported as a hash (PLAN 0.8.10 Migration)
		const cookie = 'storeGuest-1234567890abcdef';
		const data = await sys.product.data.forWebsite(sys.websiteId);
		await data
			.collection('guests')
			.insertOne({ id: 'guest_imported', keyHash: sha256Hex(cookie), expireAt: new Date(sys.now() + 86_400_000) });
		const imported = sys.visitor({ guestKey: cookie });
		const first = await imported('POST', '/v1/chat/messages', { text: 'guest 1' });
		expect(first.json.guestKey).toBeUndefined();
		expect(first.json.chat.guestMessagesLeft).toBe(4);
		expect((await sys.visitor({ guestKey: 'short' })('GET', '/v1/chat')).json.conversation).toBeNull();
		// the account already has a conversation: the guest's merges into it by time
		const signIn = await sys.accounts.signIn({
			websiteId: sys.websiteId,
			sub: 'usr_ann',
			name: 'Ann',
			phone: '+44 7700 900123',
		});
		sys.advance(1000);
		await sys.visitor({ signIn })('POST', '/v1/chat/messages', { text: 'user 1' });
		sys.advance(1000);
		await imported('POST', '/v1/chat/messages', { text: 'guest 2' });
		const both = sys.visitor({ guestKey: cookie, signIn });
		const merged = await both('GET', '/v1/chat');
		expect(authors(merged.json)).toEqual([
			['visitor', 'guest 1'],
			['visitor', 'user 1'],
			['visitor', 'guest 2'],
		]);
		expect(merged.json.messages.map((/** @type {any} */ m) => m.seq)).toEqual([1, 2, 3]);
		expect(merged.json.guestMessagesLeft).toBeNull();
		// another device left the same phone as a guest: it moves with claim by phone
		const phoneGuest = sys.visitor();
		sys.advance(1000);
		await phoneGuest('POST', '/v1/chat/messages', { text: 'from my phone' });
		await phoneGuest('POST', '/v1/chat/contact', { phone: '07700-900123' });
		const user = sys.visitor({ signIn });
		expect((await user('GET', '/v1/chat')).json.messages).toHaveLength(3);
		await sys.setting('signed_in_chat', 'claimByPhone', true);
		expect(authors((await user('GET', '/v1/chat')).json).at(-1)).toEqual(['visitor', 'from my phone']);
		const conversations = (await sys.serverCall('GET', '/v1/conversations?userId=usr_ann')).json;
		expect(conversations.items).toHaveLength(1);
	});
});

describe('older messages, typing, Seen and the paused notice (C8, C9)', () => {
	it('pages back by sequence for visitors, staff and the server; hides typing and Seen when set', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'typing_receipts']);
		await sys.setting('guest_chat', 'messageLimit', 0);
		const v = sys.visitor();
		let id = '';
		for (let i = 1; i <= 7; i += 1) id = (await v('POST', '/v1/chat/messages', { text: `m${i}` })).json.chat.conversation.id;
		const latest = await v('GET', '/v1/chat?limit=3');
		expect(latest.json.messages.map((/** @type {any} */ m) => m.text)).toEqual(['m5', 'm6', 'm7']);
		expect(latest.json.earlier).toBe(true);
		const older = await v('GET', '/v1/chat?before=5&limit=3');
		expect(older.json.messages.map((/** @type {any} */ m) => m.text)).toEqual(['m2', 'm3', 'm4']);
		expect((await v('GET', '/v1/chat?before=2')).json).toMatchObject({ earlier: false, messages: [{ text: 'm1' }] });
		const ticket = await sys.ticket();
		const staffPage = await sys.admin(ticket, 'GET', `/v1/admin/conversations/${id}?before=3&limit=50`);
		expect(staffPage.json.messages.map((/** @type {any} */ m) => m.text)).toEqual(['m1', 'm2']);
		expect(staffPage.json.earlier).toBe(false);
		expect((await sys.serverCall('GET', `/v1/conversations/${id}?before=8&limit=1`)).json.messages[0].text).toBe('m7');
		// Seen and typing follow their settings
		await sys.admin(ticket, 'POST', `/v1/admin/conversations/${id}/read`);
		expect((await v('GET', '/v1/chat')).json.conversation.staffSeenSeq).toBe(7);
		await sys.setting('typing_receipts', 'showSeen', false);
		await sys.setting('typing_receipts', 'showTyping', false);
		const hidden = await v('GET', '/v1/chat');
		expect(hidden.json.conversation).toMatchObject({ staffSeenSeq: null, aiPending: false });
		expect((await sys.admin(ticket, 'GET', `/v1/admin/conversations/${id}`)).json.conversation.visitorSeenSeq).toBeUndefined();
		// the paused notice while staff paused the AI
		await sys.admin(ticket, 'PUT', `/v1/admin/conversations/${id}/ai`, { paused: true });
		expect((await v('GET', '/v1/chat')).json.conversation.paused).toBe(false);
		await sys.setting('visitor_chat', 'showPaused', true);
		expect((await v('GET', '/v1/chat')).json.conversation.paused).toBe(true);
	});
});

describe('inbox options (C11)', () => {
	it('hides guests until escalated; pausing by reply rights keeps who and why; one note; the first replier', async () => {
		const sys = await start([
			'visitor_chat',
			'guest_chat',
			'signed_in_chat',
			'inbox',
			'handoff',
			'assignment',
			'internal_notes',
		]);
		await sys.paste('accounts');
		const guest = sys.visitor();
		const g = (await guest('POST', '/v1/chat/messages', { text: 'guest here' })).json.chat.conversation.id;
		const signIn = await sys.accounts.signIn({ websiteId: sys.websiteId, sub: 'usr_bo', name: 'Bo' });
		const u = (await sys.visitor({ signIn })('POST', '/v1/chat/messages', { text: 'member here' })).json.chat.conversation.id;
		const full = await sys.ticket();
		await sys.setting('inbox', 'guests', 'escalated');
		const ids = async () =>
			(await sys.admin(full, 'GET', '/v1/admin/conversations')).json.items.map((/** @type {any} */ c) => c.id);
		expect(await ids()).toEqual([u]);
		expect((await sys.admin(full, 'GET', '/v1/admin/inbox/unread')).json).toEqual({ unread: 1, conversations: 1, open: 1 });
		expect((await sys.admin(full, 'GET', '/v1/admin/conversations/count')).json.count).toBe(1);
		sys.advance(1000);
		await guest('POST', '/v1/chat/handoff');
		expect(await ids()).toEqual([g, u]);
		// pausing: manage rights by default, reply rights when set
		const replier = await sys.ticket(['inbox.read', 'inbox.reply'], {
			id: 'usr_rae',
			name: 'Rae',
			email: 'rae@shop.example.com',
		});
		const pause = { paused: true, reason: 'Checking stock' };
		expect((await sys.admin(replier, 'PUT', `/v1/admin/conversations/${u}/ai`, pause)).status).toBe(403);
		await sys.setting('inbox', 'pauseNeeds', 'reply');
		const paused = await sys.admin(replier, 'PUT', `/v1/admin/conversations/${u}/ai`, pause);
		expect(paused.json.conversation).toMatchObject({
			aiPaused: true,
			aiPausedBy: { id: 'usr_rae', name: 'Rae' },
			aiPausedReason: 'Checking stock',
			aiPausedAt: '2026-10-05T10:00:01.000Z',
		});
		const resumed = await sys.serverCall('PUT', `/v1/conversations/${u}/ai`, { paused: false });
		expect(resumed.json.conversation.aiPaused).toBe(false);
		expect(resumed.json.conversation.aiPausedBy).toBeUndefined();
		expect((await sys.admin(replier, 'PUT', `/v1/admin/conversations/${u}/ai`, { paused: 'yes' })).status).toBe(422);
		// the first replier takes the chat
		await sys.setting('assignment', 'autoAssign', 'first_replier');
		await sys.admin(replier, 'POST', `/v1/admin/conversations/${u}/messages`, { text: 'On it' });
		const opened = await sys.admin(full, 'GET', `/v1/admin/conversations/${u}`);
		expect(opened.json.conversation.assignedTo).toEqual({ id: 'usr_rae', name: 'Rae' });
		// one note per chat
		expect((await sys.admin(full, 'PUT', `/v1/admin/conversations/${u}/note`, { text: 'x' })).status).toBe(409);
		await sys.setting('internal_notes', 'mode', 'single');
		expect((await sys.admin(full, 'POST', `/v1/admin/conversations/${u}/notes`, { text: 'x' })).status).toBe(409);
		const noted = await sys.admin(full, 'PUT', `/v1/admin/conversations/${u}/note`, { text: 'VIP customer' });
		expect(noted.json.conversation.note).toBe('VIP customer');
		expect((await sys.serverCall('PUT', `/v1/conversations/${u}/note`, { text: 'x'.repeat(4001) })).status).toBe(422);
		expect((await sys.serverCall('PUT', `/v1/conversations/${u}/note`, { text: '' })).json.conversation.note).toBe('');
		await sys.setting('internal_notes', 'mode', 'timeline');
		expect((await sys.serverCall('POST', `/v1/conversations/${u}/notes`, { text: 'server note' })).status).toBe(201);
		// one customer's conversations, the server staff list and delete through a ticket
		expect(
			(await sys.serverCall('GET', '/v1/conversations?userId=usr_bo')).json.items.map((/** @type {any} */ c) => c.id),
		).toEqual([u]);
		expect((await sys.serverCall('GET', '/v1/staff')).json.items.map((/** @type {any} */ m) => m.name)).toContain('Rae');
		expect((await sys.serverCall('POST', `/v1/conversations/${u}/read`)).status).toBe(204);
		expect((await sys.admin(replier, 'DELETE', `/v1/admin/conversations/${g}`)).status).toBe(403);
		expect((await sys.admin(full, 'DELETE', `/v1/admin/conversations/${g}`)).status).toBe(204);
		expect(await ids()).toEqual([u]);
	});
});

describe('staff attachments (C12)', () => {
	it('staff send Word, Excel and text files up to the staff size; visitors keep 10 MB and their types', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'attachments']);
		await sys.connect('storage', STORAGE_KEY);
		const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
		const ticket = await sys.ticket();
		const refused = await sys.admin(ticket, 'POST', '/v1/admin/uploads', { name: 'a.docx', type: docx, size: 1000 });
		expect(refused.status).toBe(422);
		await sys.setting('attachments', 'staffTypes', ['application/pdf', docx, 'text/plain']);
		await sys.setting('attachments', 'staffMaxSizeMb', 64);
		const big = await sys.admin(ticket, 'POST', '/v1/admin/uploads', { name: 'spec.docx', type: docx, size: 60 * 1024 * 1024 });
		expect(big.status, big.text).toBe(200);
		expect(big.json.attachment.key).toMatch(/^chat\/staff\/.+\.docx$/);
		expect(
			(await sys.admin(ticket, 'POST', '/v1/admin/uploads', { name: 'x.txt', type: 'text/plain', size: 65 * 1024 * 1024 }))
				.status,
		).toBe(422);
		const server = await sys.serverCall('POST', '/v1/uploads', { name: 'notes.txt', type: 'text/plain', size: 10 });
		expect(server.json.attachment.key).toMatch(/\.txt$/);
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', { text: 'hi' });
		const reply = await sys.admin(ticket, 'POST', `/v1/admin/conversations/${sent.json.chat.conversation.id}/messages`, {
			attachment: big.json.attachment,
		});
		expect((await sys.open(reply.json.message.attachment.url)).location).toContain('response-content-disposition');
		await sys.setting('attachments', 'visitorUploads', 'everyone');
		expect((await v('POST', '/v1/chat/uploads', { name: 'a.docx', type: docx, size: 10 })).status).toBe(422);
		const config = await sys.call('GET', '/v1/widget/config', { token: sys.browser, origin: 'https://shop.example.com' });
		expect(config.json.settings.attachments).toMatchObject({
			staffTypes: ['application/pdf', docx, 'text/plain'],
			staffMaxBytes: 64 * 1024 * 1024,
		});
	});
});
