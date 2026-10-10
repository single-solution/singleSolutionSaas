// @vitest-environment jsdom
/* global document, window */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import strings from '../strings/en.json' with { type: 'json' };
import { widgetSettings } from '../core/config.js';
import { CONSENT_STORAGE_KEY, VISIT_STORAGE_KEY, WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from '../core/widgets.js';
import { createCollector, deviceOf, markedNotFound, pageView, searchOnPage, watchVitals } from '../ui/collect.js';
import { storageOf } from '../ui/consent.js';
import { NOTICE_STORAGE_KEY } from '../ui/notice-bar.js';
import { injectScripts } from '../ui/tags.js';
import { ADMIN_CONFIG_PATH, CONFIG_PATH, startWidget } from '../ui/widget.js';

const BASE = 'https://growth.example.dev';
const NOW = Date.parse('2026-10-08T12:00:00Z');

/**
 * A widget config as the kit answers it.
 * @param {string[]} features
 * @param {Record<string, Record<string, unknown>>} [values]
 * @param {{ format?: Record<string, unknown>, timeZone?: string }} [look] the website's Format and business time zone
 */
const configOf = (features, values = {}, look = {}) => ({
	texts: { ...strings },
	theme: { mode: /** @type {const} */ ('light') },
	customCss: '',
	format: { locale: '', currencyDisplay: 'code', currencySymbol: '', wholeUnits: false, times: 'viewer', ...look.format },
	timeZone: look.timeZone ?? 'UTC',
	features,
	settings: widgetSettings({ on: features, values, now: NOW }),
});

/** @param {string | null} token */
const script = (token) => {
	const node = document.createElement('script');
	node.src = `${BASE}/widget.js`;
	if (token) node.dataset.token = token;
	return node;
};

const flush = async () => {
	for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** @param {number} status @param {unknown} [body] */
const answer = (status, body = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status });

/** @type {Array<{ path: string, init: any }>} */
let requests = [];

/**
 * `window.fetch` answering by method and path (the query string is ignored); every request is kept.
 * @param {Record<string, (init: any, url: URL) => Response | Promise<Response>>} routes
 */
const serve = (routes) =>
	vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		requests.push({ path: `${url.pathname}${url.search}`, init });
		const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
		return route ? route(init, url) : answer(404);
	});

/** The events posted to /v1/collect so far. */
const collected = () =>
	requests.filter((r) => r.path === '/v1/collect').flatMap((r) => /** @type {any[]} */ (JSON.parse(r.init.body).events));

/** @param {HTMLElement} host @param {string} selector */
const inside = (host, selector) => /** @type {any} */ (host.shadowRoot?.querySelector(selector));
/** @param {HTMLElement} host @param {string} text */
const button = (host, text) =>
	/** @type {HTMLButtonElement} */ (
		[...(host.shadowRoot?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text)
	);
/** @param {string} key */
const hostOf = (key) => /** @type {HTMLElement} */ (document.querySelector(`[${WIDGET_ATTRIBUTE}="${key}"]`));

/** @param {string} key */
const place = (key) => {
	const host = document.createElement('div');
	host.setAttribute(WIDGET_ATTRIBUTE, key);
	document.body.append(host);
	return host;
};

const w = /** @type {any} */ (window);

beforeEach(() => {
	requests = [];
	window.localStorage.clear();
	window.sessionStorage.clear();
	window.history.replaceState(null, '', '/');
});

afterEach(() => {
	document.body.replaceChildren();
	document.head.replaceChildren();
	for (const name of ['dataLayer', 'gtag', 'fbq', '_fbq', 'ttq', 'TiktokAnalyticsObject', WIDGET_GLOBAL, 'ranCustom'])
		delete w[name];
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('the page script', () => {
	it('does nothing without data-token, nor when the product says no', async () => {
		const fetch = serve({ [`GET ${CONFIG_PATH}`]: () => answer(403) });
		await startWidget({ window, script: script(null) }).ready;
		expect(fetch).not.toHaveBeenCalled();
		expect(Object.keys(w[WIDGET_GLOBAL])).toEqual(['admin', 'consent', 'search', 'notFound']);
		await startWidget({ window, script: script('browser-token') }).ready;
		expect(document.body.children).toHaveLength(0);
		fetch.mockImplementation(async () => {
			throw new Error('offline');
		});
		await startWidget({ window, script: script('browser-token') }).ready;
		w[WIDGET_GLOBAL].search('ignored');
		w[WIDGET_GLOBAL].consent.open();
		expect(document.body.children).toHaveLength(0);
	});

	it('asks for consent, then loads the tags of each granted category and records the page view', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: NOW });
		window.history.replaceState(null, '', '/shop?utm_source=News&q=phones');
		serve({
			[`GET ${CONFIG_PATH}`]: (init) => {
				expect(init.headers.authorization).toBe('Bearer browser-token');
				return answer(
					200,
					configOf(
						[
							'consent_banner',
							'meta_pixel',
							'google_tags',
							'tiktok_pixel',
							'custom_scripts',
							'visitor_analytics',
							'conversion_funnel',
							'searches_404s',
						],
						{
							consent_banner: { privacyUrl: '/privacy' },
							meta_pixel: { pixelId: '1234567' },
							google_tags: { ga4Id: 'G-ABCD12', adsId: 'AW-12345', adsPurchaseLabel: 'Label1', gtmId: 'GTM-ABCD1' },
							tiktok_pixel: { pixelId: 'CABCDEFGHIJ12' },
							custom_scripts: {
								analyticsScripts: 'window.ranCustom = 1;',
								marketingScripts: '<noscript><img src="x"></noscript>',
							},
						},
					),
				);
			},
			'POST /v1/collect': () => answer(202, { accepted: 1 }),
		});
		const page = startWidget({ window, script: script('browser-token') });
		// a shop event before the config is there waits for it
		window.dispatchEvent(
			new window.CustomEvent('ss:view_item', { detail: { currency: 'USD', value: 1250, items: [{ id: 'p1' }] } }),
		);
		await vi.advanceTimersByTimeAsync(0);
		await page.ready;
		const banner = hostOf('consent_banner');
		expect(inside(banner, '[role="dialog"]').hasAttribute('hidden')).toBe(false);
		expect(inside(banner, 'a').getAttribute('href')).toBe('/privacy');
		expect(w.dataLayer[0]).toEqual(expect.objectContaining({ 0: 'consent', 1: 'default' }));
		expect(document.head.querySelectorAll('script[src]')).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(2000);
		expect(collected()).toEqual([]);

		// Choose: analytics only
		button(banner, strings['consent.customize']).click();
		inside(banner, 'input[type="checkbox"]:not([disabled])').click();
		button(banner, strings['consent.save']).click();
		expect(inside(banner, '[role="dialog"]').hasAttribute('hidden')).toBe(true);
		expect(JSON.parse(String(window.localStorage.getItem(CONSENT_STORAGE_KEY)))).toMatchObject({
			analytics: true,
			marketing: false,
		});
		const sources = () =>
			[...document.head.querySelectorAll('script[src]')].map((s) => /** @type {HTMLScriptElement} */ (s).src);
		expect(sources()).toEqual([
			'https://www.googletagmanager.com/gtm.js?id=GTM-ABCD1',
			'https://www.googletagmanager.com/gtag/js?id=G-ABCD12',
		]);
		expect([...document.head.querySelectorAll('script:not([src])')].map((node) => node.textContent)).toContain(
			'window.ranCustom = 1;',
		);
		await vi.advanceTimersByTimeAsync(1000);
		expect(collected()).toEqual([
			expect.objectContaining({
				type: 'page_view',
				path: '/shop',
				visit: true,
				campaign: { source: 'News', medium: '', name: '' },
			}),
			{ type: 'search', path: '/shop', term: 'phones' },
			expect.objectContaining({
				type: 'view_item',
				value: 1250,
				currency: 'USD',
				items: [{ id: 'p1', variantId: null, quantity: 1 }],
			}),
		]);
		expect(requests.find((r) => r.path === '/v1/collect')?.init).toMatchObject({ keepalive: true, method: 'POST' });

		// marketing later: the pixels load and shop events reach them
		w[WIDGET_GLOBAL].consent.open();
		expect(inside(banner, '[role="dialog"]').hasAttribute('hidden')).toBe(false);
		button(banner, strings['consent.acceptAll']).click();
		expect(sources()).toContain('https://connect.facebook.net/en_US/fbevents.js');
		expect(sources()).toContain('https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=CABCDEFGHIJ12&lib=ttq');
		expect(document.body.querySelector('noscript')).not.toBeNull();
		w.ttq.track = vi.fn();
		window.dispatchEvent(
			new window.CustomEvent('ss:purchase', {
				detail: { orderId: 'o1', currency: 'USD', value: 2500, items: [{ id: 'p1', price: 1250, quantity: 2 }] },
			}),
		);
		expect(w.fbq.queue).toContainEqual([
			'track',
			'Purchase',
			expect.objectContaining({ value: 25 }),
			{ eventID: 'purchase-o1' },
		]);
		expect([...w.dataLayer].map((args) => [args[0], args[1]])).toContainEqual(['event', 'conversion']);
		expect(w.ttq.track).toHaveBeenCalledWith('CompletePayment', expect.objectContaining({ value: 25 }));
		w[WIDGET_GLOBAL].search('cases', { results: 0 });
		w[WIDGET_GLOBAL].notFound();
		await vi.advanceTimersByTimeAsync(1000);
		expect(collected().slice(-3)).toEqual([
			expect.objectContaining({ type: 'purchase', orderId: 'o1' }),
			{ type: 'search', path: '/shop', term: 'cases', results: 0 },
			{ type: 'not_found', path: '/shop' },
		]);
		// leaving the page sends what waits at once
		w[WIDGET_GLOBAL].search('last');
		window.dispatchEvent(new window.Event('pagehide'));
		expect(collected().at(-1)).toMatchObject({ term: 'last' });
	});

	it('drops what waited when the visitor refuses, and remembers the choice', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(200, configOf(['consent_banner', 'visitor_analytics', 'meta_pixel'], { meta_pixel: { pixelId: '1234567' } })),
			'POST /v1/collect': () => answer(202),
		});
		const page = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await page.ready;
		button(hostOf('consent_banner'), strings['consent.rejectAll']).click();
		await vi.advanceTimersByTimeAsync(2000);
		expect(collected()).toEqual([]);
		expect(document.head.querySelectorAll('script[src]')).toHaveLength(0);
		document.body.replaceChildren();
		const again = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await again.ready;
		expect(inside(hostOf('consent_banner'), '[role="dialog"]').hasAttribute('hidden')).toBe(true);
	});

	it('records without consent when the merchant does not require it, with the merchant’s own consent tool', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		const marker = document.createElement('meta');
		marker.setAttribute('name', 'ss-growth-page');
		marker.setAttribute('content', 'not_found');
		document.head.append(marker);
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(
					200,
					configOf(['visitor_analytics', 'searches_404s', 'google_tags', 'conversion_funnel'], {
						visitor_analytics: { requireConsent: false },
						google_tags: { ga4Id: 'G-ABCD12' },
					}),
				),
			'POST /v1/collect': () => answer(202),
		});
		const page = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await page.ready;
		expect(hostOf('consent_banner')).toBeNull();
		await vi.advanceTimersByTimeAsync(1000);
		expect(collected().map((e) => e.type)).toEqual(['page_view', 'not_found']);
		expect(w[WIDGET_GLOBAL].consent.get()).toBeNull();
		w[WIDGET_GLOBAL].consent.set({ analytics: true });
		expect(w[WIDGET_GLOBAL].consent.get()).toMatchObject({ analytics: true, marketing: false });
		expect(document.head.querySelector('script[src*="gtag"]')).not.toBeNull();
		window.dispatchEvent(new window.CustomEvent('ss:add_to_cart', { detail: null }));
		expect([...w.dataLayer].map((args) => args[1])).toContain('add_to_cart');
	});

	it('shows the notice bar while it is on, and a closed one stays closed for the visit', async () => {
		const placed = place('notice_bar');
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(200, configOf(['notice_bar'], { notice_bar: { text: 'Sale today', linkUrl: '/sale', linkText: 'Shop now' } })),
		});
		await startWidget({ window, script: script('t') }).ready;
		expect(inside(placed, '.notice span').textContent).toBe('Sale today');
		expect(inside(placed, 'a').getAttribute('href')).toBe('/sale');
		inside(placed, 'button').click();
		expect(window.sessionStorage.getItem(NOTICE_STORAGE_KEY)).toBe('Sale today');
		expect(document.body.contains(placed)).toBe(false);
		await startWidget({ window, script: script('t') }).ready;
		expect(hostOf('notice_bar')).toBeNull();
		window.sessionStorage.clear();
		await startWidget({ window, script: script('t') }).ready;
		expect(document.body.firstElementChild?.getAttribute(WIDGET_ATTRIBUTE)).toBe('notice_bar');
	});
});

describe('page facts', () => {
	it('tells a visit’s first page, the referrer and the device', () => {
		/** @type {Record<string, string>} */
		const kept = {};
		const visits = {
			getItem: (/** @type {string} */ key) => kept[key] ?? null,
			setItem: (/** @type {string} */ key, /** @type {string} */ value) => void (kept[key] = value),
		};
		Object.defineProperty(document, 'referrer', { value: 'https://www.google.com/search', configurable: true });
		const first = pageView({ window, visits, now: () => NOW });
		expect(first).toMatchObject({ visit: true, referrer: 'www.google.com', device: 'desktop' });
		expect(pageView({ window, visits, now: () => NOW + 60_000 })).toEqual({
			type: 'page_view',
			path: '/',
			visit: false,
			device: 'desktop',
		});
		expect(kept[VISIT_STORAGE_KEY]).toBe(String(NOW + 60_000));
		Object.defineProperty(document, 'referrer', { value: 'not a url', configurable: true });
		const broken = {
			getItem: () => null,
			setItem: () => {
				throw new Error('full');
			},
		};
		expect(pageView({ window, visits: broken, now: () => NOW })).toMatchObject({ visit: true, referrer: null });
		Object.defineProperty(document, 'referrer', { value: '', configurable: true });
		expect(deviceOf(500)).toBe('mobile');
		expect(deviceOf(800)).toBe('tablet');
		expect(searchOnPage(window, ['q'])).toBeNull();
		expect(markedNotFound(document)).toBe(false);
	});

	it('works without storage the browser refuses', () => {
		const refusing = /** @type {any} */ ({
			get localStorage() {
				throw new Error('blocked');
			},
		});
		const store = storageOf(refusing, 'localStorage');
		expect(store.getItem('x')).toBeNull();
		store.setItem('x', 'y');
	});

	it('sends batches of at most 25 events', async () => {
		/** @type {any[]} */
		const bodies = [];
		/** @type {Array<() => void>} */
		const timers = [];
		const collector = createCollector({
			base: BASE,
			token: 't',
			fetch: /** @type {any} */ (
				async (/** @type {string} */ _url, /** @type {any} */ init) => {
					bodies.push(JSON.parse(init.body));
					throw new Error('offline');
				}
			),
			schedule: (task) => timers.push(task),
		});
		collector.allow(true);
		for (let i = 0; i < 30; i += 1) collector.record(() => ({ type: 'page_view', path: `/${i}` }));
		collector.record(() => null);
		expect(timers).toHaveLength(1);
		timers[0]?.();
		expect(bodies.map((body) => body.events.length)).toEqual([25, 5]);
		collector.allow(false);
		for (let i = 0; i < 60; i += 1) collector.record(() => ({ type: 'page_view', path: '/' }));
		collector.allow(true);
		collector.flush();
		expect(bodies.at(-1).events).toHaveLength(25);
	});

	it('measures Web Vitals and reports them once when the page is hidden', () => {
		/** @type {Record<string, (list: { getEntries: () => any[] }) => void>} */
		const observers = {};
		const fakeWindow = /** @type {any} */ ({
			document: {
				visibilityState: 'visible',
				addEventListener: (/** @type {string} */ _n, /** @type {() => void} */ fn) => (fakeWindow.hide = fn),
			},
			addEventListener: () => {},
			performance: { getEntriesByType: () => [{ responseStart: 120 }] },
			PerformanceObserver: function Observer(/** @type {any} */ take) {
				return {
					observe: (/** @type {{ type: string }} */ options) => {
						if (options.type === 'paint') throw new Error('unsupported');
						observers[options.type] = take;
					},
				};
			},
		});
		/** @type {Array<[string, number]>} */
		const reported = [];
		watchVitals({ window: fakeWindow, report: (name, value) => reported.push([name, value]) });
		observers['largest-contentful-paint']?.({ getEntries: () => [{ startTime: 900 }, { startTime: 1500 }] });
		observers['largest-contentful-paint']?.({ getEntries: () => [] });
		observers['layout-shift']?.({
			getEntries: () => [
				{ value: 0.05, hadRecentInput: false },
				{ value: 1, hadRecentInput: true },
			],
		});
		observers.event?.({
			getEntries: () => [
				{ interactionId: 1, duration: 80 },
				{ interactionId: 0, duration: 999 },
				{ interactionId: 2, duration: 'x' },
			],
		});
		fakeWindow.hide();
		expect(reported).toEqual([]);
		fakeWindow.document.visibilityState = 'hidden';
		fakeWindow.hide();
		fakeWindow.hide();
		expect(reported).toEqual([
			['TTFB', 120],
			['LCP', 1500],
			['CLS', 50],
			['INP', 80],
		]);
		watchVitals({ window: /** @type {any} */ ({}), report: () => {} });
		const noTiming = {
			...fakeWindow,
			performance: {
				getEntriesByType: () => {
					throw new Error('no');
				},
			},
		};
		watchVitals({ window: noTiming, report: () => {} });
	});

	it('records Web Vitals through the page script', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(200, configOf(['visitor_analytics', 'web_vitals'], { visitor_analytics: { requireConsent: false } })),
			'POST /v1/collect': () => answer(202),
		});
		/** @type {any} */
		let take = null;
		w.PerformanceObserver = function Observer(/** @type {any} */ fn) {
			return {
				observe: (/** @type {{ type: string }} */ options) => {
					if (options.type === 'paint') take = fn;
				},
			};
		};
		const page = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await page.ready;
		take?.({ getEntries: () => [{ name: 'first-contentful-paint', startTime: 700 }] });
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new window.Event('visibilitychange'));
		expect(collected()).toContainEqual({ type: 'vital', path: '/', name: 'FCP', value: 700 });
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		delete w.PerformanceObserver;
	});

	it('adds pasted scripts so they run', () => {
		injectScripts(document, '<script data-x="1">window.ranCustom = 2;</script><p>hi</p> text');
		expect(document.head.querySelector('script[data-x="1"]')?.textContent).toBe('window.ranCustom = 2;');
		expect(document.body.querySelector('p')?.textContent).toBe('hi');
	});
});

describe('admin widgets', () => {
	const REPORT = {
		from: '2026-10-01',
		to: '2026-10-02',
		timeZone: 'UTC',
		totals: { visits: 3, pageViews: 7 },
		days: [
			{ day: '2026-10-01', visits: 1, pageViews: 2 },
			{ day: '2026-10-02', visits: 2, pageViews: 5 },
		],
		pages: [{ key: '/', count: 5 }],
		sources: [{ key: '(direct)', count: 2 }],
		devices: [{ key: 'mobile', count: 3 }],
		countries: [{ key: '(unknown)', count: 1 }],
		funnel: {
			steps: [
				{ step: 'view_item', count: 4 },
				{ step: 'add_to_cart', count: 2 },
				{ step: 'begin_checkout', count: 1 },
				{ step: 'purchase', count: 1 },
			],
			revenue: [{ currency: 'USD', value: 2500, orders: 1 }],
		},
		searches: [{ key: 'case', count: 2 }],
		emptySearches: [],
		notFound: [{ key: '/old', count: 1 }],
		vitals: [
			{ name: 'LCP', count: 2, average: 1800, good: 2, needsImprovement: 0, poor: 0 },
			{ name: 'CLS', count: 1, average: 300, good: 0, needsImprovement: 0, poor: 1 },
			{ name: 'INP', count: 0, average: null, good: 0, needsImprovement: 0, poor: 0 },
		],
	};

	/**
	 * @param {string[]} features @param {Record<string, (init: any, url: URL) => Response | Promise<Response>>} routes
	 * @param {{ format?: Record<string, unknown>, timeZone?: string }} [look]
	 */
	const startAdmin = async (features, routes, look) => {
		serve({ [`GET ${ADMIN_CONFIG_PATH}`]: () => answer(200, configOf(features, {}, look)), ...routes });
		let tickets = 0;
		const getTicket = vi.fn(async () => {
			tickets += 1;
			if (tickets > 1) throw new Error('signed out');
			return { ticket: `ticket-${tickets}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
		});
		await startWidget({ window, script: script(null) }).admin({ getTicket });
		await flush();
		return getTicket;
	};

	it('do nothing without a ticket or a config', async () => {
		const host = place('analytics_dashboard');
		const fetch = serve({ [`GET ${ADMIN_CONFIG_PATH}`]: () => answer(403) });
		const admin = startWidget({ window, script: script(null) }).admin;
		await admin({
			getTicket: async () => {
				throw new Error('no');
			},
		});
		await admin({ getTicket: async () => /** @type {any} */ ({}) });
		expect(fetch).not.toHaveBeenCalled();
		await admin({ getTicket: async () => ({ ticket: 't', expiresAt: new Date().toISOString() }) });
		expect(host.shadowRoot).toBeNull();
	});

	it('the analytics dashboard shows the report in tiles, lists and the hero chart', async () => {
		const host = place('analytics_dashboard');
		let fail = false;
		await startAdmin(['visitor_analytics'], {
			'GET /v1/admin/analytics': (init, url) => {
				expect(init.headers.authorization).toBe('Bearer ticket-1');
				expect(url.searchParams.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
				return fail ? answer(422, { detail: 'Bad days.' }) : answer(200, REPORT);
			},
		});
		const text = host.shadowRoot?.textContent ?? '';
		expect(inside(host, '.hero .value').textContent).toBe('3');
		expect(host.shadowRoot?.querySelectorAll('.bars span')).toHaveLength(2);
		for (const words of ['Direct', 'Phones', 'Unknown', 'Purchased', 'USD 25', 'Pages not found (404)', '1800 ms', '0.30', '—'])
			expect(text).toContain(words);
		expect(text).toContain('Days are in the UTC time zone.');
		fail = true;
		inside(host, 'form').dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(inside(host, '[role="status"]').textContent).toBe(`${strings['analytics.failed']} Bad days.`);
	});

	it('the admin widgets follow the website’s Format and business time zone', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		// 20:00 UTC on 8 October is 9 October in Karachi (UTC+5)
		vi.setSystemTime(Date.parse('2026-10-08T20:00:00Z'));
		const look = {
			format: { locale: 'en-GB', currencyDisplay: 'custom', currencySymbol: 'Rs', wholeUnits: true, times: 'business' },
			timeZone: 'Asia/Karachi',
		};
		const dashboard = place('analytics_dashboard');
		const checklist = place('seo_checklist');
		/** @type {URL[]} */
		const asked = [];
		await startAdmin(
			['visitor_analytics', 'seo_checklist'],
			{
				'GET /v1/admin/analytics': (init, url) => {
					asked.push(url);
					return answer(200, { ...REPORT, timeZone: 'Asia/Karachi' });
				},
				'POST /v1/admin/seo/checks': () =>
					answer(200, { checkedAt: '2026-10-08T12:00:00.000Z', summary: { pass: 0, warn: 0, fail: 0 }, checks: [] }),
			},
			look,
		);
		expect(asked[0]?.searchParams.get('from')).toBe('2026-09-10');
		expect(asked[0]?.searchParams.get('to')).toBe('2026-10-09');
		const text = dashboard.shadowRoot?.textContent ?? '';
		expect(text).toContain('Rs 25');
		expect(text).not.toContain('USD');
		expect(text).toContain('Days are in the Asia/Karachi time zone.');
		const bars = [...(dashboard.shadowRoot?.querySelectorAll('.bars span') ?? [])].map((bar) => bar.getAttribute('title'));
		expect(bars).toEqual(['1 Oct 2026: 1', '2 Oct 2026: 2']);
		button(checklist, strings['seo.run']).click();
		await flush();
		expect(inside(checklist, '[role="status"]').textContent).toBe('Checked 8 Oct 2026, 17:00');
	});

	it('the analytics dashboard says when nothing was recorded or the ticket is gone', async () => {
		const host = place('analytics_dashboard');
		await startAdmin(['visitor_analytics'], {
			'GET /v1/admin/analytics': () =>
				answer(200, {
					...REPORT,
					totals: { visits: 0, pageViews: 0 },
					days: [],
					pages: [],
					funnel: null,
					searches: null,
					vitals: null,
				}),
		});
		expect(host.shadowRoot?.textContent).toContain(strings['analytics.empty']);
		expect(host.shadowRoot?.textContent).toContain(strings['analytics.none']);
		vi.spyOn(window, 'fetch').mockImplementation(async () => answer(500));
		inside(host, 'form').dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(inside(host, '[role="status"]').textContent).toBe(strings['analytics.failed']);
	});

	it('the SEO checklist runs the checks and submits pages to IndexNow', async () => {
		const host = place('seo_checklist');
		/** @type {any[]} */
		const submitted = [];
		let refuse = false;
		await startAdmin(['seo_checklist', 'indexnow'], {
			'POST /v1/admin/seo/checks': () =>
				answer(200, {
					checkedAt: '2026-10-08T12:00:00.000Z',
					summary: { pass: 1, warn: 0, fail: 1 },
					checks: [
						{ id: 'title', status: 'pass', page: 'https://shop.example.com/', title: 'Page title', fix: '' },
						{
							id: 'robots_blocks',
							status: 'fail',
							page: null,
							title: 'robots.txt lets search engines in',
							fix: 'Remove it.',
						},
					],
				}),
			'POST /v1/admin/indexnow': (init) => {
				submitted.push(JSON.parse(init.body));
				return refuse ? answer(502, { detail: 'IndexNow answered 500.' }) : answer(200, { submitted: 2 });
			},
		});
		button(host, strings['seo.run']).click();
		await flush();
		const items = [...(host.shadowRoot?.querySelectorAll('.checks li') ?? [])].map((li) => li.textContent);
		expect(items[0]).toContain('Fix');
		expect(items[0]).toContain('Remove it.');
		expect(items[1]).toContain('https://shop.example.com/');
		expect(inside(host, '.lead').textContent).toBe('1 passed · 0 to improve · 1 to fix');
		const urls = inside(host, 'textarea');
		urls.value = 'https://shop.example.com/a\nhttps://shop.example.com/b ';
		inside(host, 'form').dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(submitted).toEqual([{ urls: ['https://shop.example.com/a', 'https://shop.example.com/b'] }]);
		expect(host.shadowRoot?.textContent).toContain('Submitted 2 addresses.');
		refuse = true;
		inside(host, 'form').dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(host.shadowRoot?.textContent).toContain('Not submitted: IndexNow answered 500.');
	});

	it('the SEO checklist without IndexNow, and signed out', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		const host = place('seo_checklist');
		serve({
			[`GET ${ADMIN_CONFIG_PATH}`]: () => answer(200, configOf(['seo_checklist'])),
			'POST /v1/admin/seo/checks': () => answer(500),
		});
		let calls = 0;
		const done = startWidget({ window, script: script(null) }).admin({
			getTicket: async () => {
				calls += 1;
				if (calls > 1) throw new Error('signed out');
				return { ticket: 't', expiresAt: new Date(Date.now() + 120_000).toISOString() };
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		await done;
		expect(inside(host, 'textarea')).toBeNull();
		button(host, strings['seo.run']).click();
		await vi.advanceTimersByTimeAsync(0);
		expect(inside(host, '[role="status"]').textContent).toBe(strings['seo.failed']);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(inside(host, '[role="status"]').textContent).toBe(strings['seo.signedOut']);
		button(host, strings['seo.run']).click();
		await vi.advanceTimersByTimeAsync(0);
		expect(inside(host, '[role="status"]').textContent).toBe(strings['seo.signedOut']);
	});

	it('the analytics dashboard when the ticket ends', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		const host = place('analytics_dashboard');
		serve({
			[`GET ${ADMIN_CONFIG_PATH}`]: () => answer(200, configOf(['visitor_analytics'])),
			'GET /v1/admin/analytics': () => answer(200, REPORT),
		});
		let calls = 0;
		const done = startWidget({ window, script: script(null) }).admin({
			getTicket: async () => {
				calls += 1;
				if (calls > 1) throw new Error('signed out');
				return { ticket: 't', expiresAt: new Date(Date.now() + 60_000).toISOString() };
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		await done;
		await vi.advanceTimersByTimeAsync(10);
		expect(inside(host, '[role="status"]').textContent).toBe(strings['analytics.signedOut']);
		inside(host, 'form').dispatchEvent(new window.Event('submit', { cancelable: true }));
		await vi.advanceTimersByTimeAsync(0);
		expect(inside(host, '[role="status"]').textContent).toBe(strings['analytics.signedOut']);
	});
});
