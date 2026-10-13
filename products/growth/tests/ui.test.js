// @vitest-environment jsdom
/* global document, window */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import strings from '../strings/en.json' with { type: 'json' };
import { widgetSettings } from '../core/config.js';
import { CONSENT_STORAGE_KEY, SESSION_STORAGE_KEY, VISIT_STORAGE_KEY, WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from '../core/widgets.js';
import {
	cameFrom,
	createCollector,
	createSession,
	deviceOf,
	markedNotFound,
	pageView,
	randomId,
	searchOnPage,
	watchNavigation,
	watchVitals,
} from '../ui/collect.js';
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

/**
 * Another document loaded in the tab at an address (the page script of the one before is gone with it).
 * @param {string} address
 */
const loadDocument = (address) => {
	delete w[WIDGET_GLOBAL];
	document.body.replaceChildren();
	window.history.replaceState(null, '', address);
};

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
		expect(Object.keys(w[WIDGET_GLOBAL])).toEqual(['admin', 'consent', 'search', 'contact', 'notFound']);
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

/** The addresses of the scripts loaded in the page head. */
const sources = () => [...document.head.querySelectorAll('script[src]')].map((s) => /** @type {HTMLScriptElement} */ (s).src);

describe('store-conversion options with the real page script (PLAN 0.8.10 G1–G7)', () => {
	it('G1: tags load without a choice when the merchant turns consent off, and GA4 can run inside Tag Manager', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(
					200,
					configOf(['consent_banner', 'google_tags', 'meta_pixel'], {
						tags: { consentRequired: false },
						google_tags: { ga4Id: 'G-ABCD12', gtmId: 'GTM-ABCD1', ga4ViaGtm: true },
						meta_pixel: { pixelId: '1234567' },
					}),
				),
		});
		const page = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await page.ready;
		// Consent Mode starts granted and every tag loads before any choice; GA4 is left to the container
		expect(w.dataLayer[0]).toEqual(
			expect.objectContaining({ 0: 'consent', 1: 'default', 2: expect.objectContaining({ analytics_storage: 'granted' }) }),
		);
		expect(sources()).toEqual([
			'https://www.googletagmanager.com/gtm.js?id=GTM-ABCD1',
			'https://connect.facebook.net/en_US/fbevents.js',
		]);
		const banner = hostOf('consent_banner');
		expect(inside(banner, '[role="dialog"]').hasAttribute('hidden')).toBe(false);
		// shop events reach the container's dataLayer as GA4 ecommerce events
		window.dispatchEvent(
			new window.CustomEvent('ss:purchase', {
				detail: { orderId: 'o1', currency: 'USD', value: 2500, items: [{ id: 'p1', price: 1250, quantity: 2 }] },
			}),
		);
		expect(w.dataLayer).toContainEqual({ ecommerce: null });
		expect(w.dataLayer).toContainEqual({
			event: 'purchase',
			ecommerce: expect.objectContaining({ transaction_id: 'o1', value: 25, currency: 'USD' }),
		});
		// a refusal the visitor makes is followed: Consent Mode denied, and the next page loads nothing
		button(banner, strings['consent.rejectAll']).click();
		expect(w.dataLayer.at(-1)).toEqual(
			expect.objectContaining({ 0: 'consent', 1: 'update', 2: expect.objectContaining({ ad_storage: 'denied' }) }),
		);
		document.head.replaceChildren();
		document.body.replaceChildren();
		delete w.dataLayer;
		delete w.gtag;
		delete w.fbq;
		const next = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await next.ready;
		expect(sources()).toEqual([]);
	});

	it('G2: searches and contacts reach the pixels, with variant ids when the merchant picks them', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		window.history.replaceState(null, '', '/search?q=Blue+case');
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(
					200,
					configOf(['visitor_analytics', 'searches_404s', 'meta_pixel', 'google_tags', 'tiktok_pixel'], {
						tags: { consentRequired: false },
						pixels: { contentIds: 'variant' },
						visitor_analytics: { requireConsent: false },
						meta_pixel: { pixelId: '1234567' },
						google_tags: { ga4Id: 'G-ABCD12' },
						tiktok_pixel: { pixelId: 'CABCDEFGHIJ12' },
					}),
				),
			'POST /v1/collect': () => answer(202),
		});
		const page = startWidget({ window, script: script('t') });
		// a search the page dispatches before the config is there waits for it
		window.dispatchEvent(new window.CustomEvent('ss:search', { detail: { term: '  red   phone ', results: 3 } }));
		await vi.advanceTimersByTimeAsync(0);
		await page.ready;
		w.ttq.track = vi.fn();
		window.dispatchEvent(new window.CustomEvent('ss:contact', { detail: { method: 'WhatsApp' } }));
		w[WIDGET_GLOBAL].contact();
		w[WIDGET_GLOBAL].search('cables', { results: 0 });
		window.dispatchEvent(new window.CustomEvent('ss:search', { detail: { term: '' } }));
		window.dispatchEvent(
			new window.CustomEvent('ss:view_item', {
				detail: { currency: 'USD', value: 1250, items: [{ id: 'prd_1', variantId: 'var_9', price: 1250 }, { id: 'prd_2' }] },
			}),
		);
		const meta = w.fbq.queue.map((/** @type {unknown[]} */ call) => call.slice(1, 3));
		expect(meta).toEqual(
			expect.arrayContaining([
				['Search', { search_string: 'Blue case' }],
				['Search', { search_string: 'red phone' }],
				['Contact', { method: 'whatsapp' }],
				['Contact', {}],
				['Search', { search_string: 'cables' }],
			]),
		);
		expect(meta).toContainEqual(['ViewContent', expect.objectContaining({ content_ids: ['var_9', 'prd_2'] })]);
		const google = [...w.dataLayer].filter((entry) => entry[0] === 'event').map((entry) => [entry[1], entry[2]]);
		expect(google).toEqual(
			expect.arrayContaining([
				['search', { search_term: 'red phone' }],
				['generate_lead', { method: 'whatsapp' }],
				['view_item', expect.objectContaining({ items: [expect.objectContaining({ item_id: 'var_9' }), expect.anything()] })],
			]),
		);
		expect(w.ttq.track).toHaveBeenCalledWith('Contact', { method: 'whatsapp' });
		expect(w.ttq.track).toHaveBeenCalledWith('Search', { query: 'cables' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(collected().filter((event) => event.type === 'search')).toEqual([
			{ type: 'search', path: '/search', term: 'Blue case' },
			{ type: 'search', path: '/search', term: 'red phone', results: 3 },
			{ type: 'search', path: '/search', term: 'cables', results: 0 },
		]);
	});

	it('G6: the notice bar closes for the page only and stays off the pages it hides on', async () => {
		window.history.replaceState(null, '', '/shop');
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(200, configOf(['notice_bar'], { notice_bar: { text: 'Sale', dismissFor: 'page', hideOnPages: ['/'] } })),
		});
		await startWidget({ window, script: script('t') }).ready;
		inside(hostOf('notice_bar'), 'button').click();
		expect(hostOf('notice_bar')).toBeNull();
		expect(window.sessionStorage.getItem(NOTICE_STORAGE_KEY)).toBeNull();
		// the next page shows it again
		await startWidget({ window, script: script('t') }).ready;
		expect(inside(hostOf('notice_bar'), '.notice span').textContent).toBe('Sale');
		// the home page hides it
		loadDocument('/');
		await startWidget({ window, script: script('t') }).ready;
		expect(hostOf('notice_bar')).toBeNull();
	});

	it('G7: Web Vitals also go to Google Analytics 4 when the merchant asks', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(
					200,
					configOf(['visitor_analytics', 'web_vitals', 'google_tags'], {
						tags: { consentRequired: false },
						visitor_analytics: { requireConsent: false },
						web_vitals: { toGa4: true },
						google_tags: { ga4Id: 'G-ABCD12' },
					}),
				),
			'POST /v1/collect': () => answer(202),
		});
		/** @type {any} */
		let take = null;
		w.PerformanceObserver = function Observer(/** @type {any} */ fn) {
			return {
				observe: (/** @type {{ type: string }} */ options) => {
					if (options.type === 'largest-contentful-paint') take = fn;
				},
			};
		};
		const page = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await page.ready;
		take?.({ getEntries: () => [{ startTime: 4200.4 }] });
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new window.Event('visibilitychange'));
		const [lcp] = [...w.dataLayer].filter((entry) => entry[0] === 'event' && entry[1] === 'LCP').map((e) => e[2]);
		expect(lcp).toEqual({
			value: 4200,
			metric_id: expect.stringMatching(/^v1-\d+-[0-9a-f]{13}-LCP$/),
			metric_value: 4200,
			metric_rating: 'poor',
			event_category: 'web-vitals',
			event_label: lcp.metric_id,
			non_interaction: true,
		});
		expect(collected()).toContainEqual({ type: 'vital', path: '/', name: 'LCP', value: 4200.4 });
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		delete w.PerformanceObserver;
	});

	it('G7 without Visitor analytics: Web Vitals go to Google Analytics 4 only, nothing is recorded (SG-27)', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(
					200,
					configOf(['web_vitals', 'google_tags'], {
						tags: { consentRequired: false },
						web_vitals: { toGa4: true },
						google_tags: { ga4Id: 'G-ABCD12' },
					}),
				),
			'POST /v1/collect': () => answer(202),
		});
		/** @type {Record<string, any>} */
		const take = {};
		w.PerformanceObserver = function Observer(/** @type {any} */ fn) {
			return { observe: (/** @type {{ type: string }} */ options) => (take[options.type] = fn) };
		};
		const page = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await page.ready;
		take.paint?.({ getEntries: () => [{ name: 'first-contentful-paint', startTime: 640 }] });
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new window.Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(2000);
		const sent = [...w.dataLayer].filter((entry) => entry[0] === 'event').map((entry) => [entry[1], entry[2].value]);
		expect(sent).toEqual([
			['FCP', 640],
			['CLS', 0],
		]);
		expect(requests.filter((r) => r.path === '/v1/collect')).toEqual([]);
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		delete w.PerformanceObserver;
	});

	it('G3: with the sessions detail every event carries the tab’s session, kept only once events may be sent', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: NOW });
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(
					200,
					configOf(['consent_banner', 'visitor_analytics', 'searches_404s'], {
						visitor_analytics: { detail: 'sessions' },
					}),
				),
			'POST /v1/collect': () => answer(202),
		});
		const first = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await first.ready;
		// nothing is kept before consent
		expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
		w[WIDGET_GLOBAL].consent.set({ analytics: true });
		await vi.advanceTimersByTimeAsync(1000);
		const [view] = collected();
		expect(view).toMatchObject({ type: 'page_view', path: '/', visit: true, page: 1, browser: 'other', os: 'other' });
		expect(view.session).toMatch(/^[0-9a-f]{32}$/);
		expect(view).not.toHaveProperty('gap');

		// the next page of the same tab: the same session, its second page, 40 seconds later
		await vi.advanceTimersByTimeAsync(40_000);
		loadDocument('/missing');
		Object.defineProperty(document, 'referrer', { value: `${window.location.origin}/shop?x=1`, configurable: true });
		const second = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await second.ready;
		w[WIDGET_GLOBAL].notFound();
		window.dispatchEvent(new window.CustomEvent('ss:search', { detail: { term: 'lost' } }));
		await vi.advanceTimersByTimeAsync(1000);
		const latest = collected().filter((event) => event.path === '/missing');
		expect(latest).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'page_view', visit: false, page: 2, gap: 41_000, session: view.session }),
				expect.objectContaining({ type: 'not_found', referrer: '/shop', session: view.session }),
				expect.objectContaining({ type: 'search', term: 'lost', session: view.session }),
			]),
		);
		Object.defineProperty(document, 'referrer', { value: '', configurable: true });

		// after 30 minutes without a page view a new session starts
		await vi.advanceTimersByTimeAsync(31 * 60_000);
		document.body.replaceChildren();
		const third = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await third.ready;
		await vi.advanceTimersByTimeAsync(1000);
		const fresh = collected().at(-1);
		expect(fresh).toMatchObject({ type: 'page_view', visit: true, page: 1 });
		expect(fresh?.session).not.toBe(view.session);
	});
});

describe('single-page apps (SG-4)', () => {
	it('counts each page the app opens itself, its search and its 404, and files the vitals under the loaded page', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: NOW });
		Object.defineProperty(document, 'referrer', { value: 'https://www.google.com/', configurable: true });
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(
					200,
					configOf(['visitor_analytics', 'searches_404s', 'web_vitals', 'meta_pixel'], {
						tags: { consentRequired: false },
						meta_pixel: { pixelId: '1234567' },
						visitor_analytics: { requireConsent: false, detail: 'sessions' },
					}),
				),
			'POST /v1/collect': () => answer(202),
		});
		/** @type {Record<string, any>} */
		const take = {};
		w.PerformanceObserver = function Observer(/** @type {any} */ fn) {
			return { observe: (/** @type {{ type: string }} */ options) => (take[options.type] = fn) };
		};
		const page = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await page.ready;
		take['largest-contentful-paint']?.({ getEntries: () => [{ startTime: 2600 }] });

		await vi.advanceTimersByTimeAsync(5000);
		window.history.pushState({ n: 1 }, '', '/phones');
		expect(window.location.pathname).toBe('/phones');
		// the same page with other filters, and a fragment, are not pages of their own
		window.history.replaceState({ n: 2 }, '', '/phones?brand=x');
		window.history.pushState(null, '', '/phones?brand=x#top');
		window.history.pushState(null, '', '/search?q=Case');
		window.history.pushState(null, '', '/search?q=Case&page=2');
		const marker = document.createElement('meta');
		marker.setAttribute('name', 'ss-growth-page');
		marker.setAttribute('content', 'not_found');
		window.history.pushState(null, '', '/old-phone');
		document.head.append(marker);
		// a redirect inside the app replaces the path: a page of its own
		await vi.advanceTimersByTimeAsync(1000);
		marker.remove();
		window.history.replaceState(null, '', '/phones/new');
		await vi.advanceTimersByTimeAsync(1000);

		const pages = collected().filter((event) => event.type === 'page_view');
		expect(pages.map((event) => [event.path, event.visit, event.page])).toEqual([
			['/', true, 1],
			['/phones', false, 2],
			['/search', false, 3],
			['/search', false, 4],
			['/old-phone', false, 5],
			['/phones/new', false, 6],
		]);
		expect(pages[0]?.referrer).toBe('www.google.com');
		expect(pages[1]).toMatchObject({ gap: 5000 });
		expect(collected().filter((event) => event.type === 'search')).toEqual([
			expect.objectContaining({ path: '/search', term: 'Case' }),
		]);
		expect(collected().filter((event) => event.type === 'not_found')).toEqual([
			expect.objectContaining({ path: '/old-phone', referrer: '/search' }),
		]);
		expect(w.fbq.queue.filter((/** @type {unknown[]} */ call) => call[1] === 'Search')).toEqual([
			['track', 'Search', { search_string: 'Case' }],
		]);

		// back: the page before is counted again
		window.history.replaceState(null, '', '/phones');
		window.dispatchEvent(new window.PopStateEvent('popstate'));
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new window.Event('visibilitychange'));
		expect(
			collected()
				.filter((event) => event.type === 'page_view')
				.at(-1),
		).toMatchObject({ path: '/phones', page: 7 });
		expect(collected().filter((event) => event.type === 'vital')).toEqual([
			expect.objectContaining({ path: '/', name: 'LCP', value: 2600 }),
		]);
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		Object.defineProperty(document, 'referrer', { value: '', configurable: true });
		delete w.PerformanceObserver;
	});

	it('a new visit started inside the app comes from the website itself', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: NOW });
		Object.defineProperty(document, 'referrer', { value: 'https://www.google.com/', configurable: true });
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(200, configOf(['visitor_analytics'], { visitor_analytics: { requireConsent: false } })),
			'POST /v1/collect': () => answer(202),
		});
		const page = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await page.ready;
		await vi.advanceTimersByTimeAsync(31 * 60_000);
		window.history.pushState(null, '', '/later?utm_source=mail');
		await vi.advanceTimersByTimeAsync(1000);
		expect(collected().at(-1)).toMatchObject({
			type: 'page_view',
			path: '/later',
			visit: true,
			referrer: 'localhost',
			campaign: { source: 'mail', medium: '', name: '' },
		});
		Object.defineProperty(document, 'referrer', { value: '', configurable: true });
	});

	it('the notice bar follows the app’s pages: off the pages it hides on, back after a page it was closed on', async () => {
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(
					200,
					configOf(['notice_bar'], { notice_bar: { text: 'Sale', dismissFor: 'page', hideOnPages: ['/checkout/**'] } }),
				),
		});
		await startWidget({ window, script: script('t') }).ready;
		const host = hostOf('notice_bar');
		expect(inside(host, '.notice span').textContent).toBe('Sale');
		window.history.pushState(null, '', '/checkout/pay');
		expect(host.shadowRoot?.querySelector('.notice')).toBeNull();
		window.history.pushState(null, '', '/shop');
		expect(inside(hostOf('notice_bar'), '.notice span').textContent).toBe('Sale');
		inside(hostOf('notice_bar'), 'button').click();
		expect(hostOf('notice_bar')).toBeNull();
		window.history.pushState(null, '', '/shop/phones');
		expect(inside(hostOf('notice_bar'), '.notice span').textContent).toBe('Sale');
	});

	it('only the page script the page has now follows its navigations, and never breaks them', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(200, configOf(['visitor_analytics'], { visitor_analytics: { requireConsent: false } })),
			'POST /v1/collect': () => answer(202),
		});
		const first = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await first.ready;
		const second = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await second.ready;
		await vi.advanceTimersByTimeAsync(1000);
		window.history.pushState(null, '', '/next');
		await vi.advanceTimersByTimeAsync(1000);
		expect(collected().filter((event) => event.path === '/next')).toHaveLength(1);
		const broken = vi.spyOn(window.Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		window.history.pushState(null, '', '/after');
		expect(window.location.pathname).toBe('/after');
		broken.mockRestore();
		await vi.advanceTimersByTimeAsync(1000);
		expect(collected().filter((event) => event.path === '/after')).toEqual([]);
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

	it('keeps a session in memory when the browser refuses storage, and makes random ids without crypto (G3)', () => {
		let t = NOW;
		const refusing = {
			getItem: () => '{broken',
			setItem: () => {
				throw new Error('full');
			},
		};
		let n = 0;
		const session = createSession({
			visits: refusing,
			now: () => t,
			random: () => `id${(n += 1)}`.padEnd(8, '0'),
			userAgent: '',
		});
		expect(session.stamp()).toEqual({ session: 'id100000', browser: 'other', os: 'other' });
		expect(session.view()).toEqual({ visit: true, page: 1, gap: null });
		t += 5000;
		expect(session.view()).toEqual({ visit: false, page: 2, gap: 5000 });
		expect(session.stamp().session).toBe('id100000');
		expect(randomId(/** @type {any} */ ({}))).toMatch(/^[0-9a-f]{32}$/);
		expect(cameFrom(/** @type {any} */ ({ document: { referrer: '' }, location: window.location }))).toBeNull();
		expect(cameFrom(/** @type {any} */ ({ document: { referrer: 'https://www.bing.com/x' }, location: window.location }))).toBe(
			'www.bing.com',
		);
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

	it('follows navigations with the history the browser has', () => {
		const location = { href: 'https://shop.example.com/a' };
		/** @type {Record<string, () => void>} */
		const listeners = {};
		const fakeWindow = /** @type {any} */ ({
			location,
			history: {
				pushState: (/** @type {unknown} */ _state, /** @type {string} */ _title, /** @type {string} */ url) =>
					(location.href = url),
			},
			addEventListener: (/** @type {string} */ name, /** @type {() => void} */ fn) => (listeners[name] = fn),
		});
		/** @type {string[]} */
		const changes = [];
		watchNavigation({ window: fakeWindow, change: (from) => changes.push(from.pathname) });
		expect(fakeWindow.history.replaceState).toBeUndefined();
		fakeWindow.history.pushState(null, '', 'https://shop.example.com/b');
		location.href = 'https://shop.example.com/c';
		listeners.popstate?.();
		expect(changes).toEqual(['/a', '/b']);
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
		watchVitals({ window: fakeWindow, report: (vitals) => reported.push(...vitals) });
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
			['INP', 80],
			['CLS', 50],
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

	it('measures Web Vitals by web.dev’s rules: CLS session windows, INP near the 98th percentile, hidden and prerendered pages (SG-26)', () => {
		/** @type {Record<string, (list: { getEntries: () => any[] }) => void>} */
		const observers = {};
		/** @type {Record<string, any[]>} entries the browser has not delivered yet */
		const waiting = {};
		/** @type {Record<string, (event?: any) => void>} */
		const listeners = {};
		/** @param {string} visibility @param {number} [interactionCount] @param {any} [navigation] */
		const page = (visibility, interactionCount, navigation = { responseStart: 300, activationStart: 100 }) =>
			/** @type {any} */ ({
				document: {
					visibilityState: visibility,
					addEventListener: (/** @type {string} */ name, /** @type {() => void} */ fn) => (listeners[name] = fn),
				},
				addEventListener: (/** @type {string} */ name, /** @type {() => void} */ fn) => (listeners[name] = fn),
				performance: { getEntriesByType: () => [navigation], ...(interactionCount ? { interactionCount } : {}) },
				PerformanceObserver: function Observer(/** @type {any} */ take) {
					/** @type {string} */
					let type = '';
					return {
						observe: (/** @type {{ type: string }} */ options) => {
							type = options.type;
							observers[type] = take;
						},
						takeRecords: () => (waiting[type] ?? []).splice(0),
					};
				},
			});
		/** @type {Array<[string, number]>} */
		let reported = [];
		const shown = page('visible', 120);
		watchVitals({ window: shown, report: (vitals) => (reported = vitals) });
		observers.paint?.({ getEntries: () => [{ name: 'first-contentful-paint', startTime: 900 }] });
		// two bursts of shifts: 0.04 + 0.05 within one window, 0.06 alone later; the largest window counts
		observers['layout-shift']?.({
			getEntries: () => [
				{ value: 0.04, startTime: 1000, hadRecentInput: false },
				{ value: 0.05, startTime: 1800, hadRecentInput: false },
				{ value: 0.06, startTime: 9000, hadRecentInput: false },
				{ value: 0.5, startTime: 9100, hadRecentInput: true },
			],
		});
		// 12 interactions of 100 to 1200 ms (one with two events), 120 in all: two of the longest are passed over
		observers.event?.({
			getEntries: () =>
				Array.from({ length: 12 }, (_, i) => ({ interactionId: 7 * (i + 1), duration: 100 * (i + 1) })).concat([
					{ interactionId: 7, duration: 150 },
				]),
		});
		observers['first-input']?.({ getEntries: () => [{ interactionId: 0, duration: 5000 }] });
		// a paint the browser had not delivered when the page was hidden, and one after it
		waiting['largest-contentful-paint'] = [{ startTime: 2100 }];
		listeners.visibilitychange?.({ timeStamp: 5000 });
		expect(reported).toEqual([]);
		shown.document.visibilityState = 'hidden';
		listeners.visibilitychange?.({ timeStamp: 5000 });
		expect(Object.fromEntries(reported)).toEqual({ TTFB: 200, FCP: 800, LCP: 2000, INP: 1000, CLS: 90 });

		// a page that painted without shifting has a CLS of 0; a page loaded in the background reports no paints
		const background = page('hidden', undefined, { responseStart: 0 });
		watchVitals({ window: background, report: (vitals) => (reported = vitals) });
		observers.paint?.({ getEntries: () => [{ name: 'first-contentful-paint', startTime: 400 }] });
		observers['largest-contentful-paint']?.({ getEntries: () => [{ startTime: 600 }] });
		observers.event?.({ getEntries: () => [{ interactionId: 21, duration: 64 }] });
		listeners.pagehide?.({ timeStamp: 0 });
		expect(Object.fromEntries(reported)).toEqual({ INP: 64 });
		const painted = page('visible');
		watchVitals({ window: painted, report: (vitals) => (reported = vitals) });
		observers.paint?.({ getEntries: () => [{ name: 'first-contentful-paint', startTime: 400 }] });
		painted.document.visibilityState = 'hidden';
		listeners.pagehide?.({});
		expect(Object.fromEntries(reported)).toEqual({ TTFB: 200, FCP: 300, CLS: 0 });
	});

	it('records Web Vitals through the page script', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		serve({
			[`GET ${CONFIG_PATH}`]: () =>
				answer(200, configOf(['visitor_analytics', 'web_vitals'], { visitor_analytics: { requireConsent: false } })),
			'POST /v1/collect': () => answer(202),
		});
		/** @type {Record<string, any>} */
		const take = {};
		w.PerformanceObserver = function Observer(/** @type {any} */ fn) {
			return {
				observe: (/** @type {{ type: string }} */ options) => {
					take[options.type] = fn;
				},
			};
		};
		const page = startWidget({ window, script: script('t') });
		await vi.advanceTimersByTimeAsync(0);
		await page.ready;
		take.paint?.({ getEntries: () => [{ name: 'first-contentful-paint', startTime: 700 }] });
		take['largest-contentful-paint']?.({ getEntries: () => [{ startTime: 1200 }] });
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new window.Event('visibilitychange'));
		expect(collected()).toContainEqual({ type: 'vital', path: '/', name: 'FCP', value: 700 });
		// the page view and the page's vitals in one batch (RT-2)
		expect(requests.filter((r) => r.path === '/v1/collect')).toHaveLength(1);
		// FCP, LCP and a CLS of 0 (the page painted without shifting)
		expect(collected().map((event) => event.type)).toEqual(['page_view', 'vital', 'vital', 'vital']);
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
		pages: Array.from({ length: 8 }, (_, i) => ({ key: i === 0 ? '/' : `/p${i}`, count: 9 - i })),
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
		detail: 'anonymous',
		sessions: null,
		browsers: null,
		systems: null,
		cities: null,
		live: null,
		journeys: null,
		notFoundFrom: null,
		vitalPages: null,
	};
	const SESSIONS_EMPTY = {
		detail: 'sessions',
		sessions: { count: 0, bounces: 0, bounceRate: null, averageDuration: null, pagesPerSession: null },
		browsers: [],
		systems: [],
		cities: [],
		live: { visitors: 0, pages: [] },
		journeys: [],
	};
	const SESSIONS_REPORT = {
		...REPORT,
		funnel: null,
		detail: 'sessions',
		sessions: { count: 2, bounces: 1, bounceRate: 50, averageDuration: 65, pagesPerSession: 1.5 },
		browsers: [{ key: 'samsung', count: 2 }],
		systems: [{ key: 'other', count: 2 }],
		cities: [{ key: 'Lahore, PK', count: 2 }],
		live: { visitors: 1, pages: [{ key: '/shop', count: 1 }] },
		notFoundFrom: [{ path: '/old', from: '/shop', count: 1 }],
		vitalPages: [{ path: '/shop', samples: 2, averages: { LCP: 4100, INP: null, CLS: 50, FCP: null, TTFB: null } }],
		journeys: [
			{
				session: 'sess_1234567890',
				startedAt: '2026-10-02T09:00:00.000Z',
				endedAt: '2026-10-02T09:01:05.000Z',
				duration: 65,
				events: 3,
				pages: 2,
				device: 'mobile',
				browser: 'chrome',
				os: 'android',
				country: 'PK',
				city: 'Lahore',
				source: '(direct)',
				steps: [
					{ type: 'page_view', path: '/', at: '2026-10-02T09:00:00.000Z' },
					{ type: 'search', path: '/shop', at: '2026-10-02T09:00:30.000Z', term: 'cases' },
					{ type: 'purchase', path: '/cart', at: '2026-10-02T09:01:05.000Z', value: 2500, currency: 'USD' },
				],
			},
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

	/** @param {HTMLElement} host @param {string} text the start of a button's words (chips add their count) */
	const press = (host, text) => {
		const found = [...(host.shadowRoot?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.startsWith(text));
		if (!found) throw new Error(`no button ${text}`);
		found.click();
	};
	/** @param {HTMLElement} host */
	const dialog = (host) => inside(host, '.dialog');
	const EVENTS = {
		'GET /v1/admin/events/counts': () => answer(200, { total: 3, groups: { page_view: 2, purchase: 1 } }),
		'GET /v1/admin/events': (/** @type {any} */ _init, /** @type {URL} */ url) =>
			answer(200, {
				items: [
					{
						id: url.searchParams.get('cursor') ? 'evt_3' : 'evt_1',
						type: url.searchParams.get('type') ?? 'purchase',
						path: '/cart',
						at: '2026-10-02T09:00:00.000Z',
						expiresAt: '2027-11-02T09:00:00.000Z',
						data: { value: 2500, currency: 'USD' },
						session: url.searchParams.get('session') ?? undefined,
						browser: 'chrome',
						os: 'android',
						city: 'Lahore',
					},
				],
				hasMore: !url.searchParams.get('cursor'),
				nextCursor: 'next',
			}),
	};

	it('the analytics dashboard: hero, tiles, ranked cards with See all, range chips, a custom range and the event log', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const host = place('analytics_dashboard');
		/** @type {URL[]} */
		const asked = [];
		let fail = false;
		await startAdmin(['visitor_analytics', 'conversion_funnel', 'searches_404s', 'web_vitals'], {
			'GET /v1/admin/analytics': (init, url) => {
				expect(init.headers.authorization).toBe('Bearer ticket-1');
				asked.push(url);
				return fail ? answer(422, { detail: 'Bad days.' }) : answer(200, REPORT);
			},
			...EVENTS,
		});
		expect(asked[0]?.searchParams.get('from')).toBe('2026-09-09');
		expect(asked[0]?.searchParams.get('to')).toBe('2026-10-08');
		expect(asked[0]?.searchParams.get('top')).toBe('50');
		const text = () => host.shadowRoot?.textContent ?? '';
		expect(inside(host, '.hero .value').textContent).toBe('3');
		expect(host.shadowRoot?.querySelectorAll('.bars span')).toHaveLength(2);
		for (const words of [
			'Direct',
			'Phones',
			'Unknown',
			'Purchased',
			'USD 25',
			'1 orders',
			'Pages not found (404)',
			'1800 ms',
			'0.30',
			'—',
			'50 % of the step before',
		])
			expect(text()).toContain(words);
		expect(text()).toContain('Days are in the UTC time zone.');
		expect(text()).not.toContain(strings['analytics.journeys']);
		// a long list shows its first rows and the rest in a dialog
		press(host, 'See all 8');
		expect(dialog(host).querySelectorAll('ul.rank li')).toHaveLength(8);
		press(host, strings['analytics.close']);
		expect(dialog(host)).toBeNull();
		// a range chip asks for its days
		press(host, strings['analytics.range.7d']);
		await flush();
		expect(asked.at(-1)?.searchParams.get('from')).toBe('2026-10-02');
		press(host, strings['analytics.range.lastMonth']);
		await flush();
		expect([asked.at(-1)?.searchParams.get('from'), asked.at(-1)?.searchParams.get('to')]).toEqual([
			'2026-09-01',
			'2026-09-30',
		]);
		// the More menu: a custom range whose error stays in the dialog, then Refresh
		press(host, '⋯');
		press(host, strings['analytics.custom']);
		const [from, to] = dialog(host).querySelectorAll('input');
		from.value = '2026-08-01';
		to.value = '2026-08-03';
		fail = true;
		dialog(host).dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(dialog(host).querySelector('[role="status"]').textContent).toBe(`${strings['analytics.failed']} Bad days.`);
		fail = false;
		dialog(host).dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(dialog(host)).toBeNull();
		expect(asked.at(-1)?.searchParams.get('from')).toBe('2026-08-01');
		expect(host.shadowRoot?.querySelector('.head + .chips .chip[aria-pressed="true"]')).toBeNull();
		fail = true;
		press(host, '⋯');
		press(host, strings['analytics.refresh']);
		await flush();
		expect(inside(host, '[role="status"]').textContent).toBe(`${strings['analytics.failed']} Bad days.`);
		// the event log: chips with counts, Load more, and an event's fields in a dialog
		const chips = [...(host.shadowRoot?.querySelectorAll('.section:last-child .chip') ?? [])].map((c) => c.textContent);
		expect(chips).toEqual(['All3', 'Viewed a page2', 'Purchased1']);
		expect(text()).toContain('Purchased · /cart');
		press(host, strings['analytics.loadMore']);
		await flush();
		expect(host.shadowRoot?.querySelectorAll('.section:last-child ul.rows li')).toHaveLength(2);
		press(host, 'Viewed a page');
		await flush();
		const row = /** @type {HTMLElement} */ (host.shadowRoot?.querySelector('.section:last-child ul.rows li'));
		expect(row.textContent).toContain('Viewed a page · /cart');
		row.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
		expect(dialog(host).textContent).toContain('evt_1');
		expect(dialog(host).textContent).toContain('Chrome · Android · Lahore');
		dialog(host).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(dialog(host)).toBeNull();
	});

	it('the analytics dashboard with sessions: live visitors, session tiles, journeys and every event of a visit', async () => {
		const host = place('analytics_dashboard');
		/** @type {string[]} */
		const sessionsAsked = [];
		await startAdmin(['visitor_analytics', 'searches_404s', 'web_vitals'], {
			'GET /v1/admin/analytics': () => answer(200, SESSIONS_REPORT),
			...EVENTS,
			'GET /v1/admin/events': (init, url) => {
				sessionsAsked.push(url.searchParams.get('session') ?? '');
				return EVENTS['GET /v1/admin/events'](init, url);
			},
		});
		const text = host.shadowRoot?.textContent ?? '';
		for (const words of [
			'Visitors now',
			'/shop',
			'Bounce rate',
			'50 %',
			'1 min 5 s',
			'1.5',
			'Samsung Internet',
			'Other systems',
			'Lahore, PK',
			'Slowest pages',
			'4100 ms',
			'CLS 0.05',
			'from /shop',
			'2 pages · Phones · Chrome · Lahore, PK · Direct',
		])
			expect(text).toContain(words);
		expect(inside(host, '.pulse').classList.contains('idle')).toBe(false);
		const journey = /** @type {HTMLElement} */ (host.shadowRoot?.querySelector('.section ul.rows.card li'));
		journey.click();
		expect(dialog(host).textContent).toContain('sess_1234567890');
		expect([...dialog(host).querySelectorAll('ol.timeline li')].map((li) => li.textContent)).toEqual([
			expect.stringContaining('Viewed a page /'),
			expect.stringContaining('Searched /shop'),
			expect.stringContaining('USD 25'),
		]);
		press(host, strings['analytics.allEvents']);
		await flush();
		expect(sessionsAsked.at(-1)).toBe('sess_1234567890');
		expect(dialog(host).querySelectorAll('ul.rows li')).toHaveLength(1);
		press(host, strings['analytics.close']);
		journey.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ' }));
		expect(dialog(host)).not.toBeNull();
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
				...EVENTS,
				'POST /v1/admin/seo/checks': () =>
					answer(200, {
						checkedAt: '2026-10-08T12:00:00.000Z',
						summary: { pass: 0, warn: 0, fail: 0 },
						checks: [],
						pages: [],
					}),
			},
			look,
		);
		expect(asked[0]?.searchParams.get('from')).toBe('2026-09-10');
		expect(asked[0]?.searchParams.get('to')).toBe('2026-10-09');
		const text = dashboard.shadowRoot?.textContent ?? '';
		expect(text).toContain('Rs 25');
		expect(text).not.toContain('USD');
		expect(text).toContain('1 Oct 2026 – 2 Oct 2026 · Days are in the Asia/Karachi time zone.');
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
					...SESSIONS_EMPTY,
				}),
			'GET /v1/admin/events/counts': () => answer(500),
			'GET /v1/admin/events': () => answer(200, { items: [], hasMore: false }),
		});
		const text = host.shadowRoot?.textContent ?? '';
		for (const words of [
			strings['analytics.empty'],
			strings['analytics.none'],
			strings['analytics.liveNone'],
			strings['analytics.noJourneys'],
			strings['analytics.noEvents'],
		])
			expect(text).toContain(words);
		expect(inside(host, '.pulse').classList.contains('idle')).toBe(true);
		vi.spyOn(window, 'fetch').mockImplementation(async () => answer(500));
		press(host, strings['analytics.range.today']);
		await flush();
		expect(inside(host, '[role="status"]').textContent).toBe(strings['analytics.failed']);
	});

	it('the SEO checklist: tiles, filter chips, page cards with their More menu, other pages, and IndexNow', async () => {
		const host = place('seo_checklist');
		/** @type {any[]} */
		const submitted = [];
		/** @type {any[]} */
		const checked = [];
		/** @type {string[]} */
		const opened = [];
		let refuse = false;
		const page = 'https://shop.example.com/';
		const shop = 'https://shop.example.com/shop';
		w.open = (/** @type {string} */ url) => opened.push(url);
		serve({
			[`GET ${ADMIN_CONFIG_PATH}`]: () =>
				answer(200, {
					...configOf(['seo_checklist', 'indexnow']),
					settings: {
						...configOf(['seo_checklist', 'indexnow']).settings,
						admin: {
							seoPages: ['/', '/shop'],
							indexNow: { keySet: true, keyLocation: 'https://shop.example.com/indexnow-key.txt' },
							detail: 'anonymous',
							retentionMonths: 13,
						},
					},
				}),
			'POST /v1/admin/seo/checks': (init) => {
				checked.push(JSON.parse(init.body));
				return answer(200, {
					checkedAt: '2026-10-08T12:00:00.000Z',
					summary: { pass: 2, warn: 1, fail: 1 },
					pages: [page, shop],
					checks: [
						{ id: 'title', status: 'pass', page, title: 'Page title', fix: '' },
						{ id: 'verification', status: 'pass', page, title: 'Search engine verification', fix: '' },
						{ id: 'description', status: 'warn', page: shop, title: 'Meta description', fix: 'Write one.' },
						{
							id: 'robots_blocks',
							status: 'fail',
							page: null,
							title: 'robots.txt lets search engines in',
							fix: 'Remove it.',
						},
					],
				});
			},
			'POST /v1/admin/indexnow': (init) => {
				submitted.push(JSON.parse(init.body));
				return refuse ? answer(502, { detail: 'IndexNow answered 500.' }) : answer(200, { submitted: 2 });
			},
		});
		let tickets = 0;
		await startWidget({ window, script: script(null) }).admin({
			getTicket: async () => ({ ticket: `t${(tickets += 1)}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }),
		});
		await flush();
		const text = () => host.shadowRoot?.textContent ?? '';
		expect(text()).toContain('Checks 2 pages: /, /shop');
		expect(text()).toContain(strings['seo.notRun']);
		expect(text()).toContain('Your site must serve your key at https://shop.example.com/indexnow-key.txt.');
		button(host, strings['seo.run']).click();
		await flush();
		expect(checked[0]).toEqual({});
		expect([...(host.shadowRoot?.querySelectorAll('.tile .value') ?? [])].map((v) => v.textContent)).toEqual(['1', '1', '2']);
		const cards = () => [...(host.shadowRoot?.querySelectorAll('.masonry .card h4') ?? [])].map((h) => h.textContent);
		expect(cards()).toEqual(['Whole site', '/', '/shop']);
		const site = /** @type {HTMLElement} */ (host.shadowRoot?.querySelector('.masonry .card'));
		expect(site.textContent).toContain('Fix');
		expect(site.textContent).toContain('Remove it.');
		expect(site.textContent).toContain('Search engine verification');
		press(host, 'Improve');
		expect(cards()).toEqual(['/shop']);
		press(host, 'All');
		// a page's More menu: open it, check it again, submit it
		const shopCard = /** @type {HTMLElement} */ ([...(host.shadowRoot?.querySelectorAll('.masonry .card') ?? [])][2]);
		/** @param {string} words */
		const menuItem = (words) =>
			/** @type {HTMLButtonElement} */ (
				[...shopCard.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === words)
			);
		/** @type {HTMLButtonElement} */ (shopCard.querySelector('.more > button')).click();
		menuItem(strings['seo.openPage']).click();
		expect(opened).toEqual([shop]);
		menuItem(strings['seo.submitPage']).click();
		expect(dialog(host).querySelector('textarea').value).toBe(shop);
		dialog(host).dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(submitted).toEqual([{ urls: [shop] }]);
		expect(text()).toContain('Submitted 2 addresses.');
		menuItem(strings['seo.checkAgain']).click();
		await flush();
		expect(checked.at(-1)).toEqual({ paths: ['/shop'] });
		// other pages from the header's More menu
		press(host, '⋯');
		press(host, strings['seo.otherPages']);
		const paths = dialog(host).querySelector('textarea');
		expect(paths.value).toBe('/\n/shop');
		paths.value = '/a\n /b ';
		dialog(host).dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(checked.at(-1)).toEqual({ paths: ['/a', '/b'] });
		// the IndexNow card's dialog, refused
		refuse = true;
		press(host, strings['indexnow.open']);
		const urls = dialog(host).querySelector('textarea');
		urls.value = 'https://shop.example.com/a\nhttps://shop.example.com/b ';
		dialog(host).dispatchEvent(new window.Event('submit', { cancelable: true }));
		await flush();
		expect(submitted.at(-1)).toEqual({ urls: ['https://shop.example.com/a', 'https://shop.example.com/b'] });
		expect(dialog(host).querySelector('[role="status"]').textContent).toBe('Not submitted: IndexNow answered 500.');
		press(host, strings['seo.cancel']);
		delete w.open;
	});

	it('IndexNow alone, before a key is set or with a broken key path', async () => {
		const host = place('seo_checklist');
		/** @param {any} indexNow */
		const configWith = (indexNow) => ({
			...configOf(['indexnow']),
			settings: {
				...configOf(['indexnow']).settings,
				admin: { seoPages: ['/'], indexNow, detail: 'anonymous', retentionMonths: 13 },
			},
		});
		serve({ [`GET ${ADMIN_CONFIG_PATH}`]: () => answer(200, configWith({ keySet: false, keyLocation: null })) });
		const getTicket = async () => ({ ticket: 't', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
		await startWidget({ window, script: script(null) }).admin({ getTicket });
		await flush();
		expect(host.shadowRoot?.textContent).toContain(strings['indexnow.noKey']);
		expect(button(host, strings['seo.run'])).toBeUndefined();
		document.body.replaceChildren();
		const again = place('seo_checklist');
		serve({ [`GET ${ADMIN_CONFIG_PATH}`]: () => answer(200, configWith({ keySet: true, keyLocation: null })) });
		await startWidget({ window, script: script(null) }).admin({ getTicket });
		await flush();
		expect(again.shadowRoot?.textContent).toContain(strings['indexnow.badPath']);
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
		expect(host.shadowRoot?.textContent).not.toContain(strings['indexnow.title']);
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
		inside(host, '.chip').click();
		await vi.advanceTimersByTimeAsync(0);
		expect(inside(host, '[role="status"]').textContent).toBe(strings['analytics.signedOut']);
	});
});
