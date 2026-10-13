/**
 * PLAN 0.8.10 Chat, fixes after the re-audit (CH-*): `?wait=1` lets a slow answer finish after the response and a
 * reply that went stale starts again (CH-1, RT-6); the language lock's new options (CH-16 to CH-19, CH-38); shared
 * networks and new guests (CH-14, CH-15).
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

describe('the language lock (CH-2, CH-16 to CH-19, CH-38)', () => {
	it('answers a message in another script in that language or in Latin letters; the default language stays', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'language_lock']);
		await sys.setting('language_lock', 'allowedLanguages', ['ur', 'en']);
		await sys.setting('language_lock', 'defaultLanguage', 'en');
		await sys.setting('language_lock', 'acceptLatinFor', ['ur']);
		await sys.setting('language_lock', 'markerWords', ['ur: hai kya ye kitne ka bhai ji haan']);
		sys.ai({ text: 'Ji, ye Rs 12,500 ka hai.' });
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'یہ پنکھا کتنے کا ہے؟' });
		expect(sys.aiCalls()).toHaveLength(1);
		expect(sys.aiCalls()[0].messages[0].content).toContain(
			'Answer only in Urdu (ur), whatever language the knowledge is in. Urdu (Latin) (ur-Latn) is fine too.',
		);
		expect(texts((await v('GET', '/v1/chat')).json).at(-1)).toEqual(['ai', 'Ji, ye Rs 12,500 ka hai.']);
		sys.ai({ text: 'Yes, it is in stock.' });
		await v('POST', '/v1/chat/messages', { text: 'Is this fan in stock?' });
		expect(sys.aiCalls().at(-1).messages[0].content).toContain('Answer only in English (en)');
	});

	it('a reply still in the wrong language gets the unavailable message in the visitor’s language, no handoff', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'ai_replies', 'language_lock', 'inbox', 'handoff']);
		await sys.setting('language_lock', 'markerWords', ['ur-Latn: hai kya ye kitne ka bhai']);
		await sys.setting('language_lock', 'checkMode', 'presence');
		await sys.setting('language_lock', 'unavailableTexts', ['ur-Latn: Maazrat, abhi jawab nahi de sakta.']);
		sys.ai({ text: 'It costs Rs 12,500.' }, { text: 'The price is Rs 12,500.' });
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'bhai ye kitne ka hai' });
		let state = (await v('GET', '/v1/chat')).json;
		expect(texts(state).at(-1)).toEqual(['system', 'Maazrat, abhi jawab nahi de sakta.']);
		expect(state.conversation.waiting).toBe(false);
		// two failures in a row (the handoff setting) still hand off
		sys.ai({ text: 'It costs Rs 12,500.' }, { text: 'Rs 12,500, in stock.' });
		await v('POST', '/v1/chat/messages', { text: 'kya ye hai bhai' });
		state = (await v('GET', '/v1/chat')).json;
		expect(state.conversation.waiting).toBe(true);
	});
});

describe('shared networks and guests without their key (CH-14, CH-15)', () => {
	it('the network limit counts guests only; a signed-in visitor keeps answers on a busy network', async () => {
		const sys = await start(['visitor_chat', 'guest_chat', 'signed_in_chat', 'ai_replies']);
		await sys.paste('accounts');
		await sys.setting('ai_replies', 'repliesPerNetworkPerDay', 1);
		await sys.setting('ai_replies', 'onFailure', 'message');
		const network = '198.51.100.7';
		sys.ai({ text: 'Hello guest.' }, { text: 'Hello Ann.' });
		await sys.visitor({ network })('POST', '/v1/chat/messages', { text: 'hi' });
		const other = sys.visitor({ network });
		await other('POST', '/v1/chat/messages', { text: 'hi too' });
		expect(texts((await other('GET', '/v1/chat')).json).at(-1)).toEqual(['system', 'Sorry, I cannot answer right now.']);
		const signIn = await sys.accounts.signIn({ websiteId: sys.websiteId, sub: 'usr_ann', name: 'Ann' });
		const ann = sys.visitor({ signIn, network });
		await ann('POST', '/v1/chat/messages', { text: 'hello' });
		expect(texts((await ann('GET', '/v1/chat')).json).at(-1)).toEqual(['ai', 'Hello Ann.']);
	});

	it('at most 5 new guests per network address in 15 minutes; 0 lifts the limit', async () => {
		const sys = await start(['visitor_chat', 'guest_chat']);
		const network = '198.51.100.8';
		const send = () => sys.visitor({ network })('POST', '/v1/chat/messages', { text: 'hi' });
		const kept = sys.visitor({ network });
		expect((await kept('POST', '/v1/chat/messages', { text: 'hi' })).status).toBe(201);
		for (let i = 0; i < 4; i += 1) expect((await send()).status).toBe(201);
		const refused = await send();
		expect(refused.status).toBe(429);
		expect(refused.json.type).toMatch(/rate_limited$/);
		// a guest that keeps its key goes on; another network is not affected; 15 minutes later new guests start again
		expect((await kept('POST', '/v1/chat/messages', { text: 'again' })).status).toBe(201);
		expect((await sys.visitor({ network: '198.51.100.9' })('POST', '/v1/chat/messages', { text: 'hi' })).status).toBe(201);
		sys.advance(15 * 60_000);
		expect((await send()).status).toBe(201);
		await sys.setting('guest_chat', 'newGuestsPerNetwork', 0);
		for (let i = 0; i < 6; i += 1) expect((await send()).status).toBe(201);
	});
});
