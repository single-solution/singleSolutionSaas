// @vitest-environment jsdom
/* global document, window */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUEST_HEADER, GUEST_STORAGE_KEY, PROACTIVE_STORAGE_KEY, SIGN_IN_HEADER, WIDGET_GLOBAL } from '../core/widgets.js';
import { startWidget } from '../ui/widget.js';
import {
	BASE,
	START,
	TEXTS,
	answer,
	buttonIn,
	checkIn,
	choose,
	click,
	clock,
	configOf,
	fieldIn,
	flush,
	problem,
	resetPage,
	script,
	serve,
	setHiddenTab,
	shadow,
	shows,
	submit,
	textsIn,
} from './ui-helpers.js';

beforeEach(resetPage);
afterEach(() => {
	resetPage();
	window.history.replaceState(null, '', '/');
});

const AT = new Date(START).toISOString();
/** @param {Record<string, unknown>} [over] */
const conv = (over = {}) => ({
	id: 'c1',
	status: 'open',
	waiting: false,
	unread: 0,
	aiPending: false,
	staffSeenSeq: null,
	queuePosition: null,
	officeHours: null,
	rating: null,
	ratingRequested: false,
	flow: null,
	contactNeeded: false,
	createdAt: AT,
	lastMessageAt: AT,
	...over,
});
/** @param {Record<string, unknown>} [over] */
const view = (over = {}) => ({
	conversation: conv(),
	visitor: { kind: 'guest', name: null, email: null },
	guestLimit: null,
	lastSeq: 0,
	...over,
});
/** @param {number} seq @param {string} author @param {string} text @param {Record<string, unknown>} [over] */
const msg = (seq, author, text, over = {}) => ({ id: `m${seq}`, seq, author, name: null, text, createdAt: AT, ...over });

const keepGuest = () =>
	window.localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify({ key: 'g1', expiresAt: START + 86_400_000 }));

/**
 * @param {{ features?: string[], settings?: Record<string, any>, routes?: Record<string, import('./ui-helpers.js').Route>,
 *   token?: string | null, path?: string }} [input]
 */
const start = async ({
	features = ['visitor_chat', 'guest_chat'],
	settings = {},
	routes = {},
	token = 'bt',
	path = '/products/phone',
} = {}) => {
	window.history.replaceState(null, '', path);
	document.title = 'Phone page';
	const time = clock();
	const server = serve({ 'GET /v1/widget/config': () => answer(200, configOf(features, settings)), ...routes });
	const api = startWidget({ window, script: script(token), ...time });
	await api.ready;
	await flush();
	const host = document.querySelector('[data-ss-chat="chat"]');
	const root = /** @type {ShadowRoot} */ (host ? shadow(host) : null);
	const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (root.querySelector(selector));
	const type = async (/** @type {string} */ text) => {
		const input = /** @type {HTMLTextAreaElement} */ ($('textarea'));
		input.value = text;
		input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
		await flush();
	};
	return { time, server, api, host, root, $, type };
};

describe('starting', () => {
	it('mounts nothing without a token, but offers the API', async () => {
		const { api, host } = await start({ token: null });
		expect(host).toBeNull();
		expect(/** @type {any} */ (window)[WIDGET_GLOBAL]).toBe(api);
		await api.open();
		await api.close();
		await api.identify('sig');
		api.setPage({ kind: 'nope' });
	});

	it('mounts nothing when the config is refused, chat is off or the page is hidden', async () => {
		const refused = await start({ routes: { 'GET /v1/widget/config': () => problem(403, 'product_unavailable') } });
		expect(refused.host).toBeNull();
		resetPage();
		expect((await start({ features: ['inbox'] })).host).toBeNull();
		resetPage();
		expect((await start({ settings: { look: { hideOnPages: ['/products/**'] } } })).host).toBeNull();
	});

	it('shows the launcher with the look settings and the welcome text', async () => {
		const { $, root, server } = await start({
			settings: {
				look: {
					launcherStyle: 'label',
					launcherPosition: 'bottom-left',
					windowStyle: 'side_panel',
					fullScreenOnMobile: false,
					botName: 'Bo',
					avatarUrl: 'https://cdn.test/a.png',
				},
				guests: { messageLimit: 5 },
			},
		});
		expect($('.chat').dataset.position).toBe('bottom-left');
		expect($('.chat').dataset.style).toBe('side_panel');
		expect($('.chat').hasAttribute('data-full')).toBe(false);
		expect($('.launcher').textContent).toBe(TEXTS['chat.launcher']);
		expect($('img.avatar').getAttribute('src')).toBe('https://cdn.test/a.png');
		expect($('.name').textContent).toBe('Bo');
		expect($('.welcome').textContent).toContain('up to 5 messages');
		expect($('.window').hidden).toBe(true);
		expect(server.all('GET /v1/chat/unread')).toHaveLength(0);
		await click($('.launcher'));
		expect($('.window').hidden).toBe(false);
		expect(server.all('GET /v1/chat')).toHaveLength(0);
		await click(buttonIn(root, TEXTS['chat.close']));
		expect($('.window').hidden).toBe(true);
	});
});

describe('talking', () => {
	it('sends a first message with the page, keeps the guest key and paces the AI reply', async () => {
		let polls = 0;
		const { $, root, server, time, api, type } = await start({
			features: ['visitor_chat', 'guest_chat', 'ai_replies', 'typing_receipts'],
			settings: { look: { botName: 'Bo' }, ai: { showLabel: true }, guests: { messageLimit: 0 } },
			routes: {
				'POST /v1/chat/messages': () =>
					answer(201, {
						message: msg(1, 'visitor', 'Hello'),
						guestKey: 'g-new',
						chat: view({ conversation: conv({ aiPending: true }) }),
					}),
				'GET /v1/chat': () => {
					polls += 1;
					return answer(
						200,
						polls === 1
							? { ...view({ conversation: conv({ aiPending: true }) }), messages: [] }
							: {
									...view({ conversation: conv({ staffSeenSeq: 1 }) }),
									messages: [msg(2, 'ai', 'Hi there'), msg(3, 'staff', 'Ana here', { name: 'Ana' })],
								},
					);
				},
				'POST /v1/chat/read': () => answer(204),
			},
		});
		api.setPage({ kind: 'product', productId: 'p1', productName: 'Phone X' });
		expect($('.welcome').textContent).toBe(TEXTS['chat.welcomeSignedIn']);
		await api.open();
		await type('   ');
		expect(server.all('POST /v1/chat/messages')).toHaveLength(0);
		await type('Hello');
		expect(server.last('POST /v1/chat/messages')?.body).toEqual({
			text: 'Hello',
			page: {
				url: 'http://localhost:3000/products/phone',
				title: 'Phone page',
				kind: 'product',
				productId: 'p1',
				productName: 'Phone X',
			},
		});
		expect(JSON.parse(String(window.localStorage.getItem(GUEST_STORAGE_KEY))).key).toBe('g-new');
		expect(textsIn(root, '.msg.visitor p')).toEqual(['Hello']);
		expect($('.typing').hidden).toBe(false);
		await time.advance(3_000);
		expect(server.last('GET /v1/chat')?.url.search).toBe('?after=1');
		expect(server.last('GET /v1/chat')?.headers[GUEST_HEADER]).toBe('g-new');
		await time.advance(3_000);
		expect(textsIn(root, '.msg.ai:not(.welcome) p')).toEqual([]);
		expect($('.typing').hidden).toBe(false);
		await time.advance(1_200 + 80);
		expect(textsIn(root, '.msg.ai:not(.welcome) p')).toEqual(['Hi there']);
		expect(textsIn(root, '.msg.ai .who')).toEqual([`Bo ${TEXTS['chat.aiLabel']}`]);
		expect(textsIn(root, '.msg.staff .who')).toEqual(['Ana']);
		expect($('.typing').hidden).toBe(true);
		expect(textsIn(root, '.seen')).toEqual([TEXTS['chat.seen']]);
		expect(server.all('POST /v1/chat/read')).toHaveLength(1);
		await time.advance(10_000);
		expect(server.all('GET /v1/chat').length).toBe(3);
	});

	it('loads a returning guest, shows unread on the launcher and marks replies read', async () => {
		keepGuest();
		const seen = vi.fn();
		const { $, root, server, time, api } = await start({
			routes: {
				'GET /v1/chat/unread': () => answer(200, { unread: 2 }),
				'GET /v1/chat': () =>
					answer(200, {
						...view({ conversation: conv({ unread: 2 }) }),
						messages: [
							msg(1, 'visitor', 'Hi'),
							msg(2, 'staff', 'Hello', { name: null }),
							msg(3, 'system', 'Note', {
								attachment: { name: 'a.pdf', type: 'application/pdf', size: 3, url: 'https://files.test/a.pdf' },
							}),
						],
					}),
				'POST /v1/chat/read': () => answer(204),
			},
		});
		const off = api.onUnread(seen);
		expect($('.badge').textContent).toBe('2');
		expect(seen).toHaveBeenCalledWith(2, 'chat');
		await click($('.launcher'));
		expect(textsIn(root, '.msg.staff .who')).toEqual([TEXTS['chat.staff']]);
		expect(root.querySelector('a.file')?.getAttribute('download')).toBe('a.pdf');
		expect(server.all('POST /v1/chat/read')).toHaveLength(1);
		expect($('.badge').hidden).toBe(true);
		expect(seen).toHaveBeenLastCalledWith(0, 'chat');
		off();
		await click($('.launcher'));
		expect($('.window').hidden).toBe(true);
		await time.advance(5 * 60_000);
		expect(server.all('GET /v1/chat/unread')).toHaveLength(2);
		await api.open();
		expect(server.last('GET /v1/chat')?.url.search).toBe('?after=3');
		await api.close();
	});

	it('does not mark read while the tab is hidden', async () => {
		keepGuest();
		const { server, api } = await start({
			routes: {
				'GET /v1/chat/unread': () => answer(200, { unread: 1 }),
				'GET /v1/chat': () =>
					answer(200, { ...view({ conversation: conv({ unread: 1 }) }), messages: [msg(1, 'staff', 'Hey')] }),
			},
		});
		setHiddenTab(true);
		await api.open();
		expect(server.all('POST /v1/chat/read')).toHaveLength(0);
	});

	it('handles refused messages', async () => {
		let next = problem(422, 'message_rejected');
		const { $, type } = await start({ routes: { 'POST /v1/chat/messages': () => next } });
		await click($('.launcher'));
		await type('bad');
		expect($('.window > .status').textContent).toBe(TEXTS['chat.rejected']);
		next = problem(429, 'rate_limited');
		await type('fast');
		expect($('.window > .status').textContent).toBe(TEXTS['chat.rateLimited']);
		next = problem(500, 'boom');
		await type('x');
		expect($('.window > .status').textContent).toBe(TEXTS['chat.error']);
		expect(/** @type {HTMLTextAreaElement} */ ($('textarea')).value).toBe('x');
	});

	it('stops when the product is stopped', async () => {
		const { $, root, type } = await start({ routes: { 'POST /v1/chat/messages': () => problem(403, 'product_unavailable') } });
		await click($('.launcher'));
		await type('Hi');
		expect(root.textContent).toContain(TEXTS['chat.unavailable']);
		expect($('.composer').hidden).toBe(true);
		await click($('.launcher'));
		expect($('.chat').hidden).toBe(true);
		await click($('.launcher'));
		expect($('.window').hidden).toBe(true);
	});

	it('hides the launcher when the product stops while closed', async () => {
		keepGuest();
		const { $ } = await start({ routes: { 'GET /v1/chat/unread': () => problem(403, 'product_unavailable') } });
		expect($('.chat').hidden).toBe(true);
	});
});

describe('guest limit', () => {
	it('links to sign-in with a return to this page', async () => {
		const { $, root, type } = await start({
			features: ['visitor_chat', 'guest_chat', 'signed_in_chat'],
			settings: { signInUrl: '/sign-in?from=chat' },
			routes: { 'POST /v1/chat/messages': () => problem(403, 'guest_limit_reached', { next: 'sign_in' }) },
		});
		await click($('.launcher'));
		await type('Hi');
		const link = /** @type {HTMLAnchorElement} */ (root.querySelector('.slot a'));
		expect(link.textContent).toBe(TEXTS['chat.signInToContinue']);
		const url = new URL(link.href);
		expect(url.pathname).toBe('/sign-in');
		expect(url.searchParams.get('from')).toBe('chat');
		expect(url.searchParams.get('returnTo')).toBe('http://localhost:3000/products/phone');
		expect($('.composer').hidden).toBe(true);
	});

	it('asks for a sign-in without a link when there is no sign-in page', async () => {
		const { $, type } = await start({ routes: { 'POST /v1/chat/messages': () => problem(403, 'sign_in_required') } });
		await click($('.launcher'));
		await type('Hi');
		expect($('.slot').textContent).toBe(TEXTS['chat.signInToContinue']);
	});

	it('offers the lead form with custom fields and consent', async () => {
		let lead = problem(422, 'validation_failed', { errors: [{ message: 'Bad e-mail' }] });
		const { $, root, server, type } = await start({
			features: ['visitor_chat', 'guest_chat', 'leads_flows', 'custom_fields'],
			settings: {
				leads: { fields: ['name', 'email', 'message', 'other'], customFields: ['size', 'gift'], consentText: 'I agree' },
				customFields: [
					{ key: 'size', label: 'Size', type: 'number', options: [] },
					{ key: 'gift', label: 'Gift', type: 'yes_no', options: [] },
					{ key: 'skip', label: 'Skip', type: 'text', options: [] },
				],
			},
			routes: {
				'POST /v1/chat/messages': () => problem(403, 'guest_limit_reached', { next: 'weird' }),
				'POST /v1/chat/leads': () => lead,
			},
		});
		await click($('.launcher'));
		await type('Hi');
		expect(root.textContent).toContain(TEXTS['chat.leaveContact']);
		fieldIn(root, TEXTS['chat.name']).value = 'Ana';
		fieldIn(root, TEXTS['chat.email']).value = 'ana@x';
		fieldIn(root, 'Size').value = '42';
		fieldIn(root, 'Gift').value = 'true';
		const form = /** @type {HTMLElement} */ ($('.slot form'));
		await submit(form);
		expect($('.slot .status').textContent).toBe(TEXTS['chat.consentNeeded']);
		checkIn(root, 'I agree').checked = true;
		await submit(form);
		expect($('.slot .status').textContent).toBe('Bad e-mail');
		expect(server.last('POST /v1/chat/leads')?.body).toEqual({
			fields: { name: 'Ana', email: 'ana@x', size: 42, gift: true },
			consent: true,
		});
		lead = answer(201, { lead: { id: 'l1' } });
		await submit(form);
		expect($('.slot').textContent).toBe(TEXTS['chat.leadThanks']);
	});

	it('shows the limit from the chat itself', async () => {
		keepGuest();
		const { $ } = await start({
			routes: { 'GET /v1/chat': () => answer(200, { ...view({ guestLimit: { limit: 5, used: 5 } }), messages: [] }) },
		});
		await click($('.launcher'));
		expect($('.slot').textContent).toBe(TEXTS['chat.limitReached']);
	});
});

describe('contact', () => {
	it('asks guests before their first message and sends it after', async () => {
		const { $, root, server, type } = await start({
			settings: { guests: { contactCapture: 'before_first', messageLimit: 3 } },
			routes: {
				'POST /v1/chat/messages': () => answer(201, { message: msg(1, 'visitor', 'Hi'), guestKey: 'g1', chat: view() }),
				'POST /v1/chat/contact': () => answer(200, { chat: view() }),
			},
		});
		await click($('.launcher'));
		expect($('.composer').hidden).toBe(true);
		const form = /** @type {HTMLElement} */ ($('.slot form'));
		fieldIn(root, TEXTS['chat.name']).value = 'Ana';
		await submit(form);
		expect($('.slot .status').textContent).toBe(TEXTS['chat.contactMissing']);
		fieldIn(root, TEXTS['chat.phone']).value = '123';
		await submit(form);
		expect($('.composer').hidden).toBe(false);
		await type('Hi');
		expect(server.last('POST /v1/chat/contact')?.body).toEqual({ name: 'Ana', phone: '123' });
		expect(server.calls.map((c) => c.path).slice(-2)).toEqual(['/v1/chat/messages', '/v1/chat/contact']);
	});

	it('asks when the conversation needs a contact', async () => {
		keepGuest();
		let saved = problem(500, 'boom');
		const { $, root } = await start({
			routes: {
				'GET /v1/chat': () => answer(200, { ...view({ conversation: conv({ contactNeeded: true }) }), messages: [] }),
				'POST /v1/chat/contact': () => saved,
			},
		});
		await click($('.launcher'));
		expect($('.composer').hidden).toBe(false);
		fieldIn(root, TEXTS['chat.name']).value = 'Ana';
		fieldIn(root, TEXTS['chat.email']).value = 'a@b.co';
		await submit($('.slot form'));
		expect($('.slot .status').textContent).toBe(TEXTS['chat.error']);
		saved = answer(200, { chat: view() });
		await submit($('.slot form'));
		expect($('.slot').textContent).toBe('');
	});
});

describe('flows', () => {
	it('starts the page flow on open and walks its steps', async () => {
		/** @type {any[]} */
		const steps = [
			{ kind: 'question', buttons: ['Phones', 'Other'] },
			{ kind: 'collect', field: 'email', type: 'email', options: [] },
			{ kind: 'collect', field: 'gift', type: 'yes_no', options: [] },
			{ kind: 'collect', field: 'size', type: 'choice', options: ['S', 'M'] },
			{ kind: 'collect', field: 'note', type: 'text', options: [] },
		];
		let at = 0;
		let invalid = true;
		const chatAt = () => view({ conversation: conv({ flow: steps[at] ? { id: 'f1', step: steps[at] } : null }) });
		const { $, root, server, time } = await start({
			features: ['visitor_chat', 'guest_chat', 'leads_flows', 'custom_fields'],
			settings: {
				flows: [{ id: 'f1', name: 'Phones', start: { kind: 'page', path: '/products/*', delay: 0 } }],
				customFields: [{ key: 'gift', label: 'Gift wrap', type: 'yes_no', options: [] }],
			},
			routes: {
				'POST /v1/chat/flows/f1/start': () => answer(201, { guestKey: 'g1', chat: chatAt() }),
				'GET /v1/chat': () => answer(200, { ...chatAt(), messages: at === 0 ? [msg(1, 'ai', 'Which one?')] : [] }),
				'POST /v1/chat/flow': (call) => {
					if (call.body.answer === 'bad@' && invalid) {
						invalid = false;
						return problem(422, 'validation_failed', { errors: [{ message: 'Not an e-mail' }] });
					}
					if (call.body.answer === 'bad@') return problem(422, 'other');
					at += 1;
					return answer(200, { chat: chatAt() });
				},
			},
		});
		await click($('.launcher'));
		expect(server.last('POST /v1/chat/flows/f1/start')?.body.page.url).toBe('http://localhost:3000/products/phone');
		await time.advance(1_000);
		expect(textsIn(root, '.msg.ai:not(.welcome) p')).toEqual(['Which one?']);
		await click(buttonIn(root, 'Phones'));
		expect(server.last('POST /v1/chat/flow')?.body).toEqual({ answer: 'Phones' });
		const email = fieldIn(root, TEXTS['chat.email']);
		expect(email.type).toBe('email');
		email.value = 'bad@';
		await submit(email);
		expect($('.slot .status').textContent).toBe('Not an e-mail');
		await submit(email);
		expect($('.slot .status').textContent).toBe(TEXTS['chat.flowInvalid']);
		email.value = 'a@b.co';
		await submit(email);
		await click(buttonIn(root, TEXTS['common.yes']));
		await click(buttonIn(root, 'M'));
		fieldIn(root, TEXTS['chat.answer']).value = 'Thanks';
		await submit(fieldIn(root, TEXTS['chat.answer']));
		expect($('.slot').textContent).toBe('');
		await click($('.launcher'));
		await click($('.launcher'));
		expect(server.all('POST /v1/chat/flows/f1/start')).toHaveLength(1);
	});

	it('starts a delayed page flow like a proactive message', async () => {
		const { $, root, server, time } = await start({
			features: ['visitor_chat', 'guest_chat', 'leads_flows'],
			settings: { flows: [{ id: 'f2', name: 'Hi', start: { kind: 'page', path: '/products/**', delay: 30 } }] },
			routes: {
				'POST /v1/chat/flows/f2/start': () => answer(201, { guestKey: 'g1', chat: view() }),
				'GET /v1/chat': () => answer(200, { ...view(), messages: [msg(1, 'ai', 'Need a phone?')] }),
				'GET /v1/chat/unread': () => answer(200, { unread: 1 }),
			},
		});
		await time.advance(30_000);
		expect(server.all('POST /v1/chat/flows/f2/start')).toHaveLength(1);
		expect($('.nudge').hidden).toBe(false);
		expect($('.nudge').textContent).toContain('Need a phone?');
		expect($('.badge').textContent).toBe('1');
		await click(/** @type {HTMLElement} */ ($('.nudge .link')));
		expect($('.window').hidden).toBe(false);
		expect($('.nudge').hidden).toBe(true);
		expect(textsIn(root, '.msg.ai:not(.welcome) p')).toEqual(['Need a phone?']);
	});

	it('does not start a delayed flow that already ran or failed', async () => {
		window.sessionStorage.setItem(PROACTIVE_STORAGE_KEY, JSON.stringify({ flows: ['f2'] }));
		const { server, time } = await start({
			features: ['visitor_chat', 'guest_chat', 'leads_flows'],
			settings: { flows: [{ id: 'f2', name: 'Hi', start: { kind: 'page', path: '/products/**', delay: 30 } }] },
		});
		await time.advance(30_000);
		expect(server.all('POST /v1/chat/flows/f2/start')).toHaveLength(0);
		resetPage();
		const failed = await start({
			features: ['visitor_chat', 'guest_chat', 'leads_flows'],
			settings: { flows: [{ id: 'f2', name: 'Hi', start: { kind: 'page', path: '/products/**', delay: 30 } }] },
			routes: { 'POST /v1/chat/flows/f2/start': () => problem(403, 'sign_in_required') },
		});
		await failed.time.advance(30_000);
		expect(failed.$('.nudge').hidden).toBe(true);
	});
});

describe('conversation tools', () => {
	it('hands off, shows the queue and office hours, sends a transcript and ends the chat', async () => {
		keepGuest();
		let current = conv();
		let transcript = problem(503, 'notifications_not_connected');
		const { $, root, server } = await start({
			features: ['visitor_chat', 'guest_chat', 'handoff', 'presence_queue', 'transcripts'],
			settings: { queuePosition: true },
			routes: {
				'GET /v1/chat': () => answer(200, { ...view({ conversation: current }), messages: [] }),
				'POST /v1/chat/handoff': () => {
					current = conv({ waiting: true, queuePosition: 2, officeHours: { open: false, backAt: '2026-10-02T09:00:00Z' } });
					return answer(200, { chat: view({ conversation: current }) });
				},
				'POST /v1/chat/transcript': () => transcript,
				'POST /v1/chat/end': () => {
					current = conv({ status: 'resolved', officeHours: { open: false, backAt: null } });
					return answer(200, { chat: view({ conversation: current }) });
				},
			},
		});
		await click($('.launcher'));
		expect(shows(root, TEXTS['chat.talkToPerson'])).toBe(true);
		await click(buttonIn(root, TEXTS['chat.talkToPerson']));
		expect(shows(root, TEXTS['chat.talkToPerson'])).toBe(false);
		expect(textsIn(root, '.notices p')[1]).toBe('You are number 2 in the queue.');
		expect(textsIn(root, '.notices p')[0]).toContain('Our team is away right now. They are back');
		await click(buttonIn(root, TEXTS['chat.transcript']));
		await submit(fieldIn(root, TEXTS['chat.email']));
		expect($('.slot .status').textContent).toBe(TEXTS['chat.transcriptUnavailable']);
		fieldIn(root, TEXTS['chat.email']).value = 'a@b.co';
		transcript = answer(202, { sent: true });
		await submit(fieldIn(root, TEXTS['chat.email']));
		expect(server.last('POST /v1/chat/transcript')?.body).toEqual({ email: 'a@b.co' });
		expect($('.window > .status').textContent).toBe(TEXTS['chat.transcriptSent']);
		await click(buttonIn(root, TEXTS['chat.transcript']));
		await click(buttonIn(root, TEXTS['chat.cancel']));
		expect($('.slot').textContent).toBe('');
		await click(buttonIn(root, TEXTS['chat.end']));
		expect(shows(root, TEXTS['chat.end'])).toBe(false);
		expect(textsIn(root, '.notices p')).toEqual([TEXTS['chat.officeAway']]);
	});

	it('says when handoff or end fail', async () => {
		keepGuest();
		const { $, root } = await start({
			features: ['visitor_chat', 'guest_chat', 'handoff'],
			routes: {
				'GET /v1/chat': () => answer(200, { ...view(), messages: [] }),
				'POST /v1/chat/handoff': () => problem(500, 'x'),
				'POST /v1/chat/end': () => problem(429, 'rate_limited'),
			},
		});
		await click($('.launcher'));
		await click(buttonIn(root, TEXTS['chat.talkToPerson']));
		expect($('.window > .status').textContent).toBe(TEXTS['chat.error']);
		await click(buttonIn(root, TEXTS['chat.end']));
		expect($('.window > .status').textContent).toBe(TEXTS['chat.rateLimited']);
	});

	it('asks for a thumbs rating when resolved', async () => {
		keepGuest();
		const { $, root, server } = await start({
			features: ['visitor_chat', 'guest_chat', 'ratings'],
			settings: { ratings: { scale: 2, askWhen: 'on_resolve', comment: false } },
			routes: {
				'GET /v1/chat': () => answer(200, { ...view({ conversation: conv({ status: 'resolved' }) }), messages: [] }),
				'POST /v1/chat/rating': () =>
					answer(200, { chat: view({ conversation: conv({ status: 'resolved', rating: { score: 2 } }) }) }),
			},
		});
		await click($('.launcher'));
		expect(root.textContent).toContain(TEXTS['chat.ratingAsk']);
		await click(buttonIn(root, TEXTS['chat.ratingUp']));
		expect(server.last('POST /v1/chat/rating')?.body).toEqual({ score: 2 });
		expect($('.slot').textContent).toBe('');
		expect($('.window > .status').textContent).toBe(TEXTS['chat.ratingThanks']);
	});

	it('asks for a rating with a comment after staff took part or on request', async () => {
		keepGuest();
		let rating = problem(500, 'x');
		const { $, root, server } = await start({
			features: ['visitor_chat', 'guest_chat', 'ratings'],
			settings: { ratings: { scale: 5, askWhen: 'after_staff', comment: true } },
			routes: {
				'GET /v1/chat': () =>
					answer(200, {
						...view({ conversation: conv({ status: 'resolved' }) }),
						messages: [msg(1, 'staff', 'Done', { name: 'Ana' })],
					}),
				'POST /v1/chat/rating': () => rating,
			},
		});
		await click($('.launcher'));
		await click(buttonIn(root, TEXTS['chat.ratingSend']));
		expect($('.slot .status').textContent).toBe(TEXTS['chat.ratingPick']);
		await click(buttonIn(root, '4'));
		expect(buttonIn(root, '4').getAttribute('aria-pressed')).toBe('true');
		fieldIn(root, TEXTS['chat.ratingComment']).value = 'Nice';
		await click(buttonIn(root, TEXTS['chat.ratingSend']));
		expect($('.slot .status').textContent).toBe(TEXTS['chat.error']);
		rating = answer(200, { chat: view() });
		await click(buttonIn(root, TEXTS['chat.ratingSend']));
		expect(server.last('POST /v1/chat/rating')?.body).toEqual({ score: 4, comment: 'Nice' });
	});

	it('asks for a rating when staff request it, never after_staff without staff', async () => {
		keepGuest();
		const { $, root } = await start({
			features: ['visitor_chat', 'guest_chat', 'ratings'],
			settings: { ratings: { scale: 3, askWhen: 'after_staff', comment: false } },
			routes: { 'GET /v1/chat': () => answer(200, { ...view({ conversation: conv({ status: 'resolved' }) }), messages: [] }) },
		});
		await click($('.launcher'));
		expect(root.textContent).not.toContain(TEXTS['chat.ratingAsk']);
		resetPage();
		keepGuest();
		const asked = await start({
			features: ['visitor_chat', 'guest_chat', 'ratings'],
			settings: { ratings: { scale: 3, askWhen: 'manual' } },
			routes: {
				'GET /v1/chat': () => answer(200, { ...view({ conversation: conv({ ratingRequested: true }) }), messages: [] }),
			},
		});
		await click(asked.$('.launcher'));
		expect(textsIn(asked.root, '.slot .choices button')).toEqual(['1', '2', '3']);
		expect($).toBeTruthy();
	});
});

describe('attachments', () => {
	const features = ['visitor_chat', 'guest_chat', 'signed_in_chat', 'attachments'];
	const settings = { attachments: { visitors: 'signed_in', types: ['image/png', 'image/svg+xml'], maxBytes: 0, storage: true } };

	it('lets signed-in visitors attach checked files', async () => {
		let uploads = () => problem(403, 'feature_off');
		let put = () => answer(500);
		const { $, root, server, api } = await start({
			features,
			settings,
			routes: {
				'GET /v1/chat': () =>
					answer(200, { ...view({ visitor: { kind: 'user', name: 'Ana', email: 'a@b.co' } }), messages: [] }),
				'POST /v1/chat/uploads': () => uploads(),
				'PUT /bucket/k1': () => put(),
				'POST /v1/chat/messages': (call) =>
					answer(201, {
						message: msg(1, 'visitor', call.body.text, {
							attachment: { name: 'a.png', type: 'image/png', size: 3, url: 'https://files.test/a.png' },
						}),
						chat: view(),
					}),
			},
		});
		expect($('.attach').hidden).toBe(true);
		await api.identify('sig');
		await api.open();
		expect(server.last('GET /v1/chat')?.headers[SIGN_IN_HEADER]).toBe('sig');
		expect($('.attach').hidden).toBe(false);
		const file = /** @type {HTMLInputElement} */ ($('input[type="file"]'));
		expect(file.getAttribute('accept')).toBe('image/png');
		const clicked = vi.spyOn(file, 'click').mockImplementation(() => {});
		await click($('.attach'));
		expect(clicked).toHaveBeenCalled();
		await choose(file, null);
		await choose(file, new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }));
		expect($('.window > .status').textContent).toBe(TEXTS['chat.fileType']);
		const big = new File(['x'], 'big.png', { type: 'image/png' });
		Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
		await choose(file, big);
		expect($('.window > .status').textContent).toBe('The file is too big (at most 10 MB).');
		const small = new File(['abc'], 'a.png', { type: 'image/png' });
		await choose(file, small);
		expect($('.window > .status').textContent).toBe(TEXTS['chat.error']);
		uploads = () =>
			answer(200, {
				upload: { method: 'PUT', url: `${BASE}/bucket/k1`, headers: { 'content-type': 'image/png', 'content-length': '3' } },
				attachment: { key: 'k1', name: 'a.png', type: 'image/png', size: 3 },
			});
		await choose(file, small);
		expect($('.window > .status').textContent).toBe(TEXTS['chat.uploadFailed']);
		put = () => answer(200);
		/** @type {HTMLTextAreaElement} */ ($('textarea')).value = 'See';
		await choose(file, small);
		expect(server.last('POST /v1/chat/uploads')?.body).toEqual({ name: 'a.png', type: 'image/png', size: 3 });
		expect(server.last('PUT /bucket/k1')?.headers).toEqual({ 'content-type': 'image/png', 'content-length': '3' });
		expect(server.last('POST /v1/chat/messages')?.body.attachment).toEqual({
			key: 'k1',
			name: 'a.png',
			type: 'image/png',
			size: 3,
		});
		expect(root.querySelector('.msg.visitor img')?.getAttribute('src')).toBe('https://files.test/a.png');
		expect(/** @type {HTMLTextAreaElement} */ ($('textarea')).value).toBe('');
	});

	it('prefills the transcript e-mail of a signed-in visitor and resets on sign-out', async () => {
		const { $, root, server, api } = await start({
			features: ['visitor_chat', 'signed_in_chat', 'transcripts'],
			routes: {
				'GET /v1/chat': (call) =>
					answer(200, {
						...view({
							visitor: call.headers[SIGN_IN_HEADER]
								? { kind: 'user', name: 'Ana', email: 'a@b.co' }
								: { kind: 'none', name: null, email: null },
						}),
						messages: [msg(1, 'visitor', 'Hi')],
					}),
				'GET /v1/chat/unread': () => answer(200, { unread: 0 }),
			},
		});
		await api.identify('sig');
		await api.open();
		await click(buttonIn(root, TEXTS['chat.transcript']));
		expect(fieldIn(root, TEXTS['chat.email']).value).toBe('a@b.co');
		await api.identify(null);
		expect(server.all('GET /v1/chat')).toHaveLength(1);
		await api.close();
		await api.identify('sig');
		expect(server.all('GET /v1/chat/unread')).toHaveLength(2);
		expect(textsIn(root, '.msg.visitor p')).toEqual([]);
		expect($('.welcome')).toBeTruthy();
	});
});

describe('proactive', () => {
	it('nudges after idle minutes, never while open, and remembers dismissals', async () => {
		const { $, time, api } = await start({
			features: ['visitor_chat', 'guest_chat', 'proactive_idle', 'proactive_pages'],
			settings: {
				proactive: {
					idleMinutes: 1,
					dismissDays: 3,
					pageRules: [{ path: '/products/**', delay: 120, message: 'Rule text' }],
				},
			},
		});
		await api.open();
		await time.advance(60_000);
		expect($('.nudge').hidden).toBe(true);
		await api.close();
		await time.advance(60_000);
		expect($('.nudge').hidden).toBe(false);
		expect($('.nudge').textContent).toContain(TEXTS['chat.idle']);
		await click(/** @type {HTMLElement} */ ($('.nudge .dismiss')));
		expect($('.nudge').hidden).toBe(true);
		expect(JSON.parse(String(window.localStorage.getItem(PROACTIVE_STORAGE_KEY))).dismissedUntil).toBe(
			time.time + 3 * 86_400_000,
		);
		await time.advance(120_000);
		expect($('.nudge').hidden).toBe(true);
	});
});
