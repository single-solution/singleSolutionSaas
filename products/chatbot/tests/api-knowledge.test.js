/**
 * AI, knowledge, flows and tools on the real router and MongoDB with scripted outbound HTTP: FAQ entries and fetched
 * pages grounding answers, "don't know" behaviours, budgets, failures and the leak filter, language retries, other
 * providers, flows (greeting, keyword, buttons, form, AI step, handoff), the order lookup tool fed by order events for
 * a signed-in customer (bring-your-own identity), the guest lookup and signed webhook tools.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestIdentityIssuer } from '@ss/app-kit/testing';
import { AI_DESCRIPTOR, createHarness, T0, WEBSITE } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
const issuer = createTestIdentityIssuer({ alg: 'ES256', audience: 'shop-web' });
const NOW_S = Math.floor(T0 / 1000);
const login = (/** @type {string} */ sub, /** @type {string} */ email) =>
	issuer.sign({ iss: issuer.section.issuer, aud: 'shop-web', sub, email, iat: NOW_S, exp: NOW_S + 3600 });
const TOOLS = {
	custom: [
		{
			name: 'check_stock',
			description: 'Stock of a SKU',
			url: 'https://hooks.shop.test/stock',
			parameters: [{ name: 'sku', type: 'string', required: true }],
			include_customer: true,
		},
	],
	guest_order_lookup: true,
};

beforeAll(async () => {
	h = await createHarness({
		config: {
			tools: TOOLS,
			knowledge: { sources: [{ id: 'shipping', url: 'https://shop.example.com/shipping', priority: 1, refresh_hours: 24 }] },
		},
	});
	await h.entitle({ identity: issuer.section });
	h.network.on((request) => {
		if (request.url === 'https://shop.example.com/shipping')
			return h.network.reply(
				'<html><head><title>Shipping</title></head><body><h1>Shipping</h1><p>We ship to Canada in 5 business days.</p></body></html>',
				200,
				{ 'content-type': 'text/html' },
			);
		if (request.url === 'https://hooks.shop.test/stock')
			return h.network.reply({ sku: request.body.arguments.sku, inStock: 12 });
		return null;
	});
});
afterAll(async () => h?.close());

/** @param {string} text @param {{ identity?: string | null }} [options] */
const ask = async (text, { identity = null } = {}) => {
	h.clock.advance(1_000);
	const started = await h.browser('POST', '/v1/conversations', { body: { text }, identity });
	expect(started.status, JSON.stringify(started.json)).toBe(201);
	return started.json;
};
const lastPrompt = () => /** @type {string} */ (h.network.aiCalls().at(-1)?.body.messages[0].content);

describe('knowledge', () => {
	it('manages FAQ entries (create, batch, update, delete, limits) and searches them', async () => {
		const created = await h.call('POST', '/v1/knowledge-entries', {
			body: { question: 'What is your return policy?', answer: 'Free returns within 30 days.', tags: ['returns'] },
		});
		expect(created.status, JSON.stringify(created.json)).toBe(201);
		expect((await h.call('POST', '/v1/knowledge-entries', { body: { question: '' } })).status).toBe(422);
		const batch = await h.call('POST', '/v1/knowledge-entries:batch', {
			body: { items: [{ question: 'Do you have gift cards?', answer: 'Yes, from 10 to 500.' }, { question: '' }] },
		});
		expect(batch.json.results.map((/** @type {any} */ r) => r.status)).toEqual(['created', 'invalid']);
		expect((await h.call('POST', '/v1/knowledge-entries:batch', { body: {} })).status).toBe(422);
		const updated = await h.call('PATCH', `/v1/knowledge-entries/${created.json.id}`, {
			body: { answer: 'Free returns within 60 days.' },
		});
		expect(updated.json.answer).toBe('Free returns within 60 days.');
		expect((await h.call('PATCH', '/v1/knowledge-entries/kbe_x', { body: { answer: 'x' } })).status).toBe(404);
		expect((await h.call('PATCH', `/v1/knowledge-entries/${created.json.id}`, { body: { nope: 1 } })).status).toBe(422);
		expect((await h.call('GET', `/v1/knowledge-entries/${created.json.id}`)).json.question).toBe('What is your return policy?');
		expect((await h.call('GET', '/v1/knowledge-entries/kbe_x')).status).toBe(404);
		expect((await h.call('GET', '/v1/knowledge-entries')).json.items).toHaveLength(2);
		const search = await h.call('POST', '/v1/knowledge:search', {
			idempotencyKey: null,
			body: { query: 'return policy days', topK: 2 },
		});
		expect(search.json.items[0]).toMatchObject({ ref: 1, title: 'What is your return policy?' });
		expect((await h.call('POST', '/v1/knowledge:search', { idempotencyKey: null, body: {} })).status).toBe(422);
		const gift = batch.json.results[0].id;
		expect((await h.call('DELETE', `/v1/knowledge-entries/${gift}`)).status).toBe(204);
		expect((await h.call('DELETE', `/v1/knowledge-entries/${gift}`)).status).toBe(404);
		expect(
			(await h.call('POST', '/v1/knowledge:search', { idempotencyKey: null, body: { query: 'gift cards' } })).json.items,
		).toEqual([]);
		await h.entitle({ identity: issuer.section, config: { knowledge: { max_entries: 1 } } });
		expect((await h.call('POST', '/v1/knowledge-entries', { body: { question: 'Q?', answer: 'A.' } })).status).toBe(409);
		await h.entitle({ identity: issuer.section });
	});

	it('fetches configured pages through the outbound guard and grounds answers on passages', async () => {
		expect((await h.call('GET', '/v1/knowledge-sources')).json.items[0]).toMatchObject({ id: 'shipping', status: 'pending' });
		const refreshed = await h.call('POST', '/v1/knowledge-sources/shipping/refresh', { body: {} });
		expect(refreshed.json).toMatchObject({ id: 'shipping', chunks: 1, title: 'Shipping' });
		expect((await h.call('POST', '/v1/knowledge-sources/nope/refresh', { body: {} })).status).toBe(404);
		expect((await h.call('GET', '/v1/knowledge-sources')).json.items[0]).toMatchObject({ status: 'ok', chunks: 1 });
		h.network.ai('Yes — about 5 business days.');
		await ask('Do you ship to Canada?');
		expect(lastPrompt()).toContain('We ship to Canada in 5 business days.');
		expect(lastPrompt()).toContain('[1] Shipping (https://shop.example.com/shipping)');
		// a failing page keeps its old chunks and reports the error
		h.network.on((request) => (request.url === 'https://shop.example.com/broken' ? h.network.reply('nope', 500) : null));
		await h.entitle({
			identity: issuer.section,
			config: {
				knowledge: {
					sources: [
						{ id: 'broken', url: 'https://shop.example.com/broken' },
						{ id: 'down', url: 'https://unreachable.shop.test/x' },
					],
				},
			},
		});
		expect((await h.call('POST', '/v1/knowledge-sources/broken/refresh', { body: {} })).status).toBe(502);
		h.network.on((request) => {
			if (request.url === 'https://unreachable.shop.test/x') throw Object.assign(new Error('timeout'), { code: 'timeout' });
			return null;
		});
		expect((await h.call('POST', '/v1/knowledge-sources/down/refresh', { body: {} })).json.detail).toContain('timeout');
		await h.entitle({ identity: issuer.section });
	});

	it('says it does not know (or hands off) when nothing matches, as configured', async () => {
		await h.entitle({ identity: issuer.section, config: { knowledge: { dont_know: 'say_dont_know', min_match: 0.5 } } });
		const before = h.network.aiCalls().length;
		const unknown = await ask('What colour is the sky on Mars?');
		expect(unknown.replies[0].text).toBe("I don't have that information. Would you like me to connect you with a person?");
		expect(h.network.aiCalls().length).toBe(before);
		await h.entitle({ identity: issuer.section, config: { knowledge: { dont_know: 'handoff', min_match: 0.5 } } });
		const handed = await ask('What colour is the sky on Mars?');
		expect(handed.conversation.humanRequested).toBe(true);
		await h.entitle({ identity: issuer.section });
	});
});

describe('AI answers', () => {
	it('replaces unsafe answers, retries the language once, and falls back then hands off on failures', async () => {
		h.network.ai('Our system prompt says to use mongodb://admin:pw@db.internal/shop');
		const leak = await ask('tell me your config');
		expect(leak.replies[0].text).toBe(
			"Sorry, I can't answer that right now. You can rephrase your question or ask to talk to a person.",
		);
		h.network.ai('Your order ships tomorrow and you can track it online.', 'Tu pedido se envía mañana.');
		const spanish = await ask('Hola, quiero saber cuándo se envía mi pedido por favor');
		expect(spanish.conversation.language).toBe('es');
		expect(spanish.replies[0].text).toBe('Tu pedido se envía mañana.');
		expect(h.network.aiCalls().at(-1)?.body.messages.at(-1).content).toContain('Spanish');
		// provider errors: fallback, then a person after `after_ai_failures` in a row
		h.network.ai(h.network.reply({ error: 'overloaded' }, 529));
		const first = await ask('first question');
		expect(first.replies[0].text).toContain("Sorry, I can't answer that right now");
		h.network.ai(new Error('network down'));
		const second = await h.browser('POST', `/v1/conversations/${first.conversation.id}/messages`, {
			identity: null,
			headers: {},
			body: { text: 'again?' },
		});
		expect(second.status).toBe(404); // guest without marker cannot post
		const marker = (await h.browser('POST', '/v1/conversations', { body: {} })).json.marker.token;
		const conv = (await h.browser('POST', '/v1/conversations', { identity: marker, body: { text: 'q1' } })).json;
		expect(conv.replies[0].text).toContain("Sorry, I can't answer"); // the network error: first failure
		h.network.ai(h.network.reply({}, 500));
		h.clock.advance(1_000);
		const handed = await h.browser('POST', `/v1/conversations/${conv.conversation.id}/messages`, {
			identity: marker,
			body: { text: 'q2' },
		});
		expect(handed.status, JSON.stringify(handed.json)).toBe(201);
		expect(handed.json.conversation.humanRequested).toBe(true); // second failure in a row: a person
	});

	it('enforces the per-conversation and monthly token budgets', async () => {
		await h.entitle({
			identity: issuer.section,
			config: { ai_replies: { tokens_per_conversation: 1000, monthly_token_budget: 150 } },
		});
		const used = await h.collection('counters').findOne({ websiteId: WEBSITE, key: { $regex: '^tokens:' } });
		expect(used?.value).toBeGreaterThan(150);
		const before = h.network.aiCalls().length;
		const capped = await ask('anything');
		expect(capped.replies[0].text).toBe("I can't answer more questions here right now. You can ask to talk to a person.");
		expect(h.network.aiCalls().length).toBe(before);
		const status = await h.call('GET', '/v1/assistant');
		expect(status.json).toMatchObject({
			connector: { provider: 'openai', connected: true, model: 'gpt-test' },
			model: 'gpt-test',
			monthlyBudget: 150,
			remaining: 0,
		});
		const audit = await h.db.collection('ss_chatbot_audit').findOne({ websiteId: WEBSITE, action: 'ai.budget_alert' });
		expect(audit).toBeNull(); // the budget was lowered below usage: no crossing was observed
		await h.entitle({ identity: issuer.section, config: { ai_replies: { monthly_token_budget: 0, on_failure: 'silent' } } });
		h.network.ai(h.network.reply({}, 500));
		expect((await ask('silent please')).replies).toEqual([]);
		await h.entitle({ identity: issuer.section });
	});

	it('previews answers and works with Anthropic and Google connectors (merchant credentials only)', async () => {
		h.network.ai('Preview answer.');
		const preview = await h.call('POST', '/v1/assistant:preview', { body: { text: 'Do you ship to Canada?' } });
		expect(preview.json).toMatchObject({ replies: ['Preview answer.'], failure: null, passages: 1 });
		expect((await h.call('POST', '/v1/assistant:preview', { body: {} })).status).toBe(422);
		h.network.on((request) => {
			if (request.url === 'https://anthropic.test/v1/messages')
				return h.network.reply({
					content: [{ type: 'text', text: 'Hi from Claude.' }],
					usage: { input_tokens: 30, output_tokens: 4 },
				});
			if (request.url.startsWith('https://google.test/v1beta/models/gemini-test:generateContent'))
				return h.network.reply({
					candidates: [{ content: { parts: [{ text: 'Hi from Gemini.' }] } }],
					usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3 },
				});
			return null;
		});
		h.portal.setResource(
			WEBSITE,
			'ai',
			{
				provider: 'anthropic',
				baseUrl: 'https://anthropic.test/v1',
				apiKey: 'ant-key',
				authScheme: 'header',
				authHeader: 'x-api-key',
				headers: { 'anthropic-version': '2023-06-01' },
			},
			3_600_000,
		);
		h.chatbot.product.connectors.forget(WEBSITE);
		expect((await ask('hello claude')).replies[0].text).toBe('Hi from Claude.');
		const anthropic = h.network.requests.findLast((r) => r.url.includes('anthropic.test'));
		expect(anthropic?.init.headers['x-api-key']).toBe('ant-key');
		expect(anthropic?.body.model).toBe('claude-haiku-4-5');
		h.portal.setResource(
			WEBSITE,
			'ai',
			{
				provider: 'google',
				baseUrl: 'https://google.test/v1beta',
				apiKey: 'g-key',
				model: 'gemini-test',
				authScheme: 'header',
				authHeader: 'x-goog-api-key',
			},
			3_600_000,
		);
		h.chatbot.product.connectors.forget(WEBSITE);
		expect((await ask('hello gemini')).replies[0].text).toBe('Hi from Gemini.');
		// no model anywhere: the AI is unusable, so a person takes over
		h.portal.setResource(WEBSITE, 'ai', { provider: 'generic', baseUrl: 'https://llm.test/v1', apiKey: 'k' }, 3_600_000);
		h.chatbot.product.connectors.forget(WEBSITE);
		expect((await ask('hello generic')).conversation.humanRequested).toBe(true);
		h.portal.setResource(WEBSITE, 'ai', AI_DESCRIPTOR, 3_600_000);
		h.chatbot.product.connectors.forget(WEBSITE);
	});
});

describe('tools', () => {
	it('looks up the signed-in customer’s orders from order events (never anyone else’s)', async () => {
		const placed = await h.deliver('order.placed@1', {
			orderId: 'ord_0',
			currency: 'EUR',
			lines: [{ itemId: 'itm_1', quantity: 1, unitAmount: 1 }],
			amounts: { subtotal: 1, total: 1 },
		});
		expect(placed.status).toBe(200);
		await h.deliver('customer.created@1', { customerId: 'cus_ana', identities: [{ type: 'email', value: 'Ana@Example.org' }] });
		await h.deliver('order.placed@1', {
			orderId: 'ord_1',
			number: '1042',
			customerId: 'cus_ana',
			customer: { email: 'ana@example.org' },
			currency: 'EUR',
			lines: [{ itemId: 'itm_1', title: 'Sofa', quantity: 1, unitAmount: 50000 }],
			amounts: { subtotal: 50000, total: 50000 },
		});
		await h.deliver('order.paid@1', { orderId: 'ord_1', amount: { amount: 50000, currency: 'EUR' } });
		await h.deliver('order.completed@1', { orderId: 'ord_1' });
		await h.deliver('order.placed@1', { orderId: 'ord_1' }, { occurredAt: T0 - 1000 }); // late, older event: status does not move back
		await h.deliver('order.refunded@1', { orderId: 'ord_1', amount: { amount: 10000, currency: 'EUR' } });
		await h.deliver('order.placed@1', {
			orderId: 'ord_2',
			number: '2001',
			customerId: 'cus_bob',
			currency: 'EUR',
			lines: [{ itemId: 'itm_2', quantity: 1, unitAmount: 100 }],
			amounts: { subtotal: 100, total: 100 },
		});
		await h.deliver('customer.updated@1', { customerId: 'cus_ana', changed: ['name'] });
		const cached = await h.collection('orders').findOne({ websiteId: WEBSITE, orderId: 'ord_1' });
		expect(cached).toMatchObject({ status: 'partially_refunded', refunded: 10000, total: 50000, number: '1042' });
		h.network.ai({ tool: 'lookup_orders' }, 'Your order 1042 (Sofa) is completed.');
		const answer = await ask('Where is my order?', { identity: login('cus_ana', 'ana@example.org') });
		expect(answer.conversation.identified).toBe(true);
		expect(answer.replies[0].text).toBe('Your order 1042 (Sofa) is completed.');
		const toolResult = h.network
			.aiCalls()
			.at(-1)
			?.body.messages.find((/** @type {any} */ m) => m.role === 'tool');
		expect(toolResult.content).toContain('"number":"1042"');
		expect(toolResult.content).not.toContain('2001');
		const usage = await h.usage();
		expect(usage.some((u) => u.unit === 'tool_call')).toBe(true);
	});

	it('lets guests look up an order only with its number and e-mail', async () => {
		h.network.ai({ tool: 'lookup_order_by_number', arguments: { number: '#1042', email: 'ANA@example.org' } }, 'Found it.');
		await ask('status of order 1042, email ana@example.org');
		expect(
			h.network
				.aiCalls()
				.at(-1)
				?.body.messages.find((/** @type {any} */ m) => m.role === 'tool').content,
		).toContain('"status":"partially_refunded"');
		h.network.ai({ tool: 'lookup_order_by_number', arguments: { number: '1042', email: 'eve@example.org' } }, 'Not found.');
		await ask('order 1042 email eve@example.org');
		expect(
			h.network
				.aiCalls()
				.at(-1)
				?.body.messages.find((/** @type {any} */ m) => m.role === 'tool').content,
		).toBe('No order matches that number and e-mail.');
		h.network.ai({ tool: 'lookup_orders' }, 'Please sign in.');
		await ask('my orders');
		expect(
			h.network
				.aiCalls()
				.at(-1)
				?.body.messages.find((/** @type {any} */ m) => m.role === 'tool').content,
		).toBe('The customer is not signed in.');
	});

	it('calls webhook tools with validated arguments and a verifiable signature', async () => {
		h.network.ai({ tool: 'check_stock', arguments: { sku: 'SOFA-1' } }, 'We have 12 in stock.');
		const answer = await ask('Is SOFA-1 in stock?', { identity: login('cus_ana', 'ana@example.org') });
		expect(answer.replies[0].text).toBe('We have 12 in stock.');
		const hook = h.network.requests.findLast((r) => r.url === 'https://hooks.shop.test/stock');
		expect(hook?.body).toMatchObject({
			tool: 'check_stock',
			arguments: { sku: 'SOFA-1' },
			websiteId: WEBSITE,
			customer: { subject: 'cus_ana', email: 'ana@example.org' },
		});
		const secret = (await h.call('POST', '/v1/tools:signing-secret', { idempotencyKey: null, body: {} })).json.secret;
		const [t, v1] = String(hook?.init.headers['ss-chatbot-signature'])
			.split(',')
			.map((part) => part.split('=')[1]);
		expect(createHmac('sha256', secret).update(`ss-chatbot-tool.v1.${t}.${hook?.init.body}`).digest('hex')).toBe(v1);
		h.network.ai({ tool: 'check_stock', arguments: {} }, 'ok');
		await ask('stock?');
		expect(
			h.network
				.aiCalls()
				.at(-1)
				?.body.messages.find((/** @type {any} */ m) => m.role === 'tool').content,
		).toBe('invalid arguments: sku: required');
		h.network.ai({ tool: 'unknown_tool', arguments: {} }, 'ok');
		await ask('anything else?');
		const listed = await h.call('GET', '/v1/tools');
		expect(listed.json.items[0]).toMatchObject({ name: 'check_stock', parameters: { required: ['sku'] }, allowAi: true });
		const invoked = await h.call('POST', '/v1/tools/check_stock/invoke', { body: { arguments: { sku: 'A' } } });
		expect(invoked.json).toEqual({ ok: true, output: '{"sku":"A","inStock":12}' });
		expect((await h.call('POST', '/v1/tools/nope/invoke', { body: {} })).status).toBe(404);
		h.network.on((request) =>
			request.url === 'https://hooks.shop.test/stock' && request.body?.arguments?.sku === 'DOWN'
				? h.network.reply('err', 500)
				: null,
		);
		expect((await h.call('POST', '/v1/tools/check_stock/invoke', { body: { arguments: { sku: 'DOWN' } } })).json.ok).toBe(true); // the first handler answers first
	});
});

describe('flows', () => {
	const FLOWS = [
		{
			id: 'welcome',
			trigger: { type: 'conversation_start' },
			start: 'hi',
			nodes: [{ id: 'hi', type: 'message', text: 'Welcome! Ask me anything.' }],
		},
		{
			id: 'returns',
			priority: 5,
			trigger: { type: 'keyword', keywords: ['return'] },
			start: 'menu',
			nodes: [
				{
					id: 'menu',
					type: 'buttons',
					text: 'How can I help with returns?',
					buttons: [
						{ label: 'Start a return', value: 'start', next: 'form' },
						{ label: 'Talk to us', next: 'human' },
					],
				},
				{
					id: 'form',
					type: 'form',
					text: 'Your order',
					fields: [{ name: 'order', type: 'text', required: true }],
					next: 'tag',
				},
				{ id: 'tag', type: 'action', action: { kind: 'add_tag', name: 'returns' }, next: 'prio' },
				{ id: 'prio', type: 'action', action: { kind: 'set_priority', name: 'high' }, next: 'tool' },
				{ id: 'tool', type: 'action', action: { kind: 'call_tool', name: 'check_stock' }, next: 'ai' },
				{ id: 'ai', type: 'ai_step', prompt: 'Confirm the return of order {vars.order}', next: 'close' },
				{ id: 'close', type: 'action', action: { kind: 'close' } },
				{ id: 'human', type: 'handoff', text: 'Connecting you.' },
			],
		},
	];
	it('greets with a start flow, runs a keyword flow with buttons, a form, actions, a tool, an AI step and closing', async () => {
		await h.entitle({ identity: issuer.section, config: { flows: { flows: FLOWS } } });
		const greeted = await h.browser('POST', '/v1/conversations', { body: {} });
		expect(greeted.json.messages.map((/** @type {any} */ m) => m.text)).toEqual(['Welcome! Ask me anything.']);
		const marker = greeted.json.marker.token;
		const id = greeted.json.conversation.id;
		h.clock.advance(1_000);
		const menu = await h.browser('POST', `/v1/conversations/${id}/messages`, {
			identity: marker,
			body: { text: 'I want to return something' },
		});
		expect(menu.json.replies[0]).toMatchObject({
			kind: 'buttons',
			payload: {
				buttons: [
					{ label: 'Start a return', value: 'start' },
					{ label: 'Talk to us', value: 'Talk to us' },
				],
			},
		});
		h.clock.advance(1_000);
		const form = await h.browser('POST', `/v1/conversations/${id}/messages`, {
			identity: marker,
			body: { action: { kind: 'button', value: 'start', label: 'Start a return' } },
		});
		expect(form.json.message.text).toBe('Start a return');
		expect(form.json.replies[0]).toMatchObject({ kind: 'form', payload: { fields: [{ name: 'order' }] } });
		h.clock.advance(1_000);
		h.network.ai('Your return for 1042 is confirmed.');
		const done = await h.browser('POST', `/v1/conversations/${id}/messages`, {
			identity: marker,
			body: { action: { kind: 'form', values: { order: '1042' } } },
		});
		expect(done.json.replies.map((/** @type {any} */ m) => m.text)).toContain('Your return for 1042 is confirmed.');
		expect(lastPrompt()).toContain('CURRENT STEP: Confirm the return of order 1042');
		const stored = await h.collection('conversations').findOne({ websiteId: WEBSITE, id });
		expect(stored).toMatchObject({ status: 'closed', tags: ['returns'], priority: 'high', flow: null });
		expect(
			(await h.browser('POST', `/v1/conversations/${id}/messages`, { identity: marker, body: { action: { kind: 'wave' } } }))
				.status,
		).toBe(409);
	});
	it('hands off from a flow and serves the flow builder API', async () => {
		const start = await h.browser('POST', '/v1/conversations', { body: { text: 'return please' } });
		h.clock.advance(1_000);
		const human = await h.browser('POST', `/v1/conversations/${start.json.conversation.id}/messages`, {
			identity: start.json.marker.token,
			body: { text: 'Talk to us' },
		});
		expect(human.json.conversation.humanRequested).toBe(true);
		expect(human.json.replies[0].text).toBe('Connecting you.');
		const bad = await h.browser('POST', `/v1/conversations/${start.json.conversation.id}/messages`, {
			identity: start.json.marker.token,
			body: { action: { kind: 'wave' } },
		});
		expect(bad.status).toBe(422);
		const listed = await h.call('GET', '/v1/flows');
		expect(listed.json.items.map((/** @type {any} */ f) => f.diagnostics.ok)).toEqual([true, true]);
		expect(
			(await h.call('POST', '/v1/flows:check', { idempotencyKey: null, body: { flow: { id: 'x', start: 'a', nodes: [] } } }))
				.json.ok,
		).toBe(false);
		expect((await h.call('POST', '/v1/flows:check', { idempotencyKey: null, body: { condition: 'vars.x ==' } })).json.ok).toBe(
			false,
		);
		expect((await h.call('POST', '/v1/flows:check', { idempotencyKey: null, body: { condition: 5 } })).status).toBe(422);
		expect((await h.call('POST', '/v1/flows:check', { idempotencyKey: null, body: {} })).status).toBe(422);
		const simulated = await h.call('POST', '/v1/flows:simulate', {
			idempotencyKey: null,
			body: {
				flowId: 'returns',
				inputs: [{ kind: 'button', value: 'start' }, { kind: 'form', values: { order: '7' } }, 'ignored'],
			},
		});
		expect(simulated.json.steps.map((/** @type {any} */ s) => s.outputs.map((/** @type {any} */ o) => o.kind))).toEqual([
			['buttons'],
			['form'],
			['text'],
		]);
		expect(simulated.json.steps[2].outputs[0].text).toBe('[ai_step] Confirm the return of order 7');
		expect(
			(
				await h.call('POST', '/v1/flows:simulate', {
					idempotencyKey: null,
					body: { flow: { id: 'x', start: 'a', nodes: [] } },
				})
			).json.steps,
		).toEqual([]);
		expect((await h.call('POST', '/v1/flows:simulate', { idempotencyKey: null, body: { flowId: 'nope' } })).status).toBe(404);
		await h.entitle({ identity: issuer.section });
	});
});
