// @vitest-environment jsdom
/* global document, window */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECKS, GUEST_HEADER, GUEST_STORAGE_KEY, PROACTIVE_STORAGE_KEY, SIGN_IN_HEADER } from '../core/widgets.js';
import {
	attachmentNode,
	fileProblem,
	invalidText,
	problemCode,
	requestJson,
	settingsOf,
	textsOf,
	uploadFile,
	webAddress,
	whenOf,
} from '../ui/common.js';
import { createMemory, isDesktop, pageFlow, startProactive } from '../ui/proactive.js';
import { createTicketSource } from '../ui/tickets.js';
import { createChecks, createUnreadChecks } from '../ui/transport.js';
import { createVisitor } from '../ui/visitor.js';
import { BASE, START, TEXTS, answer, clock, flush, problem, resetPage, serve, setHiddenTab } from './ui-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

const t = textsOf({ texts: TEXTS });

describe('createChecks', () => {
	const setup = () => {
		const time = clock();
		const check = vi.fn(async () => {});
		const checks = createChecks({ win: window, ...time, check });
		return { time, check, checks };
	};

	it('checks every 10 s, every 20 s after 5 idle minutes and stops after 15', async () => {
		const { time, check, checks } = setup();
		checks.start();
		checks.start();
		expect(time.pending()).toEqual([CHECKS.activeMs]);
		await time.advance(CHECKS.idleAfterMs);
		expect(check).toHaveBeenCalledTimes(30);
		expect(time.pending()).toEqual([CHECKS.idleMs]);
		await time.advance(CHECKS.stopAfterMs - CHECKS.idleAfterMs);
		expect(time.pending()).toEqual([]);
		const count = check.mock.calls.length;
		window.dispatchEvent(new window.Event('keydown'));
		await flush();
		expect(check).toHaveBeenCalledTimes(count + 1);
		expect(time.pending()).toEqual([CHECKS.activeMs]);
		window.dispatchEvent(new window.Event('pointerdown'));
		expect(check).toHaveBeenCalledTimes(count + 1);
		checks.stop();
		expect(time.pending()).toEqual([]);
		expect(checks.running()).toBe(false);
	});

	it('does nothing while the tab is hidden and checks at once when it shows again', async () => {
		const { time, check, checks } = setup();
		checks.start();
		setHiddenTab(true);
		expect(time.pending()).toEqual([]);
		checks.checkNow();
		await time.advance(60_000);
		expect(check).not.toHaveBeenCalled();
		setHiddenTab(false);
		await flush();
		expect(check).toHaveBeenCalledTimes(1);
		checks.checkNow();
		await flush();
		expect(check).toHaveBeenCalledTimes(2);
		checks.stop();
		setHiddenTab(true);
		setHiddenTab(false);
		await flush();
		expect(check).toHaveBeenCalledTimes(2);
	});

	it('checks every 3 s for 45 s while a reply is expected', async () => {
		const { time, check, checks } = setup();
		checks.expectReply();
		expect(time.pending()).toEqual([]);
		checks.start();
		checks.expectReply();
		expect(time.pending()).toEqual([CHECKS.replyMs]);
		await time.advance(CHECKS.replyWindowMs);
		expect(check).toHaveBeenCalledTimes(15);
		expect(time.pending()).toEqual([CHECKS.activeMs]);
		checks.expectReply();
		checks.settle();
		await time.advance(CHECKS.replyMs);
		expect(time.pending()).toEqual([CHECKS.activeMs]);
		checks.stop();
	});

	it('skips a check while one is running', async () => {
		const time = clock();
		/** @type {() => void} */
		let release = () => {};
		const check = vi.fn(() => new Promise((resolve) => (release = () => resolve(undefined))));
		const checks = createChecks({ win: window, ...time, check });
		checks.start();
		checks.checkNow();
		checks.checkNow();
		expect(check).toHaveBeenCalledTimes(1);
		release();
		await flush();
		expect(time.pending()).toEqual([CHECKS.activeMs]);
		checks.stop();
	});
});

describe('createUnreadChecks', () => {
	it('checks on load, every 5 minutes while visible and on focus at most once a minute', async () => {
		const time = clock();
		const check = vi.fn(async () => {});
		const unread = createUnreadChecks({ win: window, ...time, check });
		unread.start();
		unread.start();
		expect(check).toHaveBeenCalledTimes(1);
		window.dispatchEvent(new window.Event('focus'));
		expect(check).toHaveBeenCalledTimes(1);
		await time.advance(CHECKS.closedFocusMinMs);
		window.dispatchEvent(new window.Event('focus'));
		expect(check).toHaveBeenCalledTimes(2);
		await time.advance(CHECKS.closedEveryMs);
		expect(check).toHaveBeenCalledTimes(3);
		setHiddenTab(true);
		expect(time.pending()).toEqual([]);
		await time.advance(10);
		setHiddenTab(false);
		expect(check).toHaveBeenCalledTimes(3);
		expect(time.pending()).toEqual([CHECKS.closedEveryMs]);
		unread.stop();
		expect(time.pending()).toEqual([]);
	});

	it('only plans when started without an immediate check', () => {
		const time = clock();
		const check = vi.fn(async () => {});
		const unread = createUnreadChecks({ win: window, ...time, check });
		unread.start(false);
		expect(check).not.toHaveBeenCalled();
		expect(time.pending()).toEqual([CHECKS.closedEveryMs]);
		unread.stop();
	});
});

describe('createVisitor', () => {
	it('keeps the guest key with its expiry and sends the headers', async () => {
		const time = clock();
		const server = serve({ 'GET /v1/chat': () => answer(200, { ok: true }) });
		const visitor = createVisitor({ win: window, base: BASE, token: 'bt', now: time.now });
		expect(visitor.known()).toBe(false);
		visitor.keepGuest('');
		visitor.rememberFor(1);
		visitor.keepGuest('g1');
		expect(JSON.parse(String(window.localStorage.getItem(GUEST_STORAGE_KEY)))).toEqual({
			key: 'g1',
			expiresAt: START + 86_400_000,
		});
		visitor.identify('sig');
		expect(visitor.signedIn()).toBe(true);
		await visitor.call('GET', '/v1/chat');
		expect(server.last('GET /v1/chat')?.headers).toEqual({
			authorization: 'Bearer bt',
			[SIGN_IN_HEADER]: 'sig',
			[GUEST_HEADER]: 'g1',
		});
		visitor.identify(null);
		time.time += 86_400_001;
		expect(visitor.guestKey()).toBeNull();
		expect(window.localStorage.getItem(GUEST_STORAGE_KEY)).toBeNull();
		await visitor.call('GET', '/v1/chat');
		expect(server.last('GET /v1/chat')?.headers).toEqual({ authorization: 'Bearer bt' });
	});

	it('works without storage', () => {
		const time = clock();
		vi.spyOn(window.Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		const visitor = createVisitor({ win: window, base: BASE, token: 'bt', now: time.now });
		visitor.keepGuest('g1');
		expect(visitor.guestKey()).toBeNull();
		const memory = createMemory({ win: window, now: time.now });
		memory.shown('idle');
		memory.dismiss(7);
		expect(memory.allowed('idle')).toBe(true);
	});
});

describe('common', () => {
	it('fills settings with defaults', () => {
		const settings = settingsOf({ settings: /** @type {any} */ ({ look: { botName: 'Bo' }, signInUrl: '/in' }) });
		expect(settings.look.botName).toBe('Bo');
		expect(settings.look.launcherPosition).toBe('bottom-right');
		expect(settings.signInUrl).toBe('/in');
		expect(settings.guests.rememberDays).toBe(90);
		expect(settingsOf({}).flows).toEqual([]);
	});

	it('reads problems and answers', async () => {
		expect(problemCode(null)).toBe('');
		expect(problemCode({ type: 'x/y/z' })).toBe('z');
		expect(invalidText({ ok: false, status: 422, data: { type: '/validation_failed', errors: [{ message: 'Bad' }] } })).toBe(
			'Bad',
		);
		expect(invalidText({ ok: false, status: 422, data: { type: '/validation_failed', detail: 'D' } })).toBe('D');
		expect(invalidText({ ok: false, status: 500, data: null })).toBe('');
		expect(t('nope')).toBe('nope');
		vi.spyOn(window, 'fetch').mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(answer(204));
		const request = (/** @type {any} */ input, /** @type {any} */ init) => window.fetch(input, init);
		expect(await requestJson(request, `${BASE}/x`)).toEqual({ ok: false, status: 0, data: null });
		expect(await requestJson(request, `${BASE}/x`, { method: 'POST' })).toEqual({ ok: true, status: 204, data: null });
	});

	it('checks addresses, times and files', () => {
		expect(webAddress('javascript:alert(1)')).toBeNull();
		expect(webAddress('::')).toBeNull();
		expect(webAddress('/in', 'https://shop.test/a')).toBe('https://shop.test/in');
		const when = whenOf({}, window);
		expect(when('nope')).toBe('');
		expect(when(null)).toBe('');
		expect(when('2026-10-01T10:00:00Z')).not.toBe('');
		// the website's Format: its locale, and the business time zone when times are `business`
		const business = whenOf({ format: { locale: 'en-GB', times: 'business' }, timeZone: 'Asia/Karachi' }, window);
		expect(business('2026-10-01T10:00:00Z')).toBe('1 Oct 2026, 15:00');
		expect(business('2026-10-01T10:00:00Z', 'date')).toBe('1 Oct 2026');
		expect(fileProblem({ type: 'image/svg+xml', size: 1 }, ['image/png'], 10)).toBe('type');
		expect(fileProblem({ type: 'image/png', size: 11 }, ['image/png'], 10)).toBe('size');
		expect(fileProblem({ type: 'image/png', size: 0 }, ['image/png'], 10)).toBe('size');
		expect(fileProblem({ type: 'image/png', size: 5 }, ['image/png'], 10)).toBe('');
		const bad = attachmentNode(document, { name: 'a.pdf', type: 'application/pdf', url: 'data:x' });
		expect(bad.tagName).toBe('SPAN');
		const pdf = attachmentNode(document, { name: 'a.pdf', type: 'application/pdf', url: 'https://files.test/a.pdf' });
		expect(pdf.getAttribute('download')).toBe('a.pdf');
		const image = attachmentNode(document, { name: 'a.png', type: 'image/png', url: 'https://files.test/a.png' });
		expect(image.querySelector('img')?.getAttribute('alt')).toBe('a.png');
	});

	it('uploads with exactly the returned headers', async () => {
		const file = new File(['abc'], 'a.png', { type: 'image/png' });
		const fetch = vi.fn(async () => answer(200));
		const ok = {
			ok: true,
			status: 200,
			data: {
				upload: { method: 'PUT', url: 'https://bucket.test/k', headers: { 'content-type': 'image/png' } },
				attachment: { key: 'k' },
			},
		};
		expect(await uploadFile(fetch, async () => ok, file)).toEqual({ attachment: { key: 'k' } });
		expect(fetch).toHaveBeenCalledWith('https://bucket.test/k', {
			method: 'PUT',
			headers: { 'content-type': 'image/png' },
			body: file,
		});
		const refused = { ok: false, status: 403, data: null };
		expect(await uploadFile(fetch, async () => refused, file)).toEqual({ failed: refused });
		const bare = { ok: true, status: 200, data: { upload: { url: 'https://bucket.test/k' }, attachment: {} } };
		fetch.mockResolvedValueOnce(answer(500));
		expect(await uploadFile(fetch, async () => bare, file)).toEqual({ failed: null });
		fetch.mockRejectedValueOnce(new Error('down'));
		expect(await uploadFile(fetch, async () => bare, file)).toEqual({ failed: null });
	});
});

describe('tickets', () => {
	it('renews before expiry and tells when signed out', async () => {
		const time = clock();
		const getTicket = vi
			.fn()
			.mockResolvedValueOnce({ ticket: 't2', expiresAt: new Date(START + 30 * 60_000).toISOString() })
			.mockResolvedValueOnce({});
		const tickets = createTicketSource({
			first: { ticket: 't1', expiresAt: new Date(START + 15 * 60_000).toISOString() },
			getTicket,
			...time,
		});
		const seen = vi.fn();
		const off = tickets.onChange(seen);
		expect(tickets.current()).toBe('t1');
		expect(time.pending()).toEqual([14 * 60_000]);
		await time.advance(14 * 60_000);
		expect(tickets.current()).toBe('t2');
		await time.advance(15 * 60_000);
		expect(tickets.current()).toBeNull();
		expect(seen.mock.calls).toEqual([[true], [false]]);
		off();
		tickets.stop();
	});
});

describe('proactive', () => {
	/** @param {string[]} features @param {Record<string, any>} [settings] @param {string} [path] */
	const setup = (features, settings = {}, path = '/products/phone') => {
		const time = clock();
		const offer = vi.fn(() => true);
		const startFlow = vi.fn();
		/** @type {string | null} */
		let product = null;
		const stop = startProactive({
			win: window,
			...time,
			features,
			settings: settingsOf({ settings }),
			t,
			path,
			productName: () => product,
			offer,
			startFlow,
		});
		return { time, offer, startFlow, stop, setProduct: (/** @type {string} */ name) => (product = name) };
	};

	it('nudges after the idle minutes, waiting again while the window is open', async () => {
		const { time, offer, stop, setProduct } = setup(['proactive_idle'], { proactive: { idleMinutes: 2 } });
		await time.advance(60_000);
		window.dispatchEvent(new window.Event('pointermove'));
		await time.advance(60_000);
		expect(offer).not.toHaveBeenCalled();
		offer.mockReturnValueOnce(false);
		await time.advance(60_000);
		expect(offer).toHaveBeenCalledWith('idle', TEXTS['chat.idle']);
		setProduct('Phone X');
		await time.advance(120_000);
		expect(offer).toHaveBeenLastCalledWith('idle', 'Questions about Phone X? We are happy to help.');
		stop();
	});

	it('shows the first matching page rule after its delay and starts page flows after theirs', async () => {
		const { time, offer, startFlow, stop } = setup(['proactive_pages', 'leads_flows'], {
			proactive: {
				pageRules: [
					{ path: '/cart', delay: 1, message: 'Cart help?' },
					{ path: '/products/*', delay: 5, message: 'Phone help?' },
					{ path: '/products/**', delay: 1, message: 'Later rule' },
				],
			},
			flows: [
				{ id: 'k', name: 'Keyword', start: { kind: 'keyword', keywords: ['x'] } },
				{ id: 'f1', name: 'Phones', start: { kind: 'page', path: '/products/**', delay: 10 } },
			],
		});
		await time.advance(5_000);
		expect(offer).toHaveBeenCalledWith('page', 'Phone help?');
		await time.advance(5_000);
		expect(startFlow).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
		stop();
	});

	it('offers exit intent on desktop only', async () => {
		const desktop = setup(['proactive_exit']);
		document.dispatchEvent(new window.MouseEvent('mouseout', { clientY: 10 }));
		document.dispatchEvent(new window.MouseEvent('mouseout', { clientY: 0 }));
		expect(desktop.offer).toHaveBeenCalledTimes(1);
		expect(desktop.offer).toHaveBeenCalledWith('exit', TEXTS['chat.exit']);
		desktop.stop();
		document.dispatchEvent(new window.MouseEvent('mouseout', { clientY: 0 }));
		expect(desktop.offer).toHaveBeenCalledTimes(1);
		window.matchMedia = /** @type {any} */ (vi.fn((query) => ({ matches: query === '(pointer: coarse)' })));
		expect(isDesktop(window)).toBe(false);
		const phone = setup(['proactive_exit']);
		document.dispatchEvent(new window.MouseEvent('mouseout', { clientY: 0 }));
		expect(phone.offer).not.toHaveBeenCalled();
		delete (/** @type {any} */ (window).matchMedia);
	});

	it('remembers shown kinds per session and dismissals for days', () => {
		const time = clock();
		const memory = createMemory({ win: window, now: time.now });
		expect(memory.allowed('idle')).toBe(true);
		memory.shown('idle');
		expect(memory.allowed('idle')).toBe(false);
		expect(memory.allowed('exit')).toBe(true);
		memory.dismiss(7);
		expect(memory.allowed('exit')).toBe(false);
		time.time += 7 * 86_400_000 + 1;
		expect(memory.allowed('exit')).toBe(true);
		expect(memory.flowStarted('f1')).toBe(false);
		memory.startFlow('f1');
		expect(memory.flowStarted('f1')).toBe(true);
		window.sessionStorage.setItem(PROACTIVE_STORAGE_KEY, 'null');
		expect(memory.allowed('idle')).toBe(true);
		expect(pageFlow([], '/')).toBeNull();
	});
});

describe('entry', () => {
	it('starts the widget from the script tag', async () => {
		await import('../ui/entry.js');
		expect(typeof (/** @type {any} */ (window).SSChat?.identify)).toBe('function');
	});
});

describe('problem helper', () => {
	it('builds RFC 9457 answers', async () => {
		expect(await problem(403, 'x').json()).toMatchObject({ status: 403 });
	});
});
