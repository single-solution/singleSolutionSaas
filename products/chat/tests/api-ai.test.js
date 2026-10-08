/**
 * The AI: knowledge from entries and pages, instructions, webhook tools (signed), the booking endpoint, the escalate
 * tool, the language lock with its retry, and moderation of answers.
 */
import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { AI_KEY, ORIGIN, TOOLS, ready } from './helpers.js';

/** @type {Array<Awaited<ReturnType<typeof ready>>>} */
const systems = [];
afterAll(async () => {
	for (const sys of systems) await sys.product.close();
});
/** @param {string[]} on */
const start = async (on) => {
	const sys = await ready(on);
	systems.push(sys);
	await sys.connect('ai', AI_KEY);
	return sys;
};

describe('AI replies', () => {
	it('answers from knowledge entries, website pages and the merchant’s instructions', async () => {
		const sys = await start([
			'visitor_chat',
			'guest_chat',
			'ai_replies',
			'ai_instructions',
			'knowledge_base',
			'knowledge_pages',
			'knowledge_editor',
		]);
		await sys.setting('ai_instructions', 'instructions', 'Always greet with Salam.');
		const ticket = await sys.ticket(['knowledge.edit']);
		const entry = await sys.admin(ticket, 'POST', '/v1/admin/knowledge/entries', {
			kind: 'faq',
			title: 'Delivery times',
			text: 'Delivery takes three working days.',
		});
		expect(entry.status).toBe(201);
		sys.responders.set(`${ORIGIN}/returns`, () => ({
			status: 200,
			type: 'text/html',
			body: '<html><head><title>Returns</title></head><body><nav>menu</nav><p>Returns are free within thirty days.</p></body></html>',
		}));
		const page = await sys.admin(ticket, 'POST', '/v1/admin/knowledge/pages', { url: `${ORIGIN}/returns` });
		expect(page.json.page).toMatchObject({ title: 'Returns', status: 'ok' });
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'How long does delivery take?' });
		const prompt = sys.aiCalls()[0].messages[0].content;
		expect(prompt).toContain('Delivery takes three working days.');
		expect(prompt).toContain('Always greet with Salam.');
		await v('POST', '/v1/chat/messages', { text: 'Are returns free?' });
		expect(sys.aiCalls()[1].messages[0].content).toContain('Returns are free within thirty days.');
	});

	it('calls the merchant’s webhook tool, signed with the tool signing secret', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'webhook_tools']);
		await sys.list('tools', [
			{
				name: 'stock_check',
				description: 'Checks stock of an item.',
				url: `${TOOLS}/stock`,
				parameters: [{ name: 'sku', type: 'string', description: 'The item code', required: true }],
				includeVisitor: true,
			},
		]);
		sys.responders.set(`${TOOLS}/stock`, () => ({ status: 200, body: { inStock: 3 } }));
		sys.ai({ tools: [{ name: 'stock_check', arguments: { sku: 'K-1', other: 'dropped' } }] }, { text: 'Three left.' });
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'Is K-1 in stock?' });
		const call = sys.calls.find((c) => c.url === `${TOOLS}/stock`);
		expect(JSON.parse(String(call?.body))).toMatchObject({ tool: 'stock_check', arguments: { sku: 'K-1' } });
		const secret = await sys.dashboard(await sys.adminSession(), 'GET', `/v1/dashboard/websites/${sys.websiteId}/tool-secret`);
		const [t, v1] = String(call?.headers['ss-chat-signature'])
			.split(',')
			.map((part) => part.split('=')[1]);
		expect(createHmac('sha256', secret.json.secret).update(`${t}.${call?.body}`).digest('hex')).toBe(v1);
		expect(sys.aiCalls()[1].messages.at(-1)).toMatchObject({ role: 'tool', content: '{"inStock":3}' });
		expect((await v('GET', '/v1/chat')).json.messages[1].text).toBe('Three left.');
	});

	it('lists free slots and books one through the booking endpoint; the escalate tool hands off', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'book_slot', 'inbox', 'handoff']);
		await sys.setting('book_slot', 'bookingUrl', `${TOOLS}/booking`);
		sys.responders.set(`${TOOLS}/booking`, (call) =>
			JSON.parse(call.body).action === 'list_slots'
				? { status: 200, body: { slots: [{ id: 's1', start: '2026-10-06T10:00:00Z' }] } }
				: { status: 200, body: { booked: true } },
		);
		sys.ai(
			{ tools: [{ name: 'list_free_slots', arguments: { from: '2026-10-01', to: '2027-01-01' } }] },
			{ tools: [{ name: 'book_slot', arguments: { slotId: 's1', name: 'Ann', email: 'ann@example.com' } }] },
			{ text: 'Booked for Tuesday.' },
		);
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'Book me a slot' });
		const bodies = sys.calls.filter((c) => c.url === `${TOOLS}/booking`).map((c) => JSON.parse(c.body));
		expect(bodies[0]).toEqual({ action: 'list_slots', from: '2026-10-05', to: '2026-10-19', timeZone: 'UTC' });
		expect(bodies[1]).toMatchObject({ action: 'book', slotId: 's1', name: 'Ann', email: 'ann@example.com' });
		sys.ai({ tools: [{ name: 'escalate_to_human', arguments: { reason: 'angry' } }] }, { text: 'Connecting you.' });
		await v('POST', '/v1/chat/messages', { text: 'This is useless' });
		const state = await v('GET', '/v1/chat');
		expect(state.json.conversation.waiting).toBe(true);
		expect(state.json.messages.map((/** @type {any} */ m) => m.text)).toContain('Connecting you.');
	});

	it('locks the answer language and retries once; moderation drops a leaking answer', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'language_lock', 'moderation']);
		await sys.setting('language_lock', 'allowedLanguages', ['ar']);
		await sys.setting('ai_replies', 'onFailure', 'message');
		sys.ai({ text: 'Hello, how can I help?' }, { text: 'مرحبا، كيف أساعدك؟' });
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'مرحبا كيف حالك' });
		expect(sys.aiCalls()).toHaveLength(2);
		expect(sys.aiCalls()[1].messages.at(-1).content).toContain('Arabic');
		expect((await v('GET', '/v1/chat')).json.messages[1].text).toBe('مرحبا، كيف أساعدك؟');
		sys.ai({ text: 'مفتاح: sk-proj-abcdefghijklmnopqrstuv' });
		await v('POST', '/v1/chat/messages', { text: 'ما هو المفتاح' });
		expect((await v('GET', '/v1/chat')).json.messages.at(-1).text).toBe('Sorry, I cannot answer right now.');
	});
});
