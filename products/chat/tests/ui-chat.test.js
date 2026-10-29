// @vitest-environment jsdom
/* global document, window */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROACTIVE_DISMISS_DAYS } from '../core/limits.js';
import {
	CHECKS,
	GUEST_HEADER,
	GUEST_STORAGE_KEY,
	PROACTIVE_STORAGE_KEY,
	SIGN_IN_HEADER,
	WIDGET_GLOBAL,
} from '../core/widgets.js';
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
	guestMessagesLeft: null,
	lastSeq: 0,
	...over,
});
/** @param {number} seq @param {string} author @param {string} text @param {Record<string, unknown>} [over] */
const msg = (seq, author, text, over = {}) => ({ id: `m${seq}`, seq, author, name: null, text, createdAt: AT, ...over });

const signedIn = { kind: 'user', name: 'Ana', email: 'a@b.co' };

const keepGuest = () =>
	window.localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify({ key: 'g1', expiresAt: START + 86_400_000 }));

/**
 * @param {{ features?: string[], settings?: Record<string, any>, routes?: Record<string, import('./ui-helpers.js').Route>,
 *   token?: string | null, path?: string, look?: { format?: Record<string, unknown>, timeZone?: string },
 *   texts?: Record<string, string> }} [input]
 */
const start = async ({
	features = ['visitor_chat'],
	settings = {},
	routes = {},
	token = 'bt',
	path = '/products/lamp',
	look = {},
	texts = {},
} = {}) => {
	window.history.replaceState(null, '', path);
	document.title = 'Lamp page';
	const time = clock();
	const config = configOf(features, settings, look);
	const server = serve({
		'GET /v1/widget/config': () => answer(200, { ...config, texts: { ...config.texts, ...texts } }),
		...routes,
	});
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
					avatarUrl: 'https://cdn.test/a.png',
				},
				guests: { messageLimit: 5 },
			},
			// the bot's name is a widget text (C16)
			texts: { 'chat.botName': 'Bo' },
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
		// Escape closes the open window too, and focus goes back to the launcher
		await click($('.launcher'));
		expect($('.window').hidden).toBe(false);
		$('.window').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect($('.window').hidden).toBe(true);
		expect($('.launcher').getAttribute('aria-expanded')).toBe('false');
		expect(root.activeElement).toBe($('.launcher'));
	});
});

describe('talking', () => {
	it('sends a first message with the page, keeps the guest key and paces the AI reply', async () => {
		let polls = 0;
		const { $, root, server, time, api, type } = await start({
			features: ['visitor_chat', 'ai_replies'],
			settings: {
				ai: { showLabel: true },
				guests: { messageLimit: 0 },
				pageTypes: [{ key: 'product', name: 'Product page', path: '', nudge: '' }],
			},
			texts: { 'chat.botName': 'Bo' },
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
		api.setPage({ kind: 'product', productId: 'p1', productName: 'Desk lamp' });
		expect($('.welcome').textContent).toBe(TEXTS['chat.welcomeSignedIn']);
		await api.open();
		await type('   ');
		expect(server.all('POST /v1/chat/messages')).toHaveLength(0);
		await type('Hello');
		expect(server.last('POST /v1/chat/messages')?.body).toEqual({
			text: 'Hello',
			page: {
				url: 'http://localhost:3000/products/lamp',
				title: 'Lamp page',
				kind: 'product',
				productId: 'p1',
				productName: 'Desk lamp',
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

	it('checks at the fixed intervals: every 5 minutes while closed, every 10 seconds while open (C19)', async () => {
		keepGuest();
		const { $, server, time } = await start({
			routes: {
				'GET /v1/chat/unread': () => answer(200, { unread: 0 }),
				'GET /v1/chat': () => answer(200, { ...view(), messages: [msg(1, 'visitor', 'Hi')] }),
				'POST /v1/chat/read': () => answer(204),
			},
		});
		// closed: on load, then every 5 minutes
		expect(server.all('GET /v1/chat/unread')).toHaveLength(1);
		await time.advance(CHECKS.closedEveryMs * 2);
		expect(server.all('GET /v1/chat/unread')).toHaveLength(3);
		// open: every 10 s
		await click($('.launcher'));
		const opened = server.all('GET /v1/chat').length;
		await time.advance(CHECKS.activeMs * 3);
		expect(server.all('GET /v1/chat').length - opened).toBe(3);
		expect(server.all('GET /v1/chat/unread')).toHaveLength(3);
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
		// a refused value shows the widget's own text, never the server's English detail
		next = problem(422, 'validation_failed', { errors: [{ message: 'Write a message (up to 4000 characters).' }] });
		await type('long');
		expect($('.window > .status').textContent).toBe(TEXTS['chat.messageInvalid']);
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
			features: ['visitor_chat'],
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
		expect(url.searchParams.get('returnTo')).toBe('http://localhost:3000/products/lamp');
		expect($('.composer').hidden).toBe(true);
	});

	it('asks for a sign-in without a link when there is no sign-in page', async () => {
		const { $, type } = await start({ routes: { 'POST /v1/chat/messages': () => problem(403, 'sign_in_required') } });
		await click($('.launcher'));
		await type('Hi');
		expect($('.slot').textContent).toBe(TEXTS['chat.signInToContinue']);
	});

	it('offers the lead form with custom fields and consent', async () => {
		let lead = problem(422, 'validation_failed', { errors: [{ message: 'Bad email' }] });
		const { $, root, server, type } = await start({
			features: ['visitor_chat', 'leads_flows'],
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
		expect($('.slot .status').textContent).toBe(TEXTS['chat.leadInvalid']);
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
			routes: { 'GET /v1/chat': () => answer(200, { ...view({ guestMessagesLeft: 0 }), messages: [] }) },
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

describe('lead form outside office hours', () => {
	it('is offered to a guest who left no contact while no staff are in, once a session, the composer still open', async () => {
		keepGuest();
		const routes = {
			'GET /v1/chat': () => answer(200, { ...view({ leadOffered: true }), messages: [] }),
			'POST /v1/chat/leads': () => answer(201, { lead: { id: 'l1' } }),
		};
		const features = ['visitor_chat', 'leads_flows'];
		const settings = { leads: { fields: ['name', 'email'], customFields: [], consentText: '' } };
		const { $, root, server } = await start({ features, settings, routes });
		await click($('.launcher'));
		expect($('.slot').textContent).toContain(TEXTS['chat.leaveContact']);
		expect($('.composer').hidden).toBe(false);
		fieldIn(root, TEXTS['chat.name']).value = 'Ana';
		fieldIn(root, TEXTS['chat.email']).value = 'ana@x.co';
		await submit($('.slot form'));
		expect(server.last('POST /v1/chat/leads')?.body).toEqual({ fields: { name: 'Ana', email: 'ana@x.co' } });
		expect($('.slot').textContent).toBe('');
		expect(root.textContent).toContain(TEXTS['chat.leadThanks']);
		// the next page of the same session does not offer it again
		document.body.replaceChildren();
		const next = await start({ features, settings, routes });
		await click(next.$('.launcher'));
		expect(next.$('.slot').textContent).toBe('');
		// a website without lead capture never offers it
		resetPage();
		keepGuest();
		const off = await start({ routes });
		await click(off.$('.launcher'));
		expect(off.$('.slot').textContent).toBe('');
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
			features: ['visitor_chat', 'leads_flows'],
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
						return problem(422, 'validation_failed', { errors: [{ message: 'Not an email' }] });
					}
					if (call.body.answer === 'bad@') return problem(422, 'other');
					at += 1;
					return answer(200, { chat: chatAt() });
				},
			},
		});
		await click($('.launcher'));
		expect(server.last('POST /v1/chat/flows/f1/start')?.body.page.url).toBe('http://localhost:3000/products/lamp');
		await time.advance(1_000);
		expect(textsIn(root, '.msg.ai:not(.welcome) p')).toEqual(['Which one?']);
		await click(buttonIn(root, 'Phones'));
		expect(server.last('POST /v1/chat/flow')?.body).toEqual({ answer: 'Phones' });
		const email = fieldIn(root, TEXTS['chat.email']);
		expect(email.type).toBe('email');
		email.value = 'bad@';
		await submit(email);
		expect($('.slot .status').textContent).toBe(TEXTS['chat.flowInvalid']);
		await submit(email);
		expect($('.slot .status').textContent).toBe(TEXTS['chat.error']);
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
			features: ['visitor_chat', 'leads_flows'],
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
			features: ['visitor_chat', 'leads_flows'],
			settings: { flows: [{ id: 'f2', name: 'Hi', start: { kind: 'page', path: '/products/**', delay: 30 } }] },
		});
		await time.advance(30_000);
		expect(server.all('POST /v1/chat/flows/f2/start')).toHaveLength(0);
		resetPage();
		const failed = await start({
			features: ['visitor_chat', 'leads_flows'],
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
			features: ['visitor_chat', 'handoff'],
			routes: {
				'GET /v1/chat': () => answer(200, { ...view({ conversation: current, visitor: signedIn }), messages: [] }),
				'POST /v1/chat/handoff': () => {
					current = conv({ waiting: true, queuePosition: 2, officeHours: { open: false, backAt: '2026-10-02T09:00:00Z' } });
					return answer(200, { chat: view({ conversation: current, visitor: signedIn }) });
				},
				'POST /v1/chat/transcript': () => transcript,
				'POST /v1/chat/end': () => {
					current = conv({ status: 'resolved', officeHours: { open: false, backAt: null } });
					return answer(200, { chat: view({ conversation: current, visitor: signedIn }) });
				},
			},
		});
		await click($('.launcher'));
		expect(shows(root, TEXTS['chat.talkToPerson'])).toBe(true);
		await click(buttonIn(root, TEXTS['chat.talkToPerson']));
		expect(shows(root, TEXTS['chat.talkToPerson'])).toBe(false);
		expect(textsIn(root, '.notices p')[1]).toBe('You are number 2 in line.');
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

	it('offers no transcript to a guest, who has no verified email to send it to (SR-6-2)', async () => {
		keepGuest();
		const { $, root } = await start({
			features: ['visitor_chat'],
			routes: { 'GET /v1/chat': () => answer(200, { ...view({ conversation: conv() }), messages: [] }) },
		});
		await click($('.launcher'));
		expect(shows(root, TEXTS['chat.transcript'])).toBe(false);
	});

	it('says when handoff or end fail', async () => {
		keepGuest();
		const { $, root } = await start({
			features: ['visitor_chat', 'handoff'],
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

	it('offers Talk to a person only with the setting, and shows the paused notice when the API says so (C4, C9)', async () => {
		keepGuest();
		const { $, root } = await start({
			features: ['visitor_chat', 'handoff'],
			settings: { handoff: { showButton: false } },
			routes: { 'GET /v1/chat': () => answer(200, { ...view({ conversation: conv({ paused: true }) }), messages: [] }) },
		});
		await click($('.launcher'));
		expect(shows(root, TEXTS['chat.talkToPerson'])).toBe(false);
		expect(textsIn(root, '.notices p')).toEqual([TEXTS['chat.paused']]);
	});

	it('shows times with a divider for each day, and earlier messages on request (C8)', async () => {
		keepGuest();
		const day1 = '2026-09-30T08:15:00Z';
		const day2 = '2026-10-01T09:30:00Z';
		const { $, root, server } = await start({
			features: ['visitor_chat'],
			settings: { look: { showTimes: true } },
			look: { format: { locale: 'en-US', times: 'business' }, timeZone: 'UTC' },
			routes: {
				'GET /v1/chat': (call) =>
					call.url.searchParams.get('before') === '3'
						? answer(200, {
								...view(),
								messages: [msg(1, 'visitor', 'Hello?', { createdAt: day1 }), msg(2, 'ai', 'Hi!', { createdAt: day1 })],
								earlier: false,
							})
						: answer(200, { ...view(), messages: [msg(3, 'visitor', 'Still there?', { createdAt: day2 })], earlier: true }),
			},
		});
		await click($('.launcher'));
		expect(textsIn(root, '.day')).toEqual(['Oct 1, 2026']);
		expect(textsIn(root, '.msg time')).toEqual(['9:30 AM']);
		await click(buttonIn(root, TEXTS['chat.earlier']));
		expect(server.last('GET /v1/chat')?.url.search).toBe('?before=3&limit=50');
		expect(textsIn(root, '.log > li:not(.older):not(.welcome)').map((text) => text.replace(/\s+/g, ' '))).toEqual([
			'Sep 30, 2026',
			expect.stringContaining('Hello?'),
			expect.stringContaining('Hi!'),
			'Oct 1, 2026',
			expect.stringContaining('Still there?'),
		]);
		expect(shows(root, TEXTS['chat.earlier'])).toBe(false);
	});

	it('shows no times or dividers by default', async () => {
		keepGuest();
		const { $, root } = await start({
			routes: { 'GET /v1/chat': () => answer(200, { ...view(), messages: [msg(1, 'visitor', 'Hello?')], earlier: false }) },
		});
		await click($('.launcher'));
		expect(textsIn(root, '.day')).toEqual([]);
		expect(textsIn(root, '.msg time')).toEqual([]);
		expect(shows(root, TEXTS['chat.earlier'])).toBe(false);
	});

	it('asks for a thumbs rating when resolved', async () => {
		keepGuest();
		const { $, root, server } = await start({
			features: ['visitor_chat'],
			settings: { ratings: { kind: 'csat', labels: ['Bad', 'Good'], askWhen: 'on_resolve', comment: false } },
			routes: {
				'GET /v1/chat': () =>
					answer(200, { ...view({ conversation: conv({ status: 'resolved', ratingRequested: true }) }), messages: [] }),
				'POST /v1/chat/rating': () =>
					answer(200, { chat: view({ conversation: conv({ status: 'resolved', rating: { score: 2 } }) }) }),
			},
		});
		await click($('.launcher'));
		expect(root.textContent).toContain(TEXTS['chat.ratingAsk']);
		await click(buttonIn(root, 'Good'));
		expect(server.last('POST /v1/chat/rating')?.body).toEqual({ score: 2 });
		expect($('.slot').textContent).toBe('');
		expect($('.window > .status').textContent).toBe(TEXTS['chat.ratingThanks']);
	});

	it('asks for a rating with a comment after staff took part or on request', async () => {
		keepGuest();
		let rating = problem(500, 'x');
		const { $, root, server } = await start({
			features: ['visitor_chat'],
			settings: { ratings: { kind: 'csat', labels: ['1', '2', '3', '4', '5'], askWhen: 'after_staff', comment: true } },
			routes: {
				'GET /v1/chat': () =>
					answer(200, {
						...view({ conversation: conv({ status: 'resolved', ratingRequested: true }) }),
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
			features: ['visitor_chat'],
			settings: { ratings: { kind: 'csat', labels: ['1', '2', '3'], askWhen: 'after_staff', comment: false } },
			routes: { 'GET /v1/chat': () => answer(200, { ...view({ conversation: conv({ status: 'resolved' }) }), messages: [] }) },
		});
		await click($('.launcher'));
		expect(root.textContent).not.toContain(TEXTS['chat.ratingAsk']);
		resetPage();
		keepGuest();
		const asked = await start({
			features: ['visitor_chat'],
			settings: { ratings: { kind: 'csat', labels: ['1', '2', '3'], askWhen: 'manual' } },
			routes: {
				'GET /v1/chat': () => answer(200, { ...view({ conversation: conv({ ratingRequested: true }) }), messages: [] }),
			},
		});
		await click(asked.$('.launcher'));
		expect(textsIn(asked.root, '.slot .choices button')).toEqual(['1', '2', '3']);
		expect($).toBeTruthy();
	});

	it('asks the NPS question with 0 to 10 and its two ends (C13)', async () => {
		keepGuest();
		const { $, root, server } = await start({
			features: ['visitor_chat'],
			settings: { ratings: { kind: 'nps', labels: [], askWhen: 'on_resolve', comment: false } },
			routes: {
				'GET /v1/chat': () =>
					answer(200, { ...view({ conversation: conv({ status: 'resolved', ratingRequested: true }) }), messages: [] }),
				'POST /v1/chat/rating': () =>
					answer(200, { chat: view({ conversation: conv({ status: 'resolved', rating: { score: 0 } }) }) }),
			},
		});
		await click($('.launcher'));
		expect(root.textContent).toContain(TEXTS['chat.npsAsk']);
		expect(root.textContent).not.toContain(TEXTS['chat.ratingAsk']);
		expect(textsIn(root, '.slot .choices button')).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
		expect(textsIn(root, '.slot .ends span')).toEqual([TEXTS['chat.npsLow'], TEXTS['chat.npsHigh']]);
		await click(buttonIn(root, '0'));
		expect(server.last('POST /v1/chat/rating')?.body).toEqual({ score: 0 });
	});

	it('asks only when the chat says so: a resolved chat that was not asked (an imported one) shows no rating', async () => {
		keepGuest();
		const { $, root } = await start({
			features: ['visitor_chat'],
			settings: { ratings: { kind: 'csat', labels: ['1', '2', '3', '4', '5'], askWhen: 'on_resolve', comment: false } },
			routes: {
				'GET /v1/chat': () =>
					answer(200, {
						...view({ conversation: conv({ status: 'resolved', ratingRequested: false }) }),
						messages: [msg(1, 'staff', 'Done', { name: 'Ana' })],
					}),
			},
		});
		await click($('.launcher'));
		expect(root.textContent).not.toContain(TEXTS['chat.ratingAsk']);
	});
});

describe('attachments', () => {
	const features = ['visitor_chat'];
	const settings = {
		attachments: {
			visitors: 'signed_in',
			types: ['image/png', 'image/svg+xml', 'audio/ogg'],
			// each type's own cap (C11)
			limits: { 'image/png': 10 * 1024 * 1024, 'audio/ogg': 2 * 1024 * 1024 },
			maxBytes: 10 * 1024 * 1024,
			storage: true,
		},
	};

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
		expect(file.getAttribute('accept')).toBe('image/png,audio/ogg');
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
		// a voice note has its own cap (C11)
		const voice = new File(['x'], 'note.ogg', { type: 'audio/ogg' });
		Object.defineProperty(voice, 'size', { value: 3 * 1024 * 1024 });
		await choose(file, voice);
		expect($('.window > .status').textContent).toBe('The file is too big (at most 2 MB).');
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

	it('prefills the transcript email of a signed-in visitor and resets on sign-out', async () => {
		const { $, root, server, api } = await start({
			features: ['visitor_chat'],
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
			features: ['visitor_chat'],
			settings: {
				proactive: {
					idleMinutes: 1,
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
			time.time + PROACTIVE_DISMISS_DAYS * 86_400_000,
		);
		await time.advance(120_000);
		expect($('.nudge').hidden).toBe(true);
	});

	it('says the merchant’s text for the page setPage names, once per product (C14)', async () => {
		const { $, time, api } = await start({
			features: ['visitor_chat'],
			settings: {
				proactive: { idleMinutes: 1, oncePer: 'product' },
				pageTypes: [{ key: 'product', name: 'Product page', path: '', nudge: 'Still deciding on {product}?' }],
			},
		});
		api.setPage({ kind: 'product', productId: 'p1', productName: 'Desk lamp' });
		await time.advance(60_000);
		expect($('.nudge').hidden).toBe(false);
		expect($('.nudge').textContent).toContain('Still deciding on Desk lamp?');
		await api.open();
		await api.close();
		expect($('.nudge').hidden).toBe(true);
		// the next product the visitor looks at nudges too, with its own name
		api.setPage({ kind: 'product', productId: 'p2', productName: 'Canvas tote' });
		await time.advance(120_000);
		expect($('.nudge').hidden).toBe(false);
		expect($('.nudge').textContent).toContain('Still deciding on Canvas tote?');
		expect(JSON.parse(String(window.sessionStorage.getItem(PROACTIVE_STORAGE_KEY))).shown).toEqual(['idle:p1', 'idle:p2']);
		await api.open();
		await api.close();
		// back on the first product: it nudged already this visit
		api.setPage({ kind: 'product', productId: 'p1', productName: 'Desk lamp' });
		await time.advance(180_000);
		expect($('.nudge').hidden).toBe(true);
	});
});

describe('product cards', () => {
	const CARDS = [
		// after a deal: the list price struck through beside it
		{
			productId: 'prd_1',
			variantId: 'var_1',
			name: 'Desk lamp',
			price: 112500,
			compareAtPrice: 125000,
			currency: 'EUR',
			image: 'https://cdn.example.com/x.jpg',
			url: 'https://shop.example.com/products/desk-lamp',
			inStock: true,
		},
		{
			productId: 'prd_2',
			variantId: null,
			name: 'Canvas tote',
			price: 1500,
			compareAtPrice: null,
			currency: 'EUR',
			image: null,
			url: null,
			inStock: true,
			// sold by the meter from 1.5 m in steps of 0.5 m (thousandths of its unit)
			limits: { step: 500, min: 1500, max: 20000 },
			unit: 'm',
		},
		{
			...{ productId: 'prd_3', variantId: null, name: 'Old', price: 100, compareAtPrice: null, currency: 'EUR' },
			...{ image: null, url: null, inStock: false },
		},
	];
	const ROUTES = {
		'GET /v1/chat': () =>
			answer(200, { ...view(), messages: [msg(1, 'visitor', 'Lamps?'), msg(2, 'ai', 'Here you go.', { cards: CARDS })] }),
		'POST /v1/chat/read': () => answer(204),
	};

	it('shows image, name, price (with the struck-through "was" price) and Add to cart; a cart on the page takes the item', async () => {
		keepGuest();
		document.documentElement.lang = 'en-US';
		const { root, api } = await start({
			features: ['visitor_chat', 'ai_replies', 'shop_assistant'],
			routes: ROUTES,
		});
		await api.open();
		const cards = [...root.querySelectorAll('.card')];
		expect(cards).toHaveLength(3);
		expect(root.querySelector('.cards')?.getAttribute('aria-label')).toBe(TEXTS['chat.products']);
		expect(cards[0]?.querySelector('img')?.getAttribute('src')).toBe(CARDS[0]?.image);
		expect(cards[0]?.querySelector('a.name')?.getAttribute('href')).toBe(CARDS[0]?.url);
		expect(textsIn(root, '.card .price')).toEqual(['EUR 1,125.00', 'EUR 15.00', 'EUR 1.00']);
		// the "was" price struck through beside it, read out with its words (the struck amount is hidden from readers)
		const was = cards[0]?.querySelector('.prices s.was');
		expect(was?.textContent).toBe('EUR 1,250.00');
		expect(was?.getAttribute('aria-hidden')).toBe('true');
		expect(cards[0]?.querySelector('.prices .sr-only')?.textContent).toBe(
			TEXTS['chat.wasPrice']?.replace('{price}', 'EUR 1,250.00'),
		);
		expect(cards[1]?.querySelector('.was, .sr-only')).toBeNull();
		expect(textsIn(root, '.card .name')).toEqual(['Desk lamp', 'Canvas tote', 'Old']);
		expect(cards[2]?.textContent).toContain(TEXTS['chat.outOfStock']);
		expect(cards[2]?.querySelector('.add')).toBeNull();
		/** @type {any[]} */
		const asked = [];
		const cart = (/** @type {Event} */ event) => {
			asked.push(/** @type {CustomEvent} */ (event).detail);
			event.preventDefault();
		};
		window.addEventListener('ss-ecommerce:add-to-cart', cart);
		const add = /** @type {HTMLAnchorElement} */ (cards[0]?.querySelector('a.add'));
		expect(add.textContent).toBe(TEXTS['chat.addToCart']);
		const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
		expect(add.dispatchEvent(click)).toBe(false);
		expect(asked).toEqual([{ productId: 'prd_1', variantId: 'var_1', quantity: 1 }]);
		expect(cards[0]?.querySelector('.status')?.textContent).toBe(TEXTS['chat.addedToCart']);
		// a card without a product page has a plain button
		buttonIn(/** @type {HTMLElement} */ (cards[1]), TEXTS['chat.addToCart']).click();
		// an item with limits adds its least, in its own unit (EU)
		expect(asked.at(-1)).toEqual({ productId: 'prd_2', variantId: null, quantity: 1500, measured: true });
		window.removeEventListener('ss-ecommerce:add-to-cart', cart);
		document.documentElement.lang = '';
	});

	it('follows the link to the product page when no cart on the page takes the item', async () => {
		keepGuest();
		const { root, api } = await start({
			features: ['visitor_chat', 'ai_replies', 'shop_assistant'],
			routes: ROUTES,
		});
		await api.open();
		const add = /** @type {HTMLAnchorElement} */ (root.querySelector('.card a.add'));
		/** @type {boolean[]} */
		const followed = [];
		const watch = (/** @type {Event} */ event) => {
			followed.push(!event.defaultPrevented);
			event.preventDefault(); // jsdom cannot navigate
		};
		document.addEventListener('click', watch);
		add.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
		document.removeEventListener('click', watch);
		expect(followed).toEqual([true]);
		expect(add.getAttribute('href')).toBe(CARDS[0]?.url);
		expect(root.querySelector('.card .status')?.textContent).toBe('');
		const plain = buttonIn(/** @type {HTMLElement} */ (root.querySelectorAll('.card')[1]), TEXTS['chat.addToCart']);
		plain.click();
		expect(root.querySelectorAll('.card .status')[1]?.textContent).toBe('');
	});

	it('shows prices and times in the website’s Format and business time zone (K7)', async () => {
		keepGuest();
		const closed = conv({ waiting: true, officeHours: { open: false, backAt: '2026-10-02T07:00:00Z' } });
		const { root, api } = await start({
			features: ['visitor_chat', 'ai_replies', 'handoff', 'shop_assistant'],
			look: {
				format: {
					locale: 'en-GB',
					currencyDisplay: 'symbol',
					currencySymbols: { EUR: '€' },
					wholeUnits: true,
					times: 'business',
				},
				timeZone: 'Europe/Paris',
			},
			routes: {
				...ROUTES,
				'GET /v1/chat': () =>
					answer(200, {
						...view({ conversation: closed }),
						messages: [msg(1, 'visitor', 'Lamps?'), msg(2, 'ai', 'Here you go.', { cards: CARDS })],
					}),
			},
		});
		await api.open();
		expect(textsIn(root, '.card .price')).toEqual(['€ 1,125', '€ 15', '€ 1']);
		expect(textsIn(root, '.card .was')).toEqual(['€ 1,250']);
		expect(textsIn(root, '.notices p')[0]).toBe('Our team is away right now. They are back 2 Oct 2026, 09:00.');
	});

	it('shows no cards while product cards is off', async () => {
		keepGuest();
		const { root, api } = await start({ features: ['visitor_chat', 'ai_replies'], routes: ROUTES });
		await api.open();
		expect(textsIn(root, '.msg.ai p')).toEqual(['Here you go.']);
		expect(root.querySelector('.card')).toBeNull();
	});
});

describe('formatted answers (C2)', () => {
	const VISITOR = '**Is it** <b>in</b> [stock](https://shop.example.com)?\n- yes';
	const ANSWER = [
		'**Desk lamp** is in stock:',
		'- Black',
		'- White',
		'',
		'| Color | Price |',
		'| --- | --- |',
		'| Black | `EUR 10` |',
		'',
		'[See it](https://shop.example.com/p/x) or [this](javascript:alert%281%29) <img src=x onerror=alert(1)>',
	].join('\n');

	it('shows AI and staff answers formatted and the visitor’s own text exactly as typed', async () => {
		keepGuest();
		const { root, api } = await start({
			features: ['visitor_chat', 'ai_replies'],
			routes: {
				'GET /v1/chat': () =>
					answer(200, {
						...view(),
						messages: [
							msg(1, 'visitor', VISITOR, { format: 'text' }),
							msg(2, 'ai', ANSWER, { format: 'markdown' }),
							msg(3, 'staff', 'Thanks, *Ana* here.', { name: 'Ana', format: 'markdown' }),
							msg(4, 'visitor', '__also__ plain', { format: 'markdown' }),
						],
					}),
				'POST /v1/chat/read': () => answer(204),
			},
		});
		await api.open();
		const ai = /** @type {HTMLElement} */ (root.querySelector('.msg.ai:not(.welcome) > .rich'));
		expect(ai.querySelector('p strong')?.textContent).toBe('Desk lamp');
		expect(textsIn(ai, 'ul li')).toEqual(['Black', 'White']);
		expect(textsIn(ai, '.table th')).toEqual(['Color', 'Price']);
		expect(textsIn(ai, '.table td')).toEqual(['Black', 'EUR 10']);
		expect(ai.querySelector('td code')?.textContent).toBe('EUR 10');
		const links = [...ai.querySelectorAll('a')];
		expect(links.map((link) => [link.textContent, link.getAttribute('href'), link.target, link.rel])).toEqual([
			['See it', 'https://shop.example.com/p/x', '_blank', 'noopener noreferrer nofollow'],
		]);
		expect(ai.textContent).toContain('or this <img src=x onerror=alert(1)>');
		expect(ai.querySelector('img')).toBeNull();
		expect(root.querySelector('.msg.staff > .rich em')?.textContent).toBe('Ana');
		expect(textsIn(root, '.msg.visitor > p')).toEqual([VISITOR, '__also__ plain']);
		expect(root.querySelectorAll('.msg.visitor .rich, .msg.visitor strong, .msg.visitor a, .msg.visitor li')).toHaveLength(0);
	});
});
