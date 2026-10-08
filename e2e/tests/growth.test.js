/**
 * PLAN 0.12 step 11: Growth against the REAL Portal — connect (manifest and price list), price and feature reports,
 * then the real page script (`@ss/product-growth/page-script`) in a browser window (jsdom) on a local page of the
 * website with the Portal-issued browser token: the consent banner asks first and nothing is recorded, the visitor
 * accepts, the page view and Ecommerce's shop events (browser events) are recorded in the merchant database and the
 * daily totals go up; then the analytics dashboard's ticketed read, and the hourly charge.
 */
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProductInstance, manifest, strings } from '@ss/product-growth/product';
import { createRoutes } from '@ss/product-growth/routes';
import { startWidget } from '@ss/product-growth/page-script';
import { HOUR, startSystem } from './helpers.js';

const GROWTH = 'https://growth.test';
const DOMAIN = 'grow.example.com';
const PAGE = 'http://localhost:3000';
const ADMIN_ORIGIN = 'https://admin.grow.example.com';

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let websiteId = '';
/** @type {{ browser: string, server: string }} */
let tokens;
/** @type {import('mongodb').Db} */
let merchantDb;

beforeAll(async () => {
	sys = await startSystem({ unit: { createProductInstance, createRoutes, manifest, strings, url: GROWTH } });
});
afterAll(async () => {
	await sys?.stop();
});

/**
 * A visitor's browser on a local page of the website (local pages may use the browser token, PLAN 0.8.1): its fetch
 * reaches the product through the system, with the page's Origin, as a browser sends it.
 */
/** @param {string | null} [consent] the consent choice this browser kept from an earlier visit */
const openPage = (consent = null) => {
	const dom = new JSDOM('<!doctype html><html><head></head><body><h1>Shop</h1></body></html>', {
		url: `${PAGE}/shop?q=phones`,
		pretendToBeVisual: true,
	});
	const win = /** @type {any} */ (dom.window);
	/** @type {string[]} */
	const paths = [];
	/** @type {string[]} */
	const answers = [];
	win.fetch = async (/** @type {string} */ input, /** @type {RequestInit} */ init = {}) => {
		const url = new URL(input);
		paths.push(`${init.method ?? 'GET'} ${url.pathname}`);
		const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
		const res = await sys.call(init.method ?? 'GET', `${url.pathname}${url.search}`, {
			token: headers.authorization?.replace('Bearer ', ''),
			origin: PAGE,
			...(typeof init.body === 'string' ? { body: init.body } : {}),
		});
		answers.push(`${url.pathname} ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
		return new Response(res.status === 204 ? null : JSON.stringify(res.json), { status: res.status });
	};
	if (consent) win.localStorage.setItem('ss-growth-consent', consent);
	const script = win.document.createElement('script');
	script.src = `${GROWTH}/widget.js`;
	script.dataset.token = tokens.browser;
	return { win, paths, answers, page: startWidget({ window: win, script }) };
};

/**
 * Wait until a condition holds (the page script sends its events without waiting for the answer).
 * @param {() => boolean} done
 */
const until = async (done) => {
	for (let i = 0; i < 250 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
};

describe('Growth on the real Portal', () => {
	it('connects: the Portal keeps its manifest and price list version 1, every feature at 0', async () => {
		expect(await sys.connect()).toMatchObject({ productId: 'growth' });
		const page = await (await sys.owner()).get('/v1/admin/products/growth');
		expect(page.json.priceListVersion).toBe(1);
		expect(page.json.features.map((/** @type {{ key: string }} */ f) => f.key)).toEqual(manifest.features.map((f) => f.key));
		expect(page.json.features).toHaveLength(13);
		expect(page.json.features.every((/** @type {{ millicreditsPerHour: number }} */ f) => f.millicreditsPerHour === 0)).toBe(
			true,
		);
		m = await sys.merchant('grow@shop.test', [DOMAIN]);
		websiteId = m.websiteIds[0] ?? '';
		await sys.addProduct(m.merchantId, websiteId);
		await sys.addCredits(m.merchantId, 100);
		tokens = await sys.tokens(m.merchantId, websiteId);
	});

	it('an Owner prices features and a Support admin switches them on: both reports are accepted', async () => {
		expect(await sys.setPrices({ visitor_analytics: 1000, consent_banner: 500 })).toMatchObject({ version: 2 });
		const support = await sys.admin('support');
		const cookie = await sys.adminSession(support.client, websiteId);
		// a feature whose dependency is off is refused
		const refused = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/features`, {
			on: ['conversion_funnel'],
		});
		expect(refused.status).toBe(422);
		const on = ['consent_banner', 'conversion_funnel', 'searches_404s', 'visitor_analytics'];
		const report = await sys.switchFeatures(cookie, websiteId, on);
		expect(report.version).toBe(1);
		expect([...report.on].sort()).toEqual(on);
		const [entry] = await sys.activity('product.features_changed');
		expect(entry?.after).toMatchObject({ on });
		merchantDb = await sys.connectDatabase(await sys.adminSession(await sys.owner(), websiteId), websiteId);
	});

	it('asks for consent first, then records the page view, the search and the shop events', async () => {
		const { win, paths, answers, page } = openPage();
		// Ecommerce's widget announces the product page while the page script loads its config
		win.dispatchEvent(
			new win.CustomEvent('ss:view_item', {
				detail: { currency: 'USD', value: 1250, items: [{ id: 'prod_1', name: 'Case', price: 1250, quantity: 1 }] },
			}),
		);
		await page.ready;
		const banner = win.document.querySelector('[data-ss-growth="consent_banner"]');
		const dialog = banner.shadowRoot.querySelector('[role="dialog"]');
		expect(dialog.hasAttribute('hidden')).toBe(false);
		win.dispatchEvent(new win.Event('pagehide'));
		expect(paths).toEqual(['GET /v1/widget/config']);
		expect(await merchantDb.collection('ss_growth_events').countDocuments()).toBe(0);

		const accept = [...banner.shadowRoot.querySelectorAll('button')].find(
			(b) => b.textContent === strings['consent.acceptAll'],
		);
		accept.click();
		expect(JSON.parse(win.localStorage.getItem('ss-growth-consent'))).toMatchObject({ analytics: true, marketing: true });
		win.dispatchEvent(
			new win.CustomEvent('ss:add_to_cart', {
				detail: { currency: 'USD', value: 2500, items: [{ id: 'prod_1', price: 1250, quantity: 2 }] },
			}),
		);
		win.dispatchEvent(
			new win.CustomEvent('ss:purchase', {
				detail: { orderId: 'ord_1', currency: 'USD', value: 2500, items: [{ id: 'prod_1', price: 1250, quantity: 2 }] },
			}),
		);
		win.dispatchEvent(new win.Event('pagehide'));
		await until(() => answers.some((answer) => answer.startsWith('/v1/collect 202')));
		expect(answers.filter((answer) => answer.startsWith('/v1/collect')).every((a) => a.startsWith('/v1/collect 202'))).toBe(
			true,
		);
		const events = await merchantDb.collection('ss_growth_events').find({}).sort({ type: 1 }).toArray();
		expect(events.map((e) => e.type).sort()).toEqual(['add_to_cart', 'page_view', 'purchase', 'search', 'view_item']);
		expect(events.every((e) => e.websiteId === websiteId && e.expiresAt instanceof Date)).toBe(true);
		const totals = await merchantDb.collection('ss_growth_daily').find({}).toArray();
		/** @param {string} metric @param {string} key */
		const total = (metric, key) => totals.find((row) => row.metric === metric && row.key === key);
		expect(total('visits', '')?.count).toBe(1);
		expect(total('page', '/shop')?.count).toBe(1);
		expect(total('search', 'phones')?.count).toBe(1);
		expect(total('funnel', 'purchase')?.count).toBe(1);
		expect(total('revenue', 'USD')).toMatchObject({ count: 1, sum: 2500 });

		// the same visitor back later (a new visit): the kept choice holds, no banner, the totals go up
		const next = openPage(win.localStorage.getItem('ss-growth-consent'));
		await next.page.ready;
		const again = next.win.document.querySelector('[data-ss-growth="consent_banner"]');
		expect(again.shadowRoot.querySelector('[role="dialog"]').hasAttribute('hidden')).toBe(true);
		next.win.dispatchEvent(new next.win.Event('pagehide'));
		await until(() => next.answers.some((answer) => answer.startsWith('/v1/collect 202')));
		const after = await merchantDb.collection('ss_growth_daily').findOne({ metric: 'page_views', key: '' });
		expect(after?.count).toBe(2);
	});

	it('the analytics dashboard reads the totals with a ticket bound to the merchant’s admin page', async () => {
		const ticket = await sys.call('POST', '/v1/tickets', {
			token: tokens.server,
			body: {
				user: { id: 'u_9', name: 'Ana Admin', email: 'ana@shop.test' },
				permissions: ['analytics.read'],
				origin: ADMIN_ORIGIN,
			},
		});
		expect(ticket.status).toBe(200);
		const report = await sys.call('GET', '/v1/admin/analytics?from=2026-10-01&to=2026-10-01', {
			token: ticket.json.ticket,
			origin: ADMIN_ORIGIN,
		});
		expect(report.status).toBe(200);
		expect(report.json.totals).toEqual({ visits: 2, pageViews: 2 });
		expect(report.json.funnel.steps.map((/** @type {{ count: number }} */ s) => s.count)).toEqual([1, 1, 0, 1]);
		expect(report.json.searches).toEqual([{ key: 'phones', count: 2 }]);
		const elsewhere = await sys.call('GET', '/v1/admin/analytics', {
			token: ticket.json.ticket,
			origin: 'https://evil.example',
		});
		expect(elsewhere.status).toBe(401);
	});

	it('charges the switched-on features by the hour', async () => {
		sys.clock.advance(HOUR);
		const status = await sys.productApi('GET', `/v1/product/websites/${websiteId}/status`);
		expect(status.json.todayMillicredits).toBeGreaterThanOrEqual(2 * 1500);
	});
});
