/**
 * PLAN 0.8.10 Chat, fixes after the re-audit (CH-*): `?wait=1` lets a slow answer finish after the response and a
 * reply that went stale starts again (CH-1, RT-6).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { AI, AI_KEY, ORIGIN, ready } from './helpers.js';

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
/** @param {any} json */
const texts = (json) => json.messages.map((/** @type {any} */ m) => [m.author, m.text]);

/**
 * The fake AI's completions from now on: the first takes `slowMs` of the clock, the later ones wait until `open()`.
 * @param {Awaited<ReturnType<typeof ready>>} sys
 * @param {number} slowMs
 */
const slowAi = (sys, slowMs) => {
	const base = /** @type {(call: any) => any} */ (sys.responders.get(AI));
	/** @type {(value?: unknown) => void} */
	let open = () => undefined;
	const gate = new Promise((resolve) => {
		open = resolve;
	});
	let calls = 0;
	sys.responders.set(AI, async (call) => {
		if (call.method === 'POST') {
			calls += 1;
			if (calls === 1) sys.advance(slowMs);
			else await gate;
		}
		return base(call);
	});
	return { open: () => open() };
};

/**
 * Change a conversation in the merchant database (what a cut-off function leaves behind).
 * @param {Awaited<ReturnType<typeof ready>>} sys
 * @param {Record<string, unknown>} set
 */
const leave = async (sys, set) => {
	const data = await sys.product.data.forWebsite(sys.websiteId);
	await data.collection('conversations').updateMany({ websiteId: sys.websiteId }, { $set: set });
};

describe('the AI reply in the same request, and replies that went stale (CH-1, RT-6)', () => {
	it('?wait=1 answers at the wait limit with the reply pending; the reply finishes after the response', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'typing_receipts', 'inbox', 'handoff']);
		await sys.setting('ai_replies', 'neverDisclose', true);
		const ai = slowAi(sys, 21_000);
		// the first answer takes 21 s and says it is a bot: the retry would start after the 20 s wait
		sys.ai({ text: 'I am a bot.' }, { text: 'We ship in two days.' });
		const sent = await sys.call('POST', '/v1/chat/messages?wait=1', {
			token: sys.browser,
			origin: ORIGIN,
			body: { text: 'When do you ship?' },
			after: false,
		});
		expect(sent.status).toBe(201);
		expect(sent.json).toMatchObject({ replies: [], replyPending: true, chat: { conversation: { aiPending: true } } });
		ai.open();
		await sys.flush();
		const v = sys.visitor({ guestKey: sent.json.guestKey });
		const state = await v('GET', '/v1/chat');
		expect(texts(state.json)).toEqual([
			['visitor', 'When do you ship?'],
			['ai', 'We ship in two days.'],
		]);
		// no "cannot answer" message and no handoff
		expect(state.json.conversation).toMatchObject({ aiPending: false, waiting: false });
		// a quick answer still comes within the request
		sys.ai({ text: 'Yes.' });
		const quick = await v('POST', '/v1/chat/messages?wait=1', { text: 'Free delivery?' });
		expect(quick.json.replies.map((/** @type {any} */ m) => m.text)).toEqual(['Yes.']);
		expect(quick.json.replyPending).toBe(false);
	});

	it('a reply cut short shows no typing once stale, starts again once on the next check, then counts as failed', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'typing_receipts']);
		await sys.setting('ai_replies', 'onFailure', 'message');
		const v = sys.visitor();
		sys.ai({ text: 'Hello there.' });
		await v('POST', '/v1/chat/messages', { text: 'hi' });
		// the function stopped while the next reply was being written
		await leave(sys, { aiPending: true, aiPendingSince: new Date(sys.now()), aiRetried: false });
		sys.advance(60_000);
		expect((await v('GET', '/v1/chat')).json.conversation.aiPending).toBe(true);
		sys.advance(61_000);
		const contact = await v('POST', '/v1/chat/contact', { email: 'ann@example.com' });
		expect(contact.json.chat.conversation.aiPending).toBe(false);
		const calls = sys.aiCalls().length;
		sys.ai({ text: 'Here is the answer.' });
		const retried = await v('GET', '/v1/chat?after=0');
		expect(retried.json.conversation.aiPending).toBe(true);
		expect(sys.aiCalls()).toHaveLength(calls + 1);
		const state = await v('GET', '/v1/chat');
		expect(texts(state.json).at(-1)).toEqual(['ai', 'Here is the answer.']);
		expect(state.json.conversation.aiPending).toBe(false);
		// stale again after its retry: the on-failure message, no new AI call
		await leave(sys, { aiPending: true, aiPendingSince: new Date(sys.now()), aiRetried: true });
		sys.advance(121_000);
		await v('GET', '/v1/chat');
		const after = await v('GET', '/v1/chat');
		expect(texts(after.json).at(-1)).toEqual(['system', 'Sorry, I cannot answer right now.']);
		expect(after.json.conversation.aiPending).toBe(false);
		expect(sys.aiCalls()).toHaveLength(calls + 1);
	});
});
