/**
 * Growth's options (PLAN 0.8.10 G1–G7) pass the jsdom test with the real page script. Growth runs against the REAL
 * Portal; the merchant's server sets every option through the settings API (K1, with an acting user), then a visitor's
 * browser (jsdom, the real `@ss/product-growth/page-script`, the Portal-issued browser token) loads a page: tags
 * without a consent step and GA4 left to Tag Manager (G1), search, contact and variant ids at the pixels (G2), sessions
 * with their journey, live visitors and the event log through a ticket (G3), the AI crawler block and the Yandex tag
 * (G4), the IndexNow key file at its own path (G5), the notice bar closed per page, hidden on pages and read by custom
 * UIs (G6), and Web Vitals to Google Analytics (G7).
 */
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProductInstance, manifest, strings } from '@ss/product-growth/product';
import { createRoutes } from '@ss/product-growth/routes';
import { startWidget } from '@ss/product-growth/page-script';
import { startSystem } from './helpers.js';

const GROWTH = 'https://growth.test';
const DOMAIN = 'opts.example.com';
const PAGE = 'http://localhost:3000';
const ADMIN_ORIGIN = 'https://admin.opts.example.com';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

/** What IndexNow was sent. @type {Array<any>} */
const indexNow = [];

/** @type {import('./helpers.js').System} */
let sys;
let websiteId = '';
/** @type {{ browser: string, server: string }} */
let tokens;
/** @type {import('mongodb').Db} */
let merchantDb;

beforeAll(async () => {
	sys = await startSystem({
		unit: {
			createProductInstance,
			createRoutes,
			manifest,
			strings,
			url: GROWTH,
			handlers: {
				'https://api.indexnow.org': async (/** @type {Request} */ request) => {
					indexNow.push(await request.json());
					return new Response(null, { status: 202 });
				},
			},
		},
	});
	await sys.connect();
	const m = await sys.merchant('opts@shop.test', [DOMAIN]);
	websiteId = m.websiteIds[0] ?? '';
	await sys.addProduct(m.merchantId, websiteId);
	await sys.addCredits(m.merchantId, 100);
	tokens = await sys.tokens(m.merchantId, websiteId);
	const support = await sys.admin('support');
	await sys.switchFeatures(
		await sys.adminSession(support.client, websiteId),
		websiteId,
		manifest.features.map((feature) => feature.key),
	);
	merchantDb = await sys.connectDatabase(await sys.adminSession(await sys.owner(), websiteId), websiteId);
});
afterAll(async () => {
	await sys?.stop();
});

/**
 * Save one setting from the merchant's server (K1), as a member of its staff (K2).
 * @param {string} key `<feature or group>.<setting>` @param {unknown} value
 */
const setting = async (key, value) => {
	const saved = await sys.call('PUT', `/v1/settings/${key}`, {
		token: tokens.server,
		body: { value },
		headers: { 'SS-Actor-Id': 'u_7', 'SS-Actor-Name': 'Mina%20Manager' },
	});
	expect(saved.status, `${key}: ${JSON.stringify(saved.json)}`).toBe(200);
	return saved.json;
};

/**
 * A visitor's browser on a local page of the website: its fetch reaches Growth through the system with the page's
 * Origin and the host's location headers; a fake PerformanceObserver gives the page its largest paint.
 * @param {string} path
 * @param {{ storage?: Record<string, string>, lcp?: number }} [options] what the browser kept from earlier pages
 */
const openPage = (path, { storage = {}, lcp } = {}) => {
	const dom = new JSDOM('<!doctype html><html><head></head><body><h1>Shop</h1></body></html>', {
		url: `${PAGE}${path}`,
		pretendToBeVisual: true,
	});
	const win = /** @type {any} */ (dom.window);
	Object.defineProperty(win.navigator, 'userAgent', { value: ANDROID_CHROME });
	/** @type {string[]} */
	const answers = [];
	win.fetch = async (/** @type {string} */ input, /** @type {RequestInit} */ init = {}) => {
		const url = new URL(input);
		const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
		const res = await sys.call(init.method ?? 'GET', `${url.pathname}${url.search}`, {
			token: headers.authorization?.replace('Bearer ', ''),
			origin: PAGE,
			headers: { 'x-vercel-ip-country': 'CA', 'x-vercel-ip-city': 'Toronto' },
			...(typeof init.body === 'string' ? { body: init.body } : {}),
		});
		answers.push(`${url.pathname} ${res.status}`);
		return new Response(res.status === 204 ? null : JSON.stringify(res.json), { status: res.status });
	};
	for (const [key, value] of Object.entries(storage)) win.sessionStorage.setItem(key, value);
	if (lcp !== undefined)
		win.PerformanceObserver = function Observer(/** @type {any} */ take) {
			return {
				observe: (/** @type {{ type: string }} */ options) => {
					if (options.type === 'largest-contentful-paint')
						queueMicrotask(() => take({ getEntries: () => [{ startTime: lcp }] }));
				},
			};
		};
	const script = win.document.createElement('script');
	script.src = `${GROWTH}/widget.js`;
	script.dataset.token = tokens.browser;
	return { win, answers, page: startWidget({ window: win, script }) };
};

/** @param {any} win */
const leave = (win) => {
	Object.defineProperty(win.document, 'visibilityState', { value: 'hidden', configurable: true });
	win.document.dispatchEvent(new win.Event('visibilitychange'));
	win.dispatchEvent(new win.Event('pagehide'));
};

/** @param {() => boolean | Promise<boolean>} done */
const until = async (done) => {
	for (let i = 0; i < 750 && !(await done()); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
};

/** The script addresses in a page head. @param {any} win */
const sources = (win) => [...win.document.head.querySelectorAll('script[src]')].map((s) => s.src);

describe('Growth options with the real page script (PLAN 0.8.10 G1–G7)', () => {
	it('the merchant’s server sets every option through the settings API', async () => {
		await setting('tags.consentRequired', false);
		await setting('pixels.contentIds', 'variant');
		await setting('meta_pixel.pixelId', '123456789');
		await setting('tiktok_pixel.pixelId', 'CABCDEFGHIJ12');
		await setting('google_tags.ga4Id', 'G-ABCD12');
		await setting('google_tags.gtmId', 'GTM-ABCD12');
		await setting('google_tags.ga4ViaGtm', true);
		await setting('visitor_analytics.detail', 'sessions');
		await setting('visitor_analytics.requireConsent', false);
		await setting('web_vitals.toGa4', true);
		await setting('robots_verification.blockAiCrawlers', true);
		await setting('robots_verification.yandexVerification', 'ya-123');
		await setting('indexnow.key', 'key-0123456789');
		await setting('indexnow.keyPath', '/indexnow-key.txt');
		await setting('notice_bar.text', 'Free delivery this week');
		await setting('notice_bar.dismissFor', 'page');
		await setting('notice_bar.hideOnPages', ['/checkout/**']);
		const settings = await sys.call('GET', '/v1/settings', { token: tokens.server });
		const tags = settings.json.features.find((/** @type {any} */ f) => f.key === 'tags');
		expect(tags).toMatchObject({ on: true, values: { consentRequired: { value: false, source: 'website' } } });
	});

	it('G1, G2, G3, G6, G7: one visit in a browser, from the first page to leaving the second', async () => {
		const first = openPage('/shop?q=Blue+tote');
		// Ecommerce's product page announces a variant before the page script has its config
		first.win.dispatchEvent(
			new first.win.CustomEvent('ss:view_item', {
				detail: { currency: 'USD', value: 1250, items: [{ id: 'prd_1', variantId: 'var_1', price: 1250, quantity: 1 }] },
			}),
		);
		await first.page.ready;
		const { win } = first;

		// G1: tags load before any choice, with Consent Mode granted; GA4 is left to the Tag Manager container
		expect(win.dataLayer[0]).toMatchObject({ 0: 'consent', 1: 'default', 2: { analytics_storage: 'granted' } });
		expect(sources(win)).toEqual([
			'https://www.googletagmanager.com/gtm.js?id=GTM-ABCD12',
			'https://connect.facebook.net/en_US/fbevents.js',
			'https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=CABCDEFGHIJ12&lib=ttq',
		]);
		const banner = win.document.querySelector('[data-ss-growth="consent_banner"]');
		expect(banner.shadowRoot.querySelector('[role="dialog"]').hasAttribute('hidden')).toBe(false);

		// G2: the search page, a contact and the variant reach the pixels; GA4 events go to the container's dataLayer
		win.dispatchEvent(new win.CustomEvent('ss:contact', { detail: { method: 'whatsapp' } }));
		win.SSGrowth.search('chargers', { results: 0 });
		const meta = win.fbq.queue.map((/** @type {unknown[]} */ call) => call.slice(1, 3));
		expect(meta).toEqual(
			expect.arrayContaining([
				['ViewContent', expect.objectContaining({ content_ids: ['var_1'] })],
				['Search', { search_string: 'Blue tote' }],
				['Contact', { method: 'whatsapp' }],
				['Search', { search_string: 'chargers' }],
			]),
		);
		expect(win.dataLayer).toContainEqual({
			event: 'view_item',
			ecommerce: expect.objectContaining({ items: [expect.objectContaining({ item_id: 'var_1' })] }),
		});
		expect(win.dataLayer).toContainEqual({ event: 'generate_lead', method: 'whatsapp' });
		expect(
			win.ttq.filter((/** @type {unknown[]} */ call) => call[0] === 'track').map((/** @type {unknown[]} */ call) => call[1]),
		).toEqual(expect.arrayContaining(['ViewContent', 'Search', 'Contact']));

		// G6: the notice bar shows here; closing it holds for this page only
		const bar = win.document.querySelector('[data-ss-growth="notice_bar"]');
		expect(bar.shadowRoot.textContent).toContain('Free delivery this week');
		bar.shadowRoot.querySelector('button').click();
		expect(win.document.querySelector('[data-ss-growth="notice_bar"]')).toBeNull();
		expect(win.sessionStorage.getItem('ss-growth-notice-closed')).toBeNull();

		leave(win);
		await until(() => first.answers.some((answer) => answer === '/v1/collect 202'));
		const session = JSON.parse(win.sessionStorage.getItem('ss-growth-session')).id;
		expect(session).toMatch(/^[0-9a-f]{32}$/);

		// the second page of the same tab: the notice is back, the session goes on, the page's largest paint goes to GA4
		const second = openPage('/bags/blue-tote', {
			storage: Object.fromEntries(
				['ss-growth-session', 'ss-growth-visit'].map((key) => [key, win.sessionStorage.getItem(key)]),
			),
			lcp: 4200,
		});
		await second.page.ready;
		expect(second.win.document.querySelector('[data-ss-growth="notice_bar"]')).not.toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 0));
		leave(second.win);
		// G7: the vital as a GA4 event, through the container
		expect(second.win.dataLayer).toContainEqual(
			expect.objectContaining({
				event: 'LCP',
				value: 4200,
				metric_value: 4200,
				metric_rating: 'poor',
				event_category: 'web-vitals',
				non_interaction: true,
			}),
		);
		await until(async () => (await merchantDb.collection('ss_growth_analytics_events').countDocuments({ type: 'vital' })) > 0);

		// G3: every event carries the session, the browser and system family and the city
		const events = await merchantDb.collection('ss_growth_analytics_events').find({}).toArray();
		expect(events.length).toBeGreaterThanOrEqual(6);
		expect(events.every((event) => event.session === session && event.browser === 'chrome' && event.os === 'android')).toBe(
			true,
		);
		expect(events.every((event) => event.city === 'Toronto')).toBe(true);
		const views = events.filter((event) => event.type === 'page_view').map((event) => event.data);
		expect(views).toEqual([
			expect.objectContaining({ visit: true, page: 1 }),
			expect.objectContaining({ visit: false, page: 2 }),
		]);

		// the analytics dashboard's ticket reads sessions, live visitors, the journey and the visit's events
		const ticket = await sys.call('POST', '/v1/tickets', {
			token: tokens.server,
			body: {
				user: { id: 'u_9', name: 'Ana Admin', email: 'ana@shop.test' },
				permissions: ['analytics.read'],
				origin: ADMIN_ORIGIN,
			},
		});
		const report = await sys.call('GET', '/v1/admin/analytics', { token: ticket.json.ticket, origin: ADMIN_ORIGIN });
		expect(report.json).toMatchObject({
			detail: 'sessions',
			sessions: { count: 1, bounces: 0, bounceRate: 0, pagesPerSession: 2 },
			browsers: [{ key: 'chrome', count: 1 }],
			systems: [{ key: 'android', count: 1 }],
			cities: [{ key: 'Toronto, CA', count: 1 }],
			live: { visitors: 1, pages: [{ key: '/bags/blue-tote', count: 1 }] },
			vitalPages: [{ path: '/bags/blue-tote', averages: { LCP: 4200 } }],
		});
		expect(report.json.journeys).toEqual([
			expect.objectContaining({ session, pages: 2, device: 'desktop', browser: 'chrome', city: 'Toronto', country: 'CA' }),
		]);
		const log = await sys.call('GET', `/v1/admin/events/counts?by=type&session=${session}`, {
			token: ticket.json.ticket,
			origin: ADMIN_ORIGIN,
		});
		expect(log.json.total).toBe(events.length);
		expect(log.json.groups).toMatchObject({ page_view: 2, view_item: 1, search: 2, vital: 1 });

		// G6: custom UIs read the notice, also with a page it is hidden on
		const notice = await sys.call('GET', '/v1/notice?path=/shop', { token: tokens.browser, origin: PAGE });
		expect(notice.json).toEqual({ text: 'Free delivery this week', linkText: '', linkUrl: null, dismissible: true });
		const hidden = await sys.call('GET', '/v1/notice?path=/checkout/pay', { token: tokens.server });
		expect(hidden.json).toBeNull();
		const checkout = openPage('/checkout/pay');
		await checkout.page.ready;
		expect(checkout.win.document.querySelector('[data-ss-growth="notice_bar"]')).toBeNull();
	});

	it('G4 and G5: robots.txt, the verification tags and the IndexNow key file', async () => {
		// a plain-text answer: the helper gives its text
		const text = String((await sys.call('GET', '/v1/robots.txt', { token: tokens.server })).json);
		expect(text).toContain('User-agent: GPTBot\nUser-agent: Google-Extended');
		expect(text).toContain('Disallow: /');
		const tags = await sys.call('GET', '/v1/verification', { token: tokens.server });
		expect(tags.json.tags).toContainEqual({ name: 'yandex-verification', content: 'ya-123' });
		const sent = await sys.call('POST', '/v1/indexnow', {
			token: tokens.server,
			body: { urls: [`https://${DOMAIN}/bags/blue-tote`] },
		});
		expect(sent.json).toEqual({ submitted: 1, status: 202 });
		expect(indexNow.at(-1)).toMatchObject({ host: DOMAIN, keyLocation: `https://${DOMAIN}/indexnow-key.txt` });
	});
});
