/**
 * Conversations end to end on the real router and MongoDB: a guest opens a conversation from the website (pk_ +
 * marker token), the AI answers through the merchant's AI connector (scripted provider), tokens are metered, events
 * published; the guest comes back with the marker; another visitor cannot read it; polling with ETags; closing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
beforeAll(async () => {
	h = await createHarness();
});
afterAll(async () => {
	await h?.close();
});

describe('guest conversation with an AI answer', () => {
	/** @type {string} */
	let marker;
	/** @type {string} */
	let conversationId;

	it('starts a conversation with the first message and answers it with the AI', async () => {
		h.network.ai('Hello! Orders usually ship within 24 hours.');
		const started = await h.browser('POST', '/v1/conversations', {
			body: { text: 'Hi, when do you ship orders?', context: { page: { url: 'https://shop.example.com/faq', title: 'FAQ' } } },
		});
		expect(started.status, JSON.stringify(started.json)).toBe(201);
		expect(started.json.marker.token).toMatch(/^cm1\./);
		expect(started.json.message).toMatchObject({ author: 'customer', text: 'Hi, when do you ship orders?' });
		expect(started.json.replies.map((/** @type {any} */ m) => m.text)).toEqual(['Hello! Orders usually ship within 24 hours.']);
		expect(started.json.conversation).toMatchObject({ status: 'open', identified: false, language: 'en', messageCount: 2 });
		marker = started.json.marker.token;
		conversationId = started.json.conversation.id;
		// the merchant's connector credentials were used
		const [call] = h.network.aiCalls();
		expect(call?.url).toBe('https://ai.test/v1/chat/completions');
		expect(call?.init.headers.authorization).toBe('Bearer sk-merchant-test-key');
		expect(call?.body.model).toBe('gpt-test');
		expect(call?.body.messages[0].role).toBe('system');
		expect(call?.body.messages.at(-1)).toEqual({ role: 'user', content: 'Hi, when do you ship orders?' });
	});

	it('stores messages in their own collection in the merchant database and meters tokens', async () => {
		const messages = await h.collection('messages').find({ websiteId: WEBSITE, conversationId }).toArray();
		expect(messages).toHaveLength(2);
		const conversation = await h.collection('conversations').findOne({ websiteId: WEBSITE, id: conversationId });
		expect(conversation).toMatchObject({ tokens: 140, counts: { messages: 2, customer: 1 } });
		expect(conversation?.retainUntil).toBeInstanceOf(Date);
		const usage = await h.usage();
		expect(usage.filter((u) => u.unit === 'ai_token').reduce((sum, u) => sum + Number(u.quantity), 0)).toBe(140);
		expect(usage.filter((u) => u.unit === 'conversation')).toHaveLength(1);
		expect(h.published('chatbot.started@1')).toHaveLength(1);
		expect(h.published('chatbot.message@1').length).toBeGreaterThanOrEqual(2);
	});

	it('lets the guest come back with the marker and refuses other visitors', async () => {
		const mine = await h.browser('GET', '/v1/conversations', { identity: marker });
		expect(mine.json.items.map((/** @type {any} */ c) => c.id)).toEqual([conversationId]);
		const nobody = await h.browser('GET', '/v1/conversations');
		expect(nobody.json.items).toEqual([]);
		const other = await h.browser('GET', `/v1/conversations/${conversationId}`, { identity: 'cm1.forged.sig' });
		expect(other.status).toBe(404);
		expect(other.headers.get('content-type')).toContain('application/problem+json');
	});

	it('polls with an ETag (304 when unchanged) and a since cursor', async () => {
		const first = await h.browser('GET', `/v1/conversations/${conversationId}/messages`, { identity: marker });
		expect(first.status).toBe(200);
		expect(first.json.items).toHaveLength(2);
		const etag = first.headers.get('etag');
		expect(etag).toBe(first.json.etag);
		const again = await h.browser('GET', `/v1/conversations/${conversationId}/messages`, {
			identity: marker,
			headers: { 'if-none-match': String(etag) },
		});
		expect(again.status).toBe(304);
		h.clock.advance(60_000);
		h.network.ai('Sure, we ship worldwide.');
		const sent = await h.browser('POST', `/v1/conversations/${conversationId}/messages`, {
			identity: marker,
			body: { text: 'Do you ship abroad?' },
		});
		expect(sent.status, JSON.stringify(sent.json)).toBe(201);
		const since = await h.browser(
			'GET',
			`/v1/conversations/${conversationId}/messages?since=${encodeURIComponent(sent.json.message.at)}`,
			{
				identity: marker,
				headers: { 'if-none-match': String(etag) },
			},
		);
		expect(since.status).toBe(200);
		expect(since.json.items.map((/** @type {any} */ m) => m.author)).toEqual(['customer', 'bot']);
	});

	it('replays a POST with the same Idempotency-Key without a second answer or charge', async () => {
		const before = h.network.aiCalls().length;
		const one = await h.browser('POST', `/v1/conversations/${conversationId}/messages`, {
			identity: marker,
			idempotencyKey: 'idk_same_message_1',
			body: { text: 'Thanks!' },
		});
		const two = await h.browser('POST', `/v1/conversations/${conversationId}/messages`, {
			identity: marker,
			idempotencyKey: 'idk_same_message_1',
			body: { text: 'Thanks!' },
		});
		expect(two.status).toBe(one.status);
		expect(two.json).toEqual(one.json);
		expect(h.network.aiCalls().length).toBe(before + 1);
	});

	it('closes the conversation (chatbot.closed@1, CSAT survey) and refuses new messages', async () => {
		const closed = await h.browser('POST', `/v1/conversations/${conversationId}/close`, { identity: marker, body: {} });
		expect(closed.status).toBe(200);
		expect(closed.json.conversation.status).toBe('closed');
		expect(closed.json.messages.map((/** @type {any} */ m) => m.kind)).toEqual(['event', 'csat']);
		expect(h.published('chatbot.closed@1')[0]?.data).toMatchObject({ conversationId, by: 'customer', handedOff: false });
		const late = await h.browser('POST', `/v1/conversations/${conversationId}/messages`, {
			identity: marker,
			body: { text: 'hello?' },
		});
		expect(late.status).toBe(409);
		expect(late.json.type).toMatch(/conversation_closed$/);
		const rated = await h.browser('POST', '/v1/ratings', {
			identity: marker,
			body: { conversationId, score: 5, comment: 'Great' },
		});
		expect(rated.status, JSON.stringify(rated.json)).toBe(201);
		const twice = await h.browser('POST', '/v1/ratings', { identity: marker, body: { conversationId, score: 4 } });
		expect(twice.status).toBe(409);
	});
});
