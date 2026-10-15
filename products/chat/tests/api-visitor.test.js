/**
 * The visitor API: guests, the AI reply after the response, the guest limit (lifted while the Customer role's sign-in
 * is paused, C17), signed-in visitors and the merge, handoff and office hours, flows, leads, contact capture, ratings,
 * transcripts, read receipts and attachments.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ACCOUNTS, AI_KEY, ORIGIN, ready } from './helpers.js';

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

describe('guests and AI replies', () => {
	it('a guest sends a message and gets an AI reply right after', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'typing_receipts']);
		await sys.connect('ai', AI_KEY);
		const v = sys.visitor();
		const empty = await v('GET', '/v1/chat');
		expect(empty.status).toBe(200);
		expect(empty.json).toMatchObject({ conversation: null, visitor: { kind: 'none' }, messages: [] });
		sys.ai({ text: 'We open at nine.' });
		const sent = await v('POST', '/v1/chat/messages', {
			text: 'When do you open?',
			page: { url: 'https://shop.example.com/p/1', title: 'Kettle', kind: 'product', productName: 'Kettle' },
		});
		expect(sent.status, sent.text).toBe(201);
		expect(sent.json.guestKey).toMatch(/^g_/);
		expect(sent.json.chat.conversation).toMatchObject({ status: 'open', aiPending: true });
		const state = await v('GET', '/v1/chat');
		expect(state.json.messages.map((/** @type {any} */ m) => [m.author, m.text])).toEqual([
			['visitor', 'When do you open?'],
			['ai', 'We open at nine.'],
		]);
		expect(state.json.conversation).toMatchObject({ aiPending: false, unread: 1 });
		const prompt = sys.aiCalls()[0].messages[0].content;
		expect(prompt).toContain('Business: Shop');
		expect(prompt).toContain('Kettle');
		const more = await v('GET', `/v1/chat?after=${state.json.lastSeq}`);
		expect(more.json.messages).toEqual([]);
		expect((await v('POST', '/v1/chat/read')).status).toBe(204);
		expect((await v('GET', '/v1/chat/unread')).json).toEqual({ unread: 0 });
	});

	it('applies the guest limit and offers what comes next', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'signed_in_chat', 'leads_flows']);
		await sys.setting('guest_chat', 'messageLimit', 1);
		const v = sys.visitor();
		expect((await v('POST', '/v1/chat/messages', { text: 'one' })).status).toBe(201);
		const second = await v('POST', '/v1/chat/messages', { text: 'two' });
		expect(second.status).toBe(403);
		expect(second.json).toMatchObject({ next: 'lead' });
		await sys.setting('signed_in_chat', 'signInUrl', 'https://shop.example.com/sign-in');
		expect((await v('POST', '/v1/chat/messages', { text: 'two' })).json).toMatchObject({ next: 'sign_in' });
		const state = await v('GET', '/v1/chat');
		expect(state.json.guestMessagesLeft).toBe(0);
		expect(state.json).not.toHaveProperty('guestLimit');
	});

	it('lifts the guest limit while the Customer role’s sign-in is paused at Accounts, with the setting (C17)', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'signed_in_chat']);
		await sys.setting('guest_chat', 'messageLimit', 1);
		await sys.paste('accounts');
		/** @type {{ status: number, body: unknown }} */
		let roles = {
			status: 200,
			body: {
				items: [
					{ key: 'owner', signIn: 'on' },
					{ key: 'customer', signIn: 'paused' },
				],
			},
		};
		sys.responders.set(`${ACCOUNTS}/v1/roles`, () => roles);
		const reads = () => sys.calls.filter((c) => c.url === `${ACCOUNTS}/v1/roles`);
		const v = sys.visitor();
		/** @param {string} text */
		const send = async (text) => (await v('POST', '/v1/chat/messages', { text })).status;
		const config = async () =>
			(await sys.call('GET', '/v1/widget/config', { token: sys.browser, origin: ORIGIN })).json.settings.guests;
		expect(await send('one')).toBe(201);
		// the setting off (the default): the limit applies and Accounts is never asked
		expect(await send('two')).toBe(403);
		expect(reads()).toHaveLength(0);
		await sys.setting('guest_chat', 'noLimitWithoutSignIn', true);
		expect(await send('two')).toBe(201);
		expect(await send('three')).toBe(201);
		const state = await v('GET', '/v1/chat');
		expect(state.json).toMatchObject({ guestMessagesLeft: null });
		expect((await config()).messageLimit).toBe(0);
		// asked once with the pasted Accounts token, then kept for a minute
		expect(reads()).toHaveLength(1);
		expect(reads()[0]?.headers.authorization).toMatch(/^Bearer /);
		// sign-in back on: the limit applies again once the minute is over
		roles = { status: 200, body: { items: [{ key: 'customer', signIn: 'on' }] } };
		expect(await send('four')).toBe(201);
		sys.advance(61_000);
		expect(await send('four')).toBe(403);
		expect((await config()).messageLimit).toBe(1);
		// paused again, then Accounts cannot be reached: the last answer stands
		roles = { status: 200, body: { items: [{ key: 'customer', signIn: 'paused' }] } };
		sys.advance(61_000);
		expect(await send('five')).toBe(201);
		roles = { status: 503, body: {} };
		sys.advance(61_000);
		expect(await send('six')).toBe(201);
		// Roles and permissions off at Accounts (or the token refused): not paused
		roles = { status: 403, body: { type: 'https://errors.example.dev/feature_off', title: 'Feature off', status: 403 } };
		sys.advance(61_000);
		expect(await send('seven')).toBe(403);
		expect(reads()).toHaveLength(5);
	});

	it('without guest chat a visitor must sign in; a bad message is refused', async () => {
		const sys = await start(['visitor_chat', 'signed_in_chat']);
		const v = sys.visitor();
		const refused = await v('POST', '/v1/chat/messages', { text: 'hi' });
		expect(refused.status).toBe(403);
		expect(refused.json.type).toMatch(/sign_in_required$/);
		expect((await v('POST', '/v1/chat/messages', { text: '' })).status).toBe(422);
		expect((await v('POST', '/v1/chat/read')).status).toBe(404);
	});

	it('a signed-in Accounts visitor chats as themselves; the guest chat moves to the account', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'signed_in_chat']);
		const guest = sys.visitor();
		await guest('POST', '/v1/chat/messages', { text: 'as a guest' });
		const signIn = await sys.accounts.signIn({
			websiteId: sys.websiteId,
			sub: 'usr_1',
			name: 'Rea Der',
			email: 'rea@example.com',
		});
		// without the pasted Accounts token the sign-in is not trusted: still the guest
		const before = sys.visitor({ guestKey: guest.state.guestKey, signIn });
		expect((await before('GET', '/v1/chat')).json.visitor.kind).toBe('guest');
		await sys.paste('accounts');
		const both = await before('GET', '/v1/chat');
		expect(both.json.visitor).toEqual({ kind: 'user', name: 'Rea Der', email: 'rea@example.com' });
		expect(both.json.messages.map((/** @type {any} */ m) => m.text)).toEqual(['as a guest']);
		const user = sys.visitor({ signIn });
		const sent = await user('POST', '/v1/chat/messages', { text: 'signed in now' });
		expect(sent.json.chat.visitor).toMatchObject({ kind: 'user', name: 'Rea Der' });
		expect(sent.json.guestKey).toBeUndefined();
	});

	it('moderation masks blocked terms, hides personal data and can refuse a message', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'moderation', 'inbox']);
		await sys.setting('moderation', 'blockedTerms', ['darn']);
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', { text: 'darn, mail me at a@b.co' });
		expect(sent.json.message.text).toBe('••••, mail me at [email]');
		await sys.setting('moderation', 'blockedAction', 'reject');
		const refused = await v('POST', '/v1/chat/messages', { text: 'darn it' });
		expect(refused.status).toBe(422);
	});
});

describe('handoff, office hours and failures', () => {
	it('a phrase hands off: waiting, the AI stops, the guest is asked for contact, staff are alerted', async () => {
		const sys = await start([
			'visitor_chat',
			'guest_chat',
			'ai_replies',
			'inbox',
			'handoff',
			'staff_alerts',
			'assignment',
			'presence_queue',
			'ai_summary',
		]);
		await sys.connect('ai', AI_KEY);
		await sys.paste('notifications');
		await sys.setting('staff_alerts', 'recipients', ['team@shop.example.com']);
		await sys.setting('staff_alerts', 'adminUrl', 'https://admin.shop.example.com/inbox?conversation={conversationId}');
		const v = sys.visitor();
		sys.ai({ text: 'Visitor wants a person.' });
		const sent = await v('POST', '/v1/chat/messages', { text: 'I want to talk to someone please' });
		expect(sent.json.chat.conversation).toMatchObject({ waiting: true, contactNeeded: true, queuePosition: 1 });
		const state = await v('GET', '/v1/chat');
		expect(state.json.messages.map((/** @type {any} */ m) => m.author)).toEqual(['visitor', 'system', 'system']);
		const sentAlerts = sys.messages().map((m) => m.template);
		expect(sentAlerts).toEqual(['chat.staff_new_message', 'chat.staff_needs_you']);
		expect(sys.messages()[1].values.link).toBe(
			`https://admin.shop.example.com/inbox?conversation=${state.json.conversation.id}`,
		);
		// the summary was written right after
		expect(sys.aiCalls().at(-1).messages[0].content).toContain('Summarize');
		await v('POST', '/v1/chat/messages', { text: 'hello?' });
		expect(sys.aiCalls()).toHaveLength(1);
		// the new-message alert went out once until staff open or reply
		expect(sys.messages().filter((m) => m.template === 'chat.staff_new_message')).toHaveLength(1);
		const contact = await v('POST', '/v1/chat/contact', { name: 'Ann', email: 'ann@example.com' });
		expect(contact.json.chat.conversation.contactNeeded).toBe(false);
		expect((await v('POST', '/v1/chat/contact', { name: 'Ann' })).status).toBe(422);
	});

	it('outside office hours the visitor is told when staff are back', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'handoff']);
		await sys.setting('handoff', 'officeHours', ['mon-fri 09:00-10:00']);
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'hi' });
		const asked = await v('POST', '/v1/chat/handoff');
		expect(asked.json.chat.conversation.officeHours).toEqual({ open: false, backAt: '2026-10-06T09:00:00.000Z' });
		const state = await v('GET', '/v1/chat');
		// the time in the website's Format (default: en) and the business time zone (UTC here)
		expect(state.json.messages[1].text).toBe('Our team is away right now. They are back Oct 6, 2026, 9:00 AM.');
	});

	it('outside office hours a guest who left no contact is offered the lead form, not only after a handoff', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'inbox', 'handoff', 'leads_flows']);
		await sys.setting('handoff', 'officeHours', ['mon-fri 09:00-10:00']);
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', { text: 'hi' });
		expect(sent.json.chat).toMatchObject({ leadOffered: true, conversation: { waiting: false } });
		// a guest key without a conversation yet is offered it too
		expect((await sys.visitor({ guestKey: 'k'.repeat(20) })('GET', '/v1/chat')).json.leadOffered).toBe(true);
		// while staff are in, no
		await sys.setting('handoff', 'officeHours', ['mon-fri 09:00-17:00']);
		expect((await v('GET', '/v1/chat')).json.leadOffered).toBe(false);
		await sys.setting('handoff', 'officeHours', ['mon-fri 09:00-10:00']);
		// once the guest left an email or phone, no
		expect((await v('POST', '/v1/chat/leads', { fields: { name: 'Ann', email: 'ann@example.com' } })).status).toBe(201);
		expect((await v('GET', '/v1/chat')).json.leadOffered).toBe(false);
		// a signed-in visitor, or a website without lead capture: never
		await sys.paste('accounts');
		await sys.switchOn(['visitor_chat', 'guest_chat', 'signed_in_chat', 'inbox', 'handoff', 'leads_flows']);
		const signIn = await sys.accounts.signIn({ websiteId: sys.websiteId, sub: 'usr_ann', name: 'Ann' });
		expect((await sys.visitor({ signIn })('GET', '/v1/chat')).json.leadOffered).toBe(false);
		await sys.switchOn(['visitor_chat', 'guest_chat', 'inbox', 'handoff']);
		expect((await sys.visitor()('GET', '/v1/chat')).json.leadOffered).toBe(false);
	});

	it('when the AI fails: the backup answers; then the message and a handoff', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'ai_backup', 'inbox', 'handoff']);
		await sys.connect('ai', AI_KEY);
		await sys.connect('ai_backup', { ...AI_KEY, apiKey: 'sk-backup-0123456789' });
		const v = sys.visitor();
		sys.ai({ status: 500 }, { text: 'Backup here.' });
		await v('POST', '/v1/chat/messages', { text: 'hi' });
		expect((await v('GET', '/v1/chat')).json.messages[1]).toMatchObject({ author: 'ai', text: 'Backup here.' });
		sys.ai({ status: 500 }, { status: 429 });
		await v('POST', '/v1/chat/messages', { text: 'again' });
		const state = await v('GET', '/v1/chat');
		expect(state.json.messages.slice(3).map((/** @type {any} */ m) => m.text)).toEqual([
			'Sorry, I cannot answer right now.',
			'A person from our team will reply here.',
			expect.any(String),
		]);
		expect(state.json.conversation.waiting).toBe(true);
	});

	it('token caps stop the AI; the cost alert goes out once a month', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'ai_caps', 'ai_cost_alerts', 'inbox', 'staff_alerts']);
		await sys.connect('ai', AI_KEY);
		await sys.paste('notifications');
		await sys.setting('staff_alerts', 'recipients', ['boss@shop.example.com']);
		await sys.setting('ai_caps', 'monthlyTokens', 200);
		await sys.setting('ai_cost_alerts', 'alertPercent', 50);
		await sys.setting('ai_replies', 'onFailure', 'message');
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'one' });
		await v('POST', '/v1/chat/messages', { text: 'two' });
		await v('POST', '/v1/chat/messages', { text: 'three' });
		expect(sys.aiCalls()).toHaveLength(2);
		const texts = (await v('GET', '/v1/chat')).json.messages.map((/** @type {any} */ m) => m.text);
		expect(texts.at(-1)).toBe('Sorry, I cannot answer right now.');
		expect(sys.messages().filter((m) => m.template === 'chat.staff_cost_alert')).toEqual([
			expect.objectContaining({
				to: { email: 'boss@shop.example.com' },
				values: expect.objectContaining({ cap: 200, percent: 50 }),
			}),
		]);
	});

	it('limits AI replies per visitor per day', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies']);
		await sys.connect('ai', AI_KEY);
		await sys.setting('ai_replies', 'repliesPerVisitorPerDay', 1);
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'one' });
		await v('POST', '/v1/chat/messages', { text: 'two' });
		expect(sys.aiCalls()).toHaveLength(1);
	});
});
