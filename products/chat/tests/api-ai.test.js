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
			'ai_replies',
			'knowledge_base']);
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
		// the default style (C15)
		expect(prompt).toContain('How to write: Be friendly, short and accurate. Keep answers to a few short sentences.');
		await sys.setting('ai_replies', 'style', 'Formal and detailed.');
		// the bot's name is a widget text (C16)
		expect(prompt).toContain('Your name is Assistant.');
		await sys.text('chat.botName', 'Lumi');
		await v('POST', '/v1/chat/messages', { text: 'Are returns free?' });
		expect(sys.aiCalls()[1].messages[0].content).toContain('Returns are free within thirty days.');
		expect(sys.aiCalls()[1].messages[0].content).toContain('How to write: Formal and detailed.');
		expect(sys.aiCalls()[1].messages[0].content).toContain('Your name is Lumi.');
		expect((await v('GET', '/v1/chat')).json.messages.at(-1).name).toBe('Lumi');
	});

	it('uses only the entries in the visitor’s language, or in any language (C21)', async () => {
		const sys = await start(['visitor_chat', 'ai_replies', 'knowledge_base']);
		await sys.setting('language_lock', 'allowedLanguages', ['en', 'fr']);
		for (const entry of [
			{ kind: 'faq', title: 'Delivery', text: 'Delivery takes three days.', language: 'en' },
			{ kind: 'faq', title: 'Livraison delivery', text: 'La livraison prend trois jours.', language: 'fr' },
			{ kind: 'faq', title: 'Delivery area', text: 'We deliver to every country.', language: '' },
		])
			expect((await sys.serverCall('POST', '/v1/knowledge/entries', entry)).status).toBe(201);
		sys.ai({ text: 'Three days.' });
		await sys.visitor()('POST', '/v1/chat/messages', { text: 'How long does delivery take?' });
		const prompt = String(sys.aiCalls()[0].messages[0].content);
		expect(prompt).toContain('Delivery takes three days.');
		expect(prompt).toContain('We deliver to every country.');
		expect(prompt).not.toContain('La livraison');
	});

	it('calls the merchant’s webhook tool, signed with the tool signing secret', async () => {
		const sys = await start(['visitor_chat', 'ai_replies', 'webhook_tools']);
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

	it('tells a webhook tool and the booking endpoint only the verified sign-in, never what the visitor typed (SR-6-1)', async () => {
		const sys = await start(['visitor_chat', 'ai_replies', 'webhook_tools', 'book_slot']);
		await sys.paste('accounts');
		await sys.setting('book_slot', 'bookingUrl', `${TOOLS}/booking`);
		await sys.setting('book_slot', 'needsContact', false);
		await sys.list('booking_questions', [
			{ key: 'name', label: 'Name', type: 'text', required: true },
			{ key: 'email', label: 'Email', type: 'email', required: true },
		]);
		await sys.list('tools', [
			{ name: 'lookup', description: 'Looks up my data.', url: `${TOOLS}/lookup`, parameters: [], includeVisitor: true },
		]);
		sys.responders.set(`${TOOLS}/lookup`, () => ({ status: 200, body: { ok: true } }));
		sys.responders.set(`${TOOLS}/booking`, () => ({ status: 200, body: { booked: true } }));
		/** @param {string} sub @param {Record<string, unknown>} claims */
		const turn = async (sub, claims) => {
			const signIn = await sys.accounts.signIn({ websiteId: sys.websiteId, sub, name: 'Ann', ...claims });
			const user = sys.visitor({ signIn });
			// the visitor types somebody else's details; Chat keeps them on the conversation, as the staff see them
			const saved = await user('POST', '/v1/chat/contact', {
				email: 'victim@example.com',
				phone: '+447700900123',
				name: 'Victim',
			});
			expect(saved.status).toBeLessThan(300);
			sys.calls.length = 0;
			sys.ai(
				{ tools: [{ name: 'lookup', arguments: {} }] },
				{ tools: [{ name: 'book_slot', arguments: { slotId: 's1', name: 'Ann' } }] },
				{ text: 'Done.' },
			);
			await user('POST', '/v1/chat/messages', { text: 'look me up and book me' });
			const lookup = sys.calls.find((c) => c.url === `${TOOLS}/lookup`);
			const booking = sys.calls.find((c) => c.url === `${TOOLS}/booking`);
			return { lookup: JSON.parse(String(lookup?.body)), booking: booking ? JSON.parse(String(booking.body)) : null };
		};
		// the sign-in says the email and the phone are verified: those, not the typed ones
		const verified = await turn('usr_a', {
			email: 'ann@example.com',
			email_verified: true,
			phone: '+447700900999',
			phone_verified: true,
		});
		expect(verified.lookup.visitor).toEqual({
			id: 'usr_a',
			name: 'Ann',
			email: 'ann@example.com',
			phone: '+447700900999',
		});
		expect(verified.booking.answers).toEqual({ name: 'Ann', email: 'ann@example.com' });
		// the sign-in does not say they are verified: the id only, and the booking asks for the email
		const unverified = await turn('usr_b', { email: 'bea@example.com', email_verified: false });
		expect(unverified.lookup.visitor).toEqual({ id: 'usr_b', name: 'Ann' });
		expect(unverified.booking).toBeNull();
		// nothing the visitor typed went to the merchant's endpoints
		for (const sent of [verified.lookup, verified.booking, unverified.lookup])
			expect(JSON.stringify(sent)).not.toMatch(/victim|900123/);
	});

	it('lists free slots and books one through the booking endpoint; the escalate tool hands off', async () => {
		const sys = await start(['visitor_chat', 'ai_replies', 'book_slot', 'inbox', 'handoff']);
		await sys.setting('book_slot', 'bookingUrl', `${TOOLS}/booking`);
		sys.responders.set(`${TOOLS}/booking`, (call) =>
			JSON.parse(call.body).action === 'list_slots'
				? { status: 200, body: { slots: [{ id: 's1', start: '2026-10-06T10:00:00Z' }] } }
				: { status: 200, body: { booked: true } },
		);
		sys.ai(
			{ tools: [{ name: 'list_free_slots', arguments: { from: '2026-10-01', to: '2027-01-01' } }] },
			{ tools: [{ name: 'book_slot', arguments: { slotId: 's1', name: 'Ann', phone: 'call me' } }] },
			{
				tools: [
					{ name: 'book_slot', arguments: { slotId: 's1', name: 'Ann', email: 'ann@example.com', phone: '07700 900123' } },
				],
			},
			{ text: 'Booked for Tuesday.' },
		);
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'Book me a slot' });
		const bodies = sys.calls.filter((c) => c.url === `${TOOLS}/booking`).map((c) => JSON.parse(c.body));
		expect(bodies[0]).toEqual({ action: 'list_slots', from: '2026-10-05', to: '2026-10-19', timeZone: 'UTC' });
		// a phone that cannot be one is asked for again; one typed nationally goes with the business country's code
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toEqual({
			action: 'book',
			slotId: 's1',
			// the seeded questions (C10)
			answers: { name: 'Ann', email: 'ann@example.com', phone: '+447700900123' },
			conversationId: expect.any(String),
		});
		sys.ai({ tools: [{ name: 'escalate_to_human', arguments: { reason: 'angry' } }] }, { text: 'Connecting you.' });
		await v('POST', '/v1/chat/messages', { text: 'This is useless' });
		const state = await v('GET', '/v1/chat');
		expect(state.json.conversation.waiting).toBe(true);
		expect(state.json.messages.map((/** @type {any} */ m) => m.text)).toContain('Connecting you.');
	});

	it('asks the merchant’s own booking questions and the service (C10)', async () => {
		const sys = await start(['visitor_chat', 'ai_replies', 'book_slot']);
		await sys.setting('book_slot', 'bookingUrl', `${TOOLS}/booking`);
		await sys.setting('book_slot', 'needsContact', false);
		await sys.list('booking_questions', [
			{ key: 'name', label: 'Name', type: 'text', required: true },
			{ key: 'guests', label: 'Number of guests', type: 'number', required: true },
			{ key: 'seating', label: 'Seating', type: 'choice', required: false, options: ['Inside', 'Terrace'] },
		]);
		await sys.list('booking_services', [
			{ key: 'dinner', name: 'Dinner', description: 'From 18:00' },
			{ key: 'lunch', name: 'Lunch', description: '' },
		]);
		sys.responders.set(`${TOOLS}/booking`, (call) =>
			JSON.parse(call.body).action === 'list_slots'
				? { status: 200, body: { slots: [{ id: 's9', start: '2026-10-06T18:00:00Z' }] } }
				: { status: 200, body: { booked: true, reference: 'R-1' } },
		);
		const v = sys.visitor();
		sys.ai(
			{ tools: [{ name: 'list_free_slots', arguments: { from: '2026-10-06', to: '2026-10-06' } }] },
			{ tools: [{ name: 'list_free_slots', arguments: { from: '2026-10-06', to: '2026-10-06', service: 'dinner' } }] },
			{ text: 'Dinner at 18:00 is free. How many guests?' },
		);
		await v('POST', '/v1/chat/messages', { text: 'A table for dinner tomorrow' });
		sys.ai(
			{ tools: [{ name: 'book_slot', arguments: { slotId: 's9', name: 'Ann', service: 'dinner' } }] },
			{
				tools: [
					{
						name: 'book_slot',
						arguments: { slotId: 's9', name: 'Ann', guests: '4', seating: 'Terrace', service: 'dinner' },
					},
				],
			},
			{ text: 'Booked: dinner for 4.' },
		);
		await v('POST', '/v1/chat/messages', { text: 'Four of us, on the terrace, I am Ann' });
		// the questions and the services are the tools' parameters
		const offered = sys.aiCalls()[0].tools.map((/** @type {any} */ t) => t.function ?? t);
		const book = offered.find((/** @type {any} */ t) => t.name === 'book_slot');
		expect(book.parameters.required).toEqual(['slotId', 'name', 'guests', 'service']);
		expect(book.parameters.properties.service.enum).toEqual(['dinner', 'lunch']);
		// no service: asked for; a missing required answer: asked for, never sent
		const results = sys
			.aiCalls()
			.flatMap((/** @type {any} */ body) => body.messages.filter((/** @type {any} */ m) => m.role === 'tool'));
		const said = results.map((/** @type {any} */ m) => String(m.content));
		expect(said.some((text) => text.includes('Ask the visitor for the service'))).toBe(true);
		expect(said.some((text) => text.includes('Ask the visitor for “Number of guests”'))).toBe(true);
		const bodies = sys.calls.filter((c) => c.url === `${TOOLS}/booking`).map((c) => JSON.parse(c.body));
		expect(bodies).toEqual([
			{ action: 'list_slots', from: '2026-10-06', to: '2026-10-06', timeZone: 'UTC', service: 'dinner' },
			{
				action: 'book',
				slotId: 's9',
				service: 'dinner',
				answers: { name: 'Ann', guests: 4, seating: 'Terrace' },
				conversationId: expect.any(String),
			},
		]);
	});

	it('locks the answer language and retries once; moderation drops a leaking answer', async () => {
		const sys = await start(['visitor_chat', 'ai_replies', 'moderation']);
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
