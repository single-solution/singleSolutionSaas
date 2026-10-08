/**
 * Flows, leads, contact capture, ratings, transcripts, ending a chat and attachments.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { STORAGE_KEY, ready } from './helpers.js';

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

const FLOWS = [
	{
		id: 'quote',
		name: 'Quote',
		start: { kind: 'keyword', keywords: ['quote'] },
		steps: [
			{ kind: 'message', text: 'Happy to help.' },
			{ kind: 'question', text: 'For home or work?', buttons: ['Home', 'Work'] },
			{ kind: 'collect', field: 'email', text: 'Your e-mail?' },
			{ kind: 'collect', field: 'custom:budget', text: 'Your budget?' },
			{ kind: 'handoff' },
			{ kind: 'end' },
		],
	},
	{
		id: 'welcome',
		name: 'Welcome',
		start: { kind: 'page', path: '/products/**', delay: 5 },
		steps: [{ kind: 'message', text: 'Welcome!' }],
	},
];

describe('flows and leads', () => {
	it('a keyword starts a flow: buttons, collected fields (a lead), a custom field, then a handoff', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'leads_flows', 'custom_fields', 'inbox', 'handoff']);
		await sys.list('custom_fields', [{ key: 'budget', label: 'Budget', type: 'number' }]);
		await sys.list('flows', FLOWS);
		const v = sys.visitor();
		const sent = await v('POST', '/v1/chat/messages', { text: 'I need a quote' });
		expect(sent.json.chat.conversation.flow).toEqual({ id: 'quote', step: { kind: 'question', buttons: ['Home', 'Work'] } });
		expect((await v('POST', '/v1/chat/flow', { answer: 'Garden' })).status).toBe(422);
		const home = await v('POST', '/v1/chat/flow', { answer: 'Home' });
		expect(home.json.chat.conversation.flow.step).toEqual({ kind: 'collect', field: 'email', type: 'email', options: [] });
		expect((await v('POST', '/v1/chat/flow', { answer: 'not an e-mail' })).status).toBe(422);
		const email = await v('POST', '/v1/chat/flow', { answer: 'ann@example.com' });
		expect(email.json.chat.conversation.flow.step).toEqual({ kind: 'collect', field: 'budget', type: 'number', options: [] });
		const done = await v('POST', '/v1/chat/flow', { answer: '250' });
		expect(done.json.chat.conversation).toMatchObject({ flow: null, waiting: true, contactNeeded: false });
		const leads = await sys.serverCall('GET', '/v1/leads');
		expect(leads.json.items).toEqual([expect.objectContaining({ email: 'ann@example.com' })]);
		const lead = await sys.serverCall('GET', `/v1/leads/${leads.json.items[0].id}`);
		expect(lead.json.lead.email).toBe('ann@example.com');
		const conversation = await sys.serverCall('GET', `/v1/conversations/${done.json.chat.conversation.id}`);
		expect(conversation.json.conversation.fields).toEqual({ 'quote:2': 'Home', budget: 250 });
		// a flow runs once per conversation
		await v('POST', '/v1/chat/messages', { text: 'another quote' });
		expect((await v('GET', '/v1/chat')).json.conversation.flow).toBeNull();
		expect((await v('POST', '/v1/chat/flow', { answer: 'x' })).status).toBe(409);
	});

	it('a page flow starts from the widget; typing instead of tapping ends a flow', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'leads_flows']);
		await sys.list('flows', [FLOWS[1], { ...FLOWS[0], steps: [{ kind: 'question', text: 'Pick', buttons: ['A'] }] }]);
		const v = sys.visitor();
		expect((await v('POST', '/v1/chat/flows/welcome/start', { page: { url: 'https://shop.example.com/cart' } })).status).toBe(
			404,
		);
		const started = await v('POST', '/v1/chat/flows/welcome/start', { page: { url: 'https://shop.example.com/products/a/b' } });
		expect(started.status).toBe(201);
		expect(started.json.guestKey).toMatch(/^g_/);
		await v('POST', '/v1/chat/messages', { text: 'quote please' });
		expect((await v('GET', '/v1/chat')).json.conversation.flow).toMatchObject({ id: 'quote' });
		await v('POST', '/v1/chat/messages', { text: 'never mind' });
		const state = await v('GET', '/v1/chat');
		expect(state.json.conversation.flow).toBeNull();
		expect(state.json.messages.map((/** @type {any} */ m) => m.text)).toEqual([
			'Welcome!',
			'quote please',
			'Pick',
			'never mind',
		]);
		expect(state.json.messages[2].buttons).toEqual(['A']);
	});

	it('leads with the merchant’s fields, consent and custom fields; contact capture saves a lead', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'leads_flows', 'custom_fields']);
		await sys.list('custom_fields', [{ key: 'size', label: 'Size', type: 'choice', options: ['S', 'M'] }]);
		await sys.setting('leads_flows', 'leadFields', ['name', 'phone', 'message']);
		await sys.setting('leads_flows', 'customLeadFields', ['size']);
		await sys.setting('leads_flows', 'consentText', 'You may contact me.');
		const v = sys.visitor();
		const missing = await v('POST', '/v1/chat/leads', { fields: { name: 'Bo' } });
		expect(missing.status).toBe(422);
		expect(missing.json.errors.map((/** @type {any} */ e) => e.message)).toEqual([
			'phone is required.',
			'Leave an e-mail address or a phone number.',
			'Tick the consent box.',
		]);
		const saved = await v('POST', '/v1/chat/leads', {
			fields: { name: 'Bo', phone: '+44 20 7946 0000', message: 'Call me', size: 'M' },
			consent: true,
		});
		expect(saved.status).toBe(201);
		sys.advance(1000);
		const contact = await v('POST', '/v1/chat/contact', { email: 'bo@example.com' });
		expect(contact.json.guestKey).toMatch(/^g_/);
		const leads = await sys.serverCall('GET', '/v1/leads');
		expect(leads.json.items.map((/** @type {any} */ l) => l.email ?? l.phone)).toEqual(['bo@example.com', '+44 20 7946 0000']);
		expect(leads.json.items[1].custom).toEqual({ size: 'M' });
	});
});

describe('ratings, transcripts and attachments', () => {
	it('ends a chat, asks for a rating and takes it; sends a transcript through Notifications', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ratings', 'transcripts']);
		await sys.setting('ratings', 'scale', '2');
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'thanks, bye' });
		const ended = await v('POST', '/v1/chat/end');
		expect(ended.json.chat.conversation).toMatchObject({ status: 'resolved', ratingRequested: true });
		expect((await v('POST', '/v1/chat/rating', { score: 3 })).status).toBe(422);
		const rated = await v('POST', '/v1/chat/rating', { score: 2, comment: 'Great' });
		expect(rated.json.chat.conversation).toMatchObject({ rating: { score: 2, comment: 'Great' }, ratingRequested: false });
		const unconnected = await v('POST', '/v1/chat/transcript', { email: 'me@example.com' });
		expect(unconnected.status).toBe(503);
		await sys.paste('notifications');
		expect((await v('POST', '/v1/chat/transcript', { email: 'nope' })).status).toBe(422);
		const sent = await v('POST', '/v1/chat/transcript', { email: 'me@example.com' });
		expect(sent.status).toBe(202);
		expect(sys.messages()).toEqual([
			expect.objectContaining({
				template: 'chat.transcript',
				to: { email: 'me@example.com' },
				values: expect.objectContaining({ transcript: 'You: thanks, bye', business: 'Shop' }),
			}),
		]);
		// a message reopens a resolved chat
		expect((await v('POST', '/v1/chat/messages', { text: 'one more thing' })).json.chat.conversation.status).toBe('open');
	});

	it('visitors attach files as the setting allows, straight to the merchant’s storage', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'signed_in_chat', 'attachments']);
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'hi' });
		const off = await v('POST', '/v1/chat/uploads', { name: 'a.png', type: 'image/png', size: 100 });
		expect(off.status).toBe(403);
		await sys.setting('attachments', 'visitorUploads', 'everyone');
		const noStorage = await v('POST', '/v1/chat/uploads', { name: 'a.png', type: 'image/png', size: 100 });
		expect(noStorage.status).toBe(503);
		await sys.connect('storage', STORAGE_KEY);
		expect((await v('POST', '/v1/chat/uploads', { name: 'a.svg', type: 'image/svg+xml', size: 100 })).status).toBe(422);
		expect((await v('POST', '/v1/chat/uploads', { name: 'a.png', type: 'image/png', size: 6 * 1024 * 1024 })).status).toBe(422);
		const upload = await v('POST', '/v1/chat/uploads', { name: 'a.png', type: 'image/png', size: 100 });
		expect(upload.json.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
		expect(
			(await v('POST', '/v1/chat/messages', { attachment: { ...upload.json.attachment, key: 'chat/other/x.png' } })).status,
		).toBe(422);
		const sent = await v('POST', '/v1/chat/messages', { attachment: upload.json.attachment });
		expect(sent.status).toBe(201);
		expect(sent.json.message.attachment).toMatchObject({ name: 'a.png', type: 'image/png', size: 100 });
		expect(sent.json.message.attachment.url).toContain('X-Amz-Signature');
		await sys.setting('attachments', 'visitorUploads', 'signed_in');
		expect((await v('POST', '/v1/chat/uploads', { name: 'a.png', type: 'image/png', size: 100 })).status).toBe(403);
		expect((await v('POST', '/v1/chat/messages', { attachment: upload.json.attachment })).status).toBe(403);
	});
});
