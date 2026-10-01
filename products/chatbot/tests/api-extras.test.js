/**
 * Leads, proactive messages, transcripts, moderation, identity (claim, persistent history), guest and rate limits,
 * server-side (sk_) use, element gating, privacy export / anonymisation and the budget alert — on the real router.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@ss/contracts';
import { createTestIdentityIssuer } from '@ss/app-kit/testing';
import { createHarness, T0, WEBSITE, WEBSITE_2 } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
const issuer = createTestIdentityIssuer({ alg: 'ES256' });
const login = (/** @type {string} */ sub) => {
	const now = Math.floor((h?.clock.now() ?? T0) / 1000);
	return issuer.sign({ iss: issuer.section.issuer, sub, iat: now, exp: now + 3600 });
};
const PROACTIVE = [
	{
		id: 'cart_help',
		priority: 5,
		when: 'cart.value >= 10000',
		message: 'Questions about your order?',
		delay_seconds: 10,
		max_per_day: 1,
		dismiss_days: 7,
	},
];

beforeAll(async () => {
	h = await createHarness({ config: { proactive: { rules: PROACTIVE } } });
	await h.entitle({ identity: issuer.section });
});
afterAll(async () => h?.close());

/** @param {Record<string, any>} [body] @param {string | null} [identity] */
const start = async (body = {}, identity = null) => {
	h.clock.advance(1_000);
	const started = await h.browser('POST', '/v1/conversations', { body, identity });
	expect(started.status, JSON.stringify(started.json)).toBe(201);
	return started.json;
};

describe('lead capture', () => {
	it('validates fields and consent, links the conversation, publishes chatbot.lead_captured@1', async () => {
		const conv = await start({ text: 'hi' });
		const marker = conv.marker.token;
		const bad = await h.browser('POST', '/v1/leads', {
			identity: marker,
			body: { conversationId: conv.conversation.id, fields: { name: 'Ana', email: 'nope' } },
		});
		expect(bad.status).toBe(422);
		expect(bad.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/fields/email', '/consent']);
		h.clock.advance(1_000);
		const lead = await h.browser('POST', '/v1/leads', {
			identity: marker,
			body: {
				conversationId: conv.conversation.id,
				fields: { name: ' Ana ', email: 'ANA@example.org', message: 'Call me' },
				consent: true,
			},
		});
		expect(lead.status, JSON.stringify(lead.json)).toBe(201);
		expect(lead.json).toMatchObject({
			contact: { name: 'Ana', email: 'ana@example.org' },
			consent: { given: true },
			source: 'form',
			visitorId: expect.any(String),
		});
		expect(h.published('chatbot.lead_captured@1').at(-1)?.data).toMatchObject({
			leadId: lead.json.id,
			conversationId: conv.conversation.id,
			contact: { name: 'Ana', email: 'ana@example.org' },
			fields: ['name', 'email', 'message'],
		});
		const team = await h.call('GET', `/v1/conversations/${conv.conversation.id}`);
		expect(team.json.contact).toMatchObject({ email: 'ana@example.org' });
		const messages = await h.browser('GET', `/v1/conversations/${conv.conversation.id}/messages`, { identity: marker });
		expect(messages.json.items.at(-1).text).toBe("Thanks! We'll get back to you soon.");
		expect((await h.call('GET', '/v1/leads')).json.items[0].id).toBe(lead.json.id);
		expect((await h.call('GET', `/v1/leads/${lead.json.id}`)).json.id).toBe(lead.json.id);
		expect((await h.call('GET', '/v1/leads/lead_x')).status).toBe(404);
		expect((await h.browser('POST', '/v1/leads', { body: { conversationId: 'cnv_other', fields: {} } })).status).toBe(404);
		const standalone = await h.browser('POST', '/v1/leads', {
			body: { fields: { name: 'Bo', email: 'bo@example.org' }, consent: true },
		});
		expect(standalone.json.conversationId).toBeNull();
		const server = await h.call('POST', '/v1/leads', {
			body: {
				conversationId: conv.conversation.id,
				customerId: 'ignored',
				fields: { name: 'Ana', email: 'a@b.co' },
				consent: true,
			},
		});
		expect(server.status).toBe(201);
	});
});

describe('proactive messages', () => {
	it('evaluates rules with frequency caps and dismissal memory in the merchant database', async () => {
		const body = {
			context: { page: { path: '/cart' }, cart: { value: 12000, items: 2, currency: 'EUR' } },
			visitorId: 'anon_0123456789',
			sessionId: 's1',
		};
		const shown = await h.browser('POST', '/v1/proactive:evaluate', { idempotencyKey: null, body });
		expect(shown.json.message).toEqual({
			ruleId: 'cart_help',
			message: 'Questions about your order?',
			openWindow: false,
			delaySeconds: 10,
		});
		expect((await h.browser('POST', '/v1/proactive:evaluate', { idempotencyKey: null, body })).json.message).toBeNull(); // max_per_day 1
		expect(
			(
				await h.browser('POST', '/v1/proactive:evaluate', {
					idempotencyKey: null,
					body: { ...body, context: { cart: { value: 5 } }, visitorId: 'anon_other_visitor' },
				})
			).json.message,
		).toBeNull();
		const dismissed = await h.browser('POST', '/v1/proactive:dismiss', {
			body: { ruleId: 'cart_help', visitorId: 'anon_0123456789' },
		});
		expect(dismissed.json.dismissed).toBe(true);
		expect((await h.browser('POST', '/v1/proactive:dismiss', { body: { ruleId: 'cart_help' } })).json.dismissed).toBe(false);
		expect((await h.browser('POST', '/v1/proactive:dismiss', { body: {} })).status).toBe(422);
		const memory = await h.collection('visitors').findOne({ websiteId: WEBSITE, key: 'a:anon_0123456789' });
		expect(memory?.memory.dismissed.cart_help).toBeTypeOf('number');
		h.clock.advance(2 * 86_400_000);
		await h.entitle({ identity: issuer.section });
		expect((await h.browser('POST', '/v1/proactive:evaluate', { idempotencyKey: null, body })).json.message).toBeNull(); // dismissed for 7 days
		expect(
			(
				await h.browser('POST', '/v1/proactive:evaluate', {
					idempotencyKey: null,
					body: { ...body, visitorId: 'anon_fresh_visitor' },
				})
			).json.message?.ruleId,
		).toBe('cart_help');
		// a visitor with an open conversation is not interrupted
		const conv = await start({ text: 'hi' });
		expect(
			(
				await h.browser('POST', '/v1/proactive:evaluate', {
					idempotencyKey: null,
					identity: conv.marker.token,
					body: { context: body.context },
				})
			).json.message,
		).toBeNull();
		expect((await h.browser('GET', '/v1/proactive')).json.items).toEqual([{ id: 'cart_help', delaySeconds: 10 }]);
		expect((await h.call('GET', '/v1/proactive')).json.items[0]).toMatchObject({
			id: 'cart_help',
			when: 'cart.value >= 10000',
		});
		await h.entitle({ identity: issuer.section, elements: { proactive: false } });
		expect((await h.browser('POST', '/v1/proactive:evaluate', { idempotencyKey: null, body })).status).toBe(403);
		await h.entitle({ identity: issuer.section });
	});
});

describe('identity, history and limits', () => {
	it('moves guest history to the signed-in customer and keeps it across devices', async () => {
		const conv = await start({ text: 'hello as a guest' });
		const marker = conv.marker.token;
		const token = login('cus_claim');
		expect(
			(await h.browser('POST', '/v1/conversations:claim', { identity: token, body: { marker: 'cm1.bad.sig' } })).status,
		).toBe(422);
		expect((await h.browser('POST', '/v1/conversations:claim', { body: { marker } })).status).toBe(401);
		const claimed = await h.browser('POST', '/v1/conversations:claim', { identity: token, body: { marker } });
		expect(claimed.json.claimed).toBe(1);
		const mine = await h.browser('GET', '/v1/conversations', { identity: token });
		expect(mine.json.items.map((/** @type {any} */ c) => c.id)).toEqual([conv.conversation.id]);
		expect(mine.json.items[0].identified).toBe(true);
		const exported = await h.collection('messages').countDocuments({ websiteId: WEBSITE, customerId: 'cus_claim' });
		expect(exported).toBeGreaterThan(0);
		await h.browser('POST', `/v1/conversations/${conv.conversation.id}/close`, { identity: token, body: {} });
		await h.entitle({ identity: issuer.section, config: { window: { persistent_history: false } } });
		expect((await h.browser('GET', '/v1/conversations', { identity: token })).json.items).toEqual([]);
		await h.entitle({ identity: issuer.section });
		expect((await h.browser('GET', '/v1/conversations?status=closed', { identity: token })).json.items).toHaveLength(1);
		const read = await h.browser('POST', `/v1/conversations/${conv.conversation.id}/read`, { identity: token, body: {} });
		expect(read.json.unread).toBe(0);
		expect((await h.browser('POST', '/v1/conversations/cnv_nope/read', { identity: token, body: {} })).status).toBe(404);
	});

	it('enforces the guest message limit, open conversations per visitor, the message rate and input validation', async () => {
		await h.entitle({
			identity: issuer.section,
			config: { window: { guest_message_limit: 1, max_open_conversations: 2, messages_per_minute: 3 } },
		});
		const conv = await start({ text: 'first' });
		const marker = conv.marker.token;
		const blocked = await h.browser('POST', `/v1/conversations/${conv.conversation.id}/messages`, {
			identity: marker,
			body: { text: 'second' },
		});
		expect(blocked.status).toBe(403);
		expect(blocked.json.type).toMatch(/guest_limit_reached$/);
		expect(
			(await h.browser('GET', `/v1/conversations/${conv.conversation.id}`, { identity: marker })).json.guestLimitReached,
		).toBe(true);
		await h.browser('POST', '/v1/conversations', { identity: marker, body: {} });
		const third = await h.browser('POST', '/v1/conversations', { identity: marker, body: {} });
		expect(third.status).toBe(429);
		expect((await h.browser('POST', '/v1/conversations', { body: { text: 7 } })).status).toBe(422);
		await h.entitle({ identity: issuer.section, config: { window: { messages_per_minute: 1 } } });
		const fresh = await start({});
		const limited = [];
		for (const text of ['a', 'b'])
			limited.push(
				(
					await h.browser('POST', `/v1/conversations/${fresh.conversation.id}/messages`, {
						identity: fresh.marker.token,
						body: { text },
					})
				).status,
			);
		expect(limited).toEqual([201, 429]);
		expect(
			(
				await h.browser('POST', `/v1/conversations/${fresh.conversation.id}/messages`, {
					identity: fresh.marker.token,
					body: {},
				})
			).status,
		).toBe(429);
		await h.entitle({
			identity: issuer.section,
			config: { moderation: { blocked_terms: ['forbidden'], blocked_terms_action: 'reject' } },
		});
		const later = await start({});
		expect(
			(
				await h.browser('POST', `/v1/conversations/${later.conversation.id}/messages`, {
					identity: later.marker.token,
					body: { text: 'this is forbidden' },
				})
			).status,
		).toBe(422);
		expect(
			(
				await h.browser('POST', `/v1/conversations/${later.conversation.id}/messages`, {
					identity: later.marker.token,
					body: { text: '' },
				})
			).status,
		).toBe(422);
		await h.entitle({ identity: issuer.section });
	});

	it('lets the merchant server open and list conversations for its customers', async () => {
		const created = await h.call('POST', '/v1/conversations', {
			body: {
				customerId: 'cus_srv',
				subject: 'Order question',
				custom: { orderId: 'ord_9' },
				context: { page: { path: '/orders' } },
			},
		});
		expect(created.status, JSON.stringify(created.json)).toBe(201);
		expect(created.json.conversation).toMatchObject({
			customerId: 'cus_srv',
			subject: 'Order question',
			custom: { orderId: 'ord_9' },
		});
		expect(created.json.marker).toBeUndefined();
		const replay = await h.call('POST', '/v1/conversations', {
			idempotencyKey: 'idk_same_start',
			body: { customerId: 'cus_srv' },
		});
		const again = await h.call('POST', '/v1/conversations', {
			idempotencyKey: 'idk_same_start',
			body: { customerId: 'cus_srv' },
		});
		expect(again.json.conversation.id).toBe(replay.json.conversation.id);
		expect((await h.call('POST', '/v1/conversations', { body: { customerId: 7 } })).status).toBe(422);
		const listed = await h.call('GET', '/v1/conversations?customerId=cus_srv&limit=1');
		expect(listed.json.items).toHaveLength(1);
		expect(listed.json.hasMore).toBe(true);
		const next = await h.call(
			'GET',
			`/v1/conversations?customerId=cus_srv&limit=1&cursor=${encodeURIComponent(listed.json.nextCursor)}`,
		);
		expect(next.json.items[0].id).not.toBe(listed.json.items[0].id);
		expect((await h.call('GET', '/v1/conversations?status=open&assignee=none&team=support')).status).toBe(200);
		h.network.ai('Server-side answer.');
		const answered = await h.call('POST', `/v1/conversations/${created.json.conversation.id}/messages`, {
			body: { text: 'Where is ord_9?' },
		});
		expect(answered.json.replies[0].text).toBe('Server-side answer.');
		expect(answered.json.conversation).toHaveProperty('tokens');
		const closed = await h.call('POST', `/v1/conversations/${created.json.conversation.id}/close`, { body: {} });
		expect(closed.json.conversation.status).toBe('closed');
		expect(h.published('chatbot.closed@1').at(-1)?.data).toMatchObject({ by: 'api', customerId: 'cus_srv' });
	});
});

describe('transcripts and moderation', () => {
	it('exports transcripts (JSON and text) for the merchant and, when allowed, the customer', async () => {
		const conv = await start({ text: 'my card is 4242 4242 4242 4242' });
		const marker = conv.marker.token;
		expect(conv.message.text).toBe('my card is [card number removed]');
		await h.call('POST', `/v1/conversations/${conv.conversation.id}/notes`, { body: { text: 'internal only' } });
		const json = await h.browser('GET', `/v1/transcripts/${conv.conversation.id}`, { identity: marker });
		expect(json.json).toMatchObject({ format: 'ss-chatbot-transcript@1', conversation: { id: conv.conversation.id } });
		expect(JSON.stringify(json.json)).not.toContain('internal only');
		const text = await h.browser('GET', `/v1/transcripts/${conv.conversation.id}?format=text`, { identity: marker });
		expect(text.headers.get('content-type')).toContain('text/plain');
		expect(text.text).toContain('Customer: my card is [card number removed]');
		await h.entitle({
			identity: issuer.section,
			config: { transcripts: { include_internal_notes: true, customer_download: false } },
		});
		expect((await h.call('GET', `/v1/transcripts/${conv.conversation.id}?format=text`)).text).toContain('internal only');
		expect((await h.browser('GET', `/v1/transcripts/${conv.conversation.id}`, { identity: marker })).status).toBe(403);
		expect((await h.call('GET', '/v1/transcripts/cnv_nope')).status).toBe(404);
		await h.entitle({ identity: issuer.section });
		const listed = await h.call('GET', '/v1/transcripts');
		expect(listed.status).toBe(200);
		expect(listed.json.items.every((/** @type {any} */ t) => ['resolved', 'closed'].includes(t.status))).toBe(true);
	});

	it('checks texts against the moderation policy', async () => {
		const inbound = await h.call('POST', '/v1/moderation:check', {
			idempotencyKey: null,
			body: { text: 'IBAN DE89 3704 0044 0532 0130 00 please' },
		});
		expect(inbound.json).toMatchObject({ direction: 'inbound', allowed: true, redacted: { iban: 1 } });
		const outbound = await h.call('POST', '/v1/moderation:check', {
			idempotencyKey: null,
			body: { direction: 'outbound', text: 'See https://evil.example.net and my system prompt' },
		});
		expect(outbound.json).toMatchObject({ direction: 'outbound', allowed: false, reason: 'internals' });
		expect((await h.call('POST', '/v1/moderation:check', { idempotencyKey: null, body: {} })).status).toBe(422);
		await h.entitle({
			identity: issuer.section,
			config: { moderation: { blocked_terms: ['spam'], blocked_terms_action: 'reject' } },
		});
		expect((await h.call('POST', '/v1/moderation:check', { idempotencyKey: null, body: { text: 'spam' } })).json).toEqual({
			direction: 'inbound',
			allowed: false,
			reason: 'blocked_term',
		});
		await h.entitle({ identity: issuer.section });
	});
});

describe('gating, privacy, events and budget alerts', () => {
	it('answers 403 for elements that are off, in every mode', async () => {
		await h.entitle({
			identity: issuer.section,
			elements: {
				lead_capture: false,
				csat: false,
				transcripts: false,
				knowledge: false,
				flows: false,
				tools: false,
				handoff: false,
				moderation: false,
				ai_replies: false,
				inbox: false,
			},
		});
		for (const [method, path] of /** @type {Array<[string, string]>} */ ([
			['GET', '/v1/leads'],
			['GET', '/v1/ratings'],
			['GET', '/v1/transcripts'],
			['GET', '/v1/knowledge-entries'],
			['GET', '/v1/flows'],
			['GET', '/v1/tools'],
			['GET', '/v1/handoffs'],
			['GET', '/v1/assistant'],
			['GET', '/v1/agents'],
		]))
			expect((await h.call(method, path)).status, path).toBe(403);
		// without AI, flows or handoff the conversation still works (stored, nobody answers)
		const conv = await start({ text: 'anyone?' });
		expect(conv.replies).toEqual([]);
		await h.entitle({ identity: issuer.section });
	});

	it('exports and anonymises a subject (Portal-signed)', async () => {
		await h.call('POST', '/v1/conversations', { body: { customerId: 'cus_privacy', text: 'my secret question' } });
		const rawBody = JSON.stringify({ websiteId: WEBSITE, subject: { customerId: 'cus_privacy' }, requestId: createId('req') });
		/** @type {Record<string, any>} */
		const results = {};
		for (const operation of ['export', 'anonymize']) {
			const signed = await h.portal.signRequest({ method: 'POST', path: `/v1/data:${operation}`, body: rawBody });
			const response = await h.handle(
				new Request(`https://chatbot.example.com/v1/data:${operation}`, {
					method: 'POST',
					headers: { ...signed.headers, 'idempotency-key': createId('idk') },
					body: rawBody,
				}),
			);
			expect(response.status).toBe(200);
			results[operation] = await response.json();
		}
		expect(results.export.collections.messages.some((/** @type {any} */ m) => m.body === 'my secret question')).toBe(true);
		const message = await h
			.collection('messages')
			.findOne({ websiteId: WEBSITE, customerId: 'cus_privacy', author: 'customer' });
		expect(message?.body).toBeNull();
	});

	it('ignores events of websites without a subscription and other event types', async () => {
		expect(
			(
				await h.deliver(
					'order.placed@1',
					{
						orderId: 'ord_x',
						currency: 'EUR',
						lines: [{ itemId: 'i', quantity: 1, unitAmount: 1 }],
						amounts: { subtotal: 1, total: 1 },
					},
					{ websiteId: WEBSITE_2 },
				)
			).status,
		).toBe(200);
		expect(await h.collection('orders').countDocuments({ orderId: 'ord_x' })).toBe(0);
		expect((await h.deliver('page.viewed@1', { url: 'https://shop.example.com/', path: '/' })).status).toBe(200);
		expect((await h.deliver('order.paid@1', { orderId: 'ord_new', amount: { amount: 5, currency: 'EUR' } })).status).toBe(200);
		expect((await h.collection('orders').findOne({ websiteId: WEBSITE, orderId: 'ord_new' }))?.status).toBe('paid');
	});

	it('audits the monthly cost alert once the threshold is crossed', async () => {
		await h.entitle({
			identity: issuer.section,
			config: { ai_replies: { monthly_token_budget: 1_000_000_000, cost_alert_percent: 1 } },
		});
		const month = await h
			.collection('counters')
			.findOne({ websiteId: WEBSITE, key: { $regex: '^tokens:' } }, { sort: { key: -1 } });
		await h.entitle({
			identity: issuer.section,
			config: { ai_replies: { monthly_token_budget: Number(month?.value ?? 0) + 100, cost_alert_percent: 99 } },
		});
		h.network.ai('ok');
		await start({ text: 'cross the threshold' });
		const audit = await h.db.collection('ss_chatbot_audit').findOne({ websiteId: WEBSITE, action: 'ai.budget_alert' });
		expect(audit).not.toBeNull();
		await h.entitle({ identity: issuer.section });
	});
});
