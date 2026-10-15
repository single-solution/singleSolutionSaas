// @vitest-environment jsdom
/* global document, window */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECKS, GUEST_HEADER, GUEST_STORAGE_KEY, PHONE_MEDIA, PROACTIVE_STORAGE_KEY, SIGN_IN_HEADER } from '../core/widgets.js';
import {
	attachmentNode,
	fileProblem,
	isInvalid,
	problemCode,
	settingsOf,
	textsOf,
	uploadFile,
	numbersOf,
	webAddress,
	whenOf,
} from '../ui/common.js';
import { deviceText } from '../ui/inbox-parts.js';
import { createMemory, idleOnce, idleText, isDesktop, isPhone, pageFlow, startProactive } from '../ui/proactive.js';
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
		expect(time.pending()).toEqual([CHECKS.activeMs * CHECKS.idleFactor]);
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

	it('checks as often as the website set, half as often after 5 idle minutes (C19)', async () => {
		const time = clock();
		const check = vi.fn(async () => {});
		const checks = createChecks({ win: window, ...time, check, activeMs: 30_000 });
		checks.start();
		expect(time.pending()).toEqual([30_000]);
		await time.advance(CHECKS.idleAfterMs);
		expect(check).toHaveBeenCalledTimes(10);
		expect(time.pending()).toEqual([60_000]);
		// a reply on its way is still checked every 3 s
		checks.expectReply();
		expect(time.pending()).toEqual([CHECKS.replyMs]);
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

	it('checks as often as the website set; on focus at most that often (C19)', async () => {
		const time = clock();
		const check = vi.fn(async () => {});
		const unread = createUnreadChecks({ win: window, ...time, check, everyMs: 20_000 });
		unread.start();
		expect(time.pending()).toEqual([20_000]);
		await time.advance(60_000);
		expect(check).toHaveBeenCalledTimes(4);
		await time.advance(5_000);
		window.dispatchEvent(new window.Event('focus'));
		expect(check).toHaveBeenCalledTimes(4);
		await time.advance(15_000);
		expect(check).toHaveBeenCalledTimes(5);
		await time.advance(19_000);
		window.dispatchEvent(new window.Event('focus'));
		expect(check).toHaveBeenCalledTimes(5);
		setHiddenTab(true);
		await time.advance(30_000);
		setHiddenTab(false);
		expect(check).toHaveBeenCalledTimes(6);
		unread.stop();
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

	it('reads problems', () => {
		expect(problemCode(null)).toBe('');
		expect(problemCode({ type: 'x/y/z' })).toBe('z');
		// a refused value is only recognized: the widgets show their own text, never the server's English detail
		expect(isInvalid({ ok: false, status: 422, data: { type: '/validation_failed', errors: [{ message: 'Bad' }] } })).toBe(
			true,
		);
		expect(isInvalid({ ok: false, status: 409, data: { type: '/conflict', detail: 'D' } })).toBe(false);
		expect(isInvalid({ ok: false, status: 500, data: null })).toBe(false);
		// the device as staff read it: the kind (and an unknown browser) in the widget texts, other text as it came
		const texts = textsOf({ texts: { 'inbox.devicePhone': 'Telefon', 'inbox.deviceBrowser': 'Tarayıcı' } });
		expect(deviceText(texts, 'Phone · Safari')).toBe('Telefon · Safari');
		expect(deviceText(texts, 'Phone · Browser')).toBe('Telefon · Tarayıcı');
		expect(deviceText(texts, 'iPhone app')).toBe('iPhone app');
		expect(deviceText(texts, 'Watch · Safari')).toBe('Watch · Safari');
		expect(deviceText(texts, 'Phone · Safari · 17')).toBe('Phone · Safari · 17');
		expect(t('nope')).toBe('nope');
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
		const business = whenOf({ format: { locale: 'en-GB', times: 'business' }, timeZone: 'America/New_York' }, window);
		expect(business('2026-10-01T10:00:00Z')).toBe('1 Oct 2026, 06:00');
		expect(business('2026-10-01T10:00:00Z', 'date')).toBe('1 Oct 2026');
		// numbers: the Format's locale, else the viewer's, else en-US (a tag the runtime does not know or a broken one)
		expect(numbersOf({ format: { locale: 'de-DE' } }, window)(12000.5)).toBe('12.000,5');
		expect(numbersOf({}, { navigator: { language: 'fr-FR' } })(12000, 1)).toBe('12 000,0');
		expect(numbersOf({}, { navigator: { language: 'zz' } })(12000)).toBe('12,000');
		expect(numbersOf({}, { navigator: { language: 'not a tag!' } })(4.25, 1)).toBe('4.3');
		expect(numbersOf({}, null)(1234)).toBe('1,234');
		expect(fileProblem({ type: 'image/svg+xml', size: 1 }, ['image/png'], 10)).toBe('type');
		expect(fileProblem({ type: 'image/png', size: 11 }, ['image/png'], 10)).toBe('size');
		expect(fileProblem({ type: 'image/png', size: 0 }, ['image/png'], 10)).toBe('size');
		expect(fileProblem({ type: 'image/png', size: 5 }, ['image/png'], 10)).toBe('');
		const bad = attachmentNode(document, { name: 'a.pdf', type: 'application/pdf', url: 'data:x' });
		expect(bad.tagName).toBe('SPAN');
		const pdf = attachmentNode(document, { name: 'a.pdf', type: 'application/pdf', url: 'https://files.test/a.pdf' });
		expect(pdf.getAttribute('download')).toBe('a.pdf');
		// a PDF that opens in the browser (CH-8)
		const opens = attachmentNode(document, {
			name: 'a.pdf',
			type: 'application/pdf',
			url: 'https://files.test/a.pdf',
			inline: true,
		});
		expect([opens.getAttribute('download'), opens.getAttribute('target')]).toEqual([null, '_blank']);
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

describe('proactive', () => {
	/** @param {string[]} features @param {Record<string, any>} [settings] @param {string} [path] */
	const setup = (features, settings = {}, path = '/products/lamp') => {
		const time = clock();
		const offer = vi.fn(/** @type {(kind: string, text: string, once?: string) => boolean} */ (() => true));
		const startFlow = vi.fn();
		/** @type {import('../ui/chat.js').PageInfo | null} */
		let page = null;
		const stop = startProactive({
			win: window,
			...time,
			features,
			settings: settingsOf({ settings }),
			t,
			path,
			page: () => page,
			offer,
			startFlow,
		});
		/** @param {import('../ui/chat.js').PageInfo | null} info */
		const setPage = (info) => {
			page = info;
		};
		return {
			time,
			offer,
			startFlow,
			stop,
			setPage,
			setProduct: (/** @type {string} */ name) => setPage({ kind: 'product', productName: name }),
		};
	};
	/** The page's screen is a phone's (or not). @param {boolean} phone */
	const phoneScreen = (phone) => {
		window.matchMedia = /** @type {any} */ (vi.fn((query) => ({ matches: phone && query === PHONE_MEDIA })));
	};
	const MESSAGES = {
		product: 'Still deciding on {product}? Ask us.',
		category: 'Comparing a few? We can help.',
		deals: '',
		cart: 'Questions before you check out?',
	};

	it('nudges after the idle minutes, waiting again while the window is open', async () => {
		const { time, offer, stop, setProduct } = setup(['proactive_idle'], { proactive: { idleMinutes: 2 } });
		await time.advance(60_000);
		window.dispatchEvent(new window.Event('pointermove'));
		await time.advance(60_000);
		expect(offer).not.toHaveBeenCalled();
		offer.mockReturnValueOnce(false);
		await time.advance(60_000);
		expect(offer).toHaveBeenCalledWith('idle', TEXTS['chat.idle'], 'idle');
		setProduct('Canvas tote');
		await time.advance(120_000);
		expect(offer).toHaveBeenLastCalledWith('idle', 'Questions about Canvas tote? We are happy to help.', 'idle');
		// shown once per session: no third offer
		await time.advance(600_000);
		expect(offer).toHaveBeenCalledTimes(2);
		stop();
	});

	it('says the merchant’s nudge text for the kind of page, else the general text (C14)', () => {
		expect(idleText(MESSAGES, { kind: 'product', productId: 'p1', productName: 'Desk lamp' }, t)).toBe(
			'Still deciding on Desk lamp? Ask us.',
		);
		expect(idleText(MESSAGES, { kind: 'category' }, t)).toBe('Comparing a few? We can help.');
		expect(idleText(MESSAGES, { kind: 'cart' }, t)).toBe('Questions before you check out?');
		// no text of the merchant for deals pages, none for other pages, no page named: the general text
		expect(idleText(MESSAGES, { kind: 'deals' }, t)).toBe(TEXTS['chat.idle']);
		expect(idleText(MESSAGES, { kind: 'other', productName: 'Desk lamp' }, t)).toBe(
			'Questions about Desk lamp? We are happy to help.',
		);
		expect(idleText(MESSAGES, null, t)).toBe(TEXTS['chat.idle']);
		// a text naming the product needs its name; one that does not, does not
		expect(idleText(MESSAGES, { kind: 'product' }, t)).toBe(TEXTS['chat.idle']);
		expect(idleText({ ...MESSAGES, product: 'Need a hand?' }, { kind: 'product' }, t)).toBe('Need a hand?');
	});

	it('remembers the nudge once per session, or once per product page (C14)', () => {
		const lamp = { kind: 'product', productId: 'p1', productName: 'Desk lamp' };
		expect(idleOnce('session', lamp)).toBe('idle');
		expect(idleOnce('product', lamp)).toBe('idle:p1');
		expect(idleOnce('product', { kind: 'product', productName: 'Desk lamp' })).toBe('idle:Desk lamp');
		expect(idleOnce('product', { kind: 'product' })).toBe('idle');
		expect(idleOnce('product', { kind: 'category', productId: 'p1' })).toBe('idle');
		expect(idleOnce('product', null)).toBe('idle');
	});

	it('once per product: each product the visitor looks at may nudge, with that page’s text (C14)', async () => {
		const { time, offer, stop, setPage } = setup(['proactive_idle'], {
			proactive: { idleMinutes: 1, messages: MESSAGES, oncePer: 'product' },
		});
		setPage({ kind: 'product', productId: 'p1', productName: 'Desk lamp' });
		await time.advance(60_000);
		expect(offer).toHaveBeenLastCalledWith('idle', 'Still deciding on Desk lamp? Ask us.', 'idle:p1');
		// the widget remembers p1; the nudge keeps waiting for the next product
		setPage({ kind: 'product', productId: 'p2', productName: 'Canvas tote' });
		window.dispatchEvent(new window.Event('scroll'));
		await time.advance(30_000);
		expect(offer).toHaveBeenCalledTimes(1);
		await time.advance(30_000);
		expect(offer).toHaveBeenLastCalledWith('idle', 'Still deciding on Canvas tote? Ask us.', 'idle:p2');
		setPage({ kind: 'cart' });
		await time.advance(60_000);
		expect(offer).toHaveBeenLastCalledWith('idle', 'Questions before you check out?', 'idle');
		stop();
		await time.advance(600_000);
		expect(offer).toHaveBeenCalledTimes(3);
	});

	it('no nudge on phones when the merchant chose so; tablets and desktops still get it (C14)', async () => {
		phoneScreen(true);
		expect(isPhone(window)).toBe(true);
		const hidden = setup(['proactive_idle'], { proactive: { idleMinutes: 1, hideOnMobile: true } });
		await hidden.time.advance(600_000);
		expect(hidden.offer).not.toHaveBeenCalled();
		hidden.stop();
		const shown = setup(['proactive_idle'], { proactive: { idleMinutes: 1 } });
		await shown.time.advance(60_000);
		expect(shown.offer).toHaveBeenCalledWith('idle', TEXTS['chat.idle'], 'idle');
		shown.stop();
		phoneScreen(false);
		expect(isPhone(window)).toBe(false);
		const wide = setup(['proactive_idle'], { proactive: { idleMinutes: 1, hideOnMobile: true } });
		await wide.time.advance(60_000);
		expect(wide.offer).toHaveBeenCalledTimes(1);
		wide.stop();
		delete (/** @type {any} */ (window).matchMedia);
		expect(isPhone(window)).toBe(false);
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
