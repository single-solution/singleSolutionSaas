/**
 * PLAN 0.12 step 11: Growth against the REAL Portal — connect (manifest and price list), price and feature reports,
 * then the real page script (`@ss/product-growth/page-script`) in a browser window (jsdom) on a local page of the
 * website with the Portal-issued browser token: the consent banner asks first and nothing is recorded, the visitor
 * accepts, the page view and Ecommerce's shop events (browser events) are recorded in the merchant database and the
 * daily totals go up; then the analytics dashboard's ticketed read, an old path answered by its redirect rule (one
 * address and the whole list with its ETag), the SEO checklist on a small fake website (sample pages of each kind from
 * its sitemap, the rule applied on the live site, the kept report answered again without a read), and the hourly
 * charge.
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

/** @param {unknown} data */
const ld = (data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

/**
 * A page of the merchant's fake website, with what search engines want in its head.
 * @param {string} path @param {string} title @param {unknown} data @param {string} [body]
 */
const page = (path, title, data, body = '') => ({
	status: 200,
	headers: { 'content-type': 'text/html; charset=utf-8', etag: '"1"' },
	body: `<!doctype html><html lang="en"><head><title>${title}</title>
<meta name="description" content="${title}, with the details shoppers ask for before they buy, and delivery in two days.">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="https://${DOMAIN}${path}">
${ld(data)}</head><body><h1>${title}</h1>${body}</body></html>`,
});

/** The merchant's website as Growth's SEO checklist reads it (path → answer; anything else 404). */
const SITE = /** @type {Record<string, { status: number, headers?: Record<string, string>, body?: string }>} */ ({
	'/robots.txt': { status: 200, body: `User-agent: *\nDisallow: /cart\nSitemap: https://${DOMAIN}/sitemap.xml\n` },
	'/sitemap.xml': {
		status: 200,
		body: `<urlset>${['/lamps', '/glossary/linen', '/products/blue-lamp']
			.map((path) => `<url><loc>https://${DOMAIN}${path}</loc></url>`)
			.join('')}</urlset>`,
	},
	'/': page('/', 'Grow Example: lamps and shades', [
		{ '@type': 'OnlineStore', name: 'Grow' },
		{ '@type': 'WebSite', name: 'Grow' },
	]),
	'/lamps': page('/lamps', 'Lamps | Grow Example', [{ '@type': 'CollectionPage' }, { '@type': 'BreadcrumbList' }]),
	'/glossary/linen': page('/glossary/linen', 'Linen | Grow Example', { '@type': 'DefinedTerm', name: 'Linen' }),
	'/products/blue-lamp': page(
		'/products/blue-lamp',
		'Blue Lamp | Grow Example',
		[
			{
				'@type': 'Product',
				name: 'Blue Lamp',
				image: `https://${DOMAIN}/media/blue.jpg`,
				offers: { '@type': 'Offer', price: '12.50', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
			},
			{ '@type': 'BreadcrumbList' },
		],
		'<p>$12.50</p>',
	),
	// the website's server applies the redirect rule (GET /v1/redirects/match)
	'/old-lamps': { status: 301, headers: { location: '/lamps' } },
});

beforeAll(async () => {
	sys = await startSystem({
		unit: {
			createProductInstance,
			createRoutes,
			manifest,
			strings,
			url: GROWTH,
			handlers: {
				[`https://${DOMAIN}`]: async (/** @type {Request} */ request) => {
					const answer = SITE[new URL(request.url).pathname];
					return answer
						? new Response(answer.body ?? null, { status: answer.status, headers: answer.headers ?? {} })
						: new Response('Not found', { status: 404 });
				},
			},
		},
	});
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
		url: `${PAGE}/shop?q=lamps`,
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
 * Wait until a condition holds, at most 15 s (the page script sends its events without waiting for the answer; a busy
 * machine runs the whole suite at once).
 * @param {() => boolean} done
 */
const until = async (done) => {
	for (let i = 0; i < 750 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
};

describe('Growth on the real Portal', () => {
	it('connects: the Portal keeps its manifest and price list version 1, every feature at 0', async () => {
		expect(await sys.connect()).toMatchObject({ productId: 'growth' });
		const page = await (await sys.owner()).get('/v1/admin/products/growth');
		expect(page.json.priceListVersion).toBe(1);
		expect(page.json.features.map((/** @type {{ key: string }} */ f) => f.key)).toEqual(manifest.features.map((f) => f.key));
		expect(page.json.features).toHaveLength(manifest.features.length);
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
		merchantDb = await sys.connectDatabase(websiteId);
	});

	it('asks for consent first, then records the page view, the search and the shop events', async () => {
		const { win, paths, answers, page } = openPage();
		// Ecommerce's widget announces the product page while the page script loads its config
		win.dispatchEvent(
			new win.CustomEvent('ss:view_item', {
				detail: { currency: 'USD', value: 1250, items: [{ id: 'prod_1', name: 'Lamp', price: 1250, quantity: 1 }] },
			}),
		);
		await page.ready;
		const banner = win.document.querySelector('[data-ss-growth="consent_banner"]');
		const dialog = banner.shadowRoot.querySelector('[role="dialog"]');
		expect(dialog.hasAttribute('hidden')).toBe(false);
		win.dispatchEvent(new win.Event('pagehide'));
		expect(paths).toEqual(['GET /v1/widget/config']);
		expect(await merchantDb.collection('ss_growth_analytics_events').countDocuments()).toBe(0);

		const accept = [...banner.shadowRoot.querySelectorAll('button')].find(
			(b) => b.textContent === strings['consent.acceptAll'],
		);
		accept.click();
		expect(JSON.parse(win.localStorage.getItem('ss-growth-consent'))).toMatchObject({
			categories: { analytics: true, marketing: true },
		});
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
		const events = await merchantDb.collection('ss_growth_analytics_events').find({}).sort({ type: 1 }).toArray();
		expect(events.map((e) => e.type).sort()).toEqual(['add_to_cart', 'page_view', 'purchase', 'search', 'view_item']);
		expect(events.every((e) => e.websiteId === websiteId && e.expiresAt instanceof Date)).toBe(true);
		const [day] = await merchantDb.collection('ss_growth_totals').find({}).toArray();
		/** @param {string} metric @param {string} key */
		const total = (metric, key) => day?.totals?.[metric]?.[`_${key}`];
		expect(total('visits', '')?.c).toBe(1);
		expect(total('page', '/shop')?.c).toBe(1);
		expect(total('search', 'lamps')?.c).toBe(1);
		expect(total('event', 'purchase')?.c).toBe(1);
		expect(total('revenue', 'USD')).toMatchObject({ c: 1, s: 2500 });

		// the same visitor back later (a new visit): the kept choice holds, no banner, the totals go up
		const next = openPage(win.localStorage.getItem('ss-growth-consent'));
		await next.page.ready;
		const again = next.win.document.querySelector('[data-ss-growth="consent_banner"]');
		expect(again.shadowRoot.querySelector('[role="dialog"]').hasAttribute('hidden')).toBe(true);
		next.win.dispatchEvent(new next.win.Event('pagehide'));
		await until(() => next.answers.some((answer) => answer.startsWith('/v1/collect 202')));
		const after = await merchantDb.collection('ss_growth_totals').findOne({});
		expect(after?.totals.page_views._.c).toBe(2);
	});

	it('the analytics dashboard reads the totals with a ticket bound to the merchant’s admin page', async () => {
		const ticket = await sys.call('POST', '/v1/tickets', {
			token: tokens.server,
			staff: { id: 'u_9', name: 'Ana Admin', email: 'ana@shop.test' },
			body: { permissions: ['analytics.read'], origin: ADMIN_ORIGIN },
		});
		expect(ticket.status).toBe(200);
		const report = await sys.call('GET', '/v1/admin/analytics?from=2026-10-01&to=2026-10-01', {
			token: ticket.json.ticket,
			origin: ADMIN_ORIGIN,
		});
		expect(report.status).toBe(200);
		expect(report.json.totals).toEqual({ visits: 2, pageViews: 2 });
		// the shop funnel every website starts with (G1)
		expect(report.json.funnels[0].steps.map((/** @type {{ count: number }} */ s) => s.count)).toEqual([1, 1, 0, 1]);
		expect(report.json.searches).toEqual([{ key: 'lamps', count: 2 }]);
		// the raw events list and its count agree (PLAN 0.8.10 K4)
		const raw = await sys.call('GET', '/v1/events?limit=100', { token: tokens.server });
		const count = await sys.call('GET', '/v1/events/count', { token: tokens.server });
		expect(count.json).toEqual({ count: raw.json.items.length, capped: false });
		const byType = await sys.call('GET', '/v1/events/counts?by=type', { token: tokens.server });
		expect(byType.json.total).toBe(raw.json.items.length);
		const elsewhere = await sys.call('GET', '/v1/admin/analytics', {
			token: ticket.json.ticket,
			origin: 'https://evil.example',
		});
		expect(elsewhere.status).toBe(401);
	});

	it('an old path answers its redirect rule, to the website’s server and to its edge middleware', async () => {
		const support = await sys.admin('support');
		const cookie = await sys.adminSession(support.client, websiteId);
		await sys.switchFeatures(cookie, websiteId, [
			'consent_banner',
			'conversion_funnel',
			'redirects',
			'searches_404s',
			'visitor_analytics',
		]);
		const made = await sys.call('POST', '/v1/redirects', {
			token: tokens.server,
			body: { from: '/old-lamps', match: 'prefix', to: '/lamps', note: 'Category moved' },
		});
		expect(made.status).toBe(201);
		const rule = await sys.call('GET', `/v1/redirects/match?path=${encodeURIComponent('/old-lamps/blue?utm_source=news')}`, {
			token: tokens.server,
		});
		expect(rule.json).toEqual({
			from: '/old-lamps',
			match: 'prefix',
			to: '/lamps',
			code: 301,
			location: '/lamps/blue?utm_source=news',
		});
		const none = await sys.call('GET', '/v1/redirects/match?path=/lamps/blue', { token: tokens.server });
		expect(none.status).toBe(204);
		const list = await sys.call('GET', '/v1/redirects/all', { token: tokens.server });
		expect(list.json.rules).toEqual([{ from: '/old-lamps', match: 'prefix', to: '/lamps', code: 301 }]);
		const etag = String(list.headers.get('etag'));
		const again = await sys.call('GET', '/v1/redirects/all', { token: tokens.server, headers: { 'if-none-match': etag } });
		expect(again.status).toBe(304);
		expect(await merchantDb.collection('ss_growth_redirects').countDocuments({ websiteId })).toBe(1);
	});

	it('the SEO checklist reads the live website: samples of each kind, the rule applied, the kept report', async () => {
		const support = await sys.admin('support');
		await sys.switchFeatures(await sys.adminSession(support.client, websiteId), websiteId, [
			'consent_banner',
			'conversion_funnel',
			'redirects',
			'searches_404s',
			'seo_checklist',
			'visitor_analytics',
		]);
		const run = await sys.call('POST', '/v1/seo/checks', { token: tokens.server, body: {} });
		expect(run.status).toBe(200);
		expect(run.json.cached).toBe(false);
		expect(run.json.pages.map((/** @type {any} */ { url, kind, sampled }) => ({ url, kind, sampled }))).toEqual([
			{ url: `https://${DOMAIN}/`, kind: 'home', sampled: false },
			{ url: `https://${DOMAIN}/products/blue-lamp`, kind: 'Product', sampled: true },
			{ url: `https://${DOMAIN}/lamps`, kind: 'CollectionPage', sampled: true },
			{ url: `https://${DOMAIN}/glossary/linen`, kind: 'DefinedTerm', sampled: true },
		]);
		// each page read keeps its head for the checklist's search result and share preview (R7 #105)
		expect(run.json.pages[1].head).toEqual({
			title: 'Blue Lamp | Grow Example',
			description: 'Blue Lamp | Grow Example, with the details shoppers ask for before they buy, and delivery in two days.',
			url: `https://${DOMAIN}/products/blue-lamp`,
			image: '',
			siteName: '',
		});
		/** @param {string} id @param {string | null} [at] */
		const result = (id, at) => {
			const item = run.json.checks.find(
				(/** @type {any} */ c) => c.id === id && (at === undefined || c.page === `https://${DOMAIN}${at}`),
			);
			return item ? `${item.status} ${item.finding}` : undefined;
		};
		expect(result('robots_txt')).toBe('pass ok');
		expect(result('robots_blocks')).toBe('pass ok');
		expect(result('sitemap')).toBe('pass ok');
		expect(result('sitemap_urls')).toBe('pass ok');
		expect(result('soft_404')).toBe('pass ok');
		expect(result('redirects_live')).toBe('pass ok');
		// the 404 log: no address visitors could not find is without a rule
		expect(result('redirect_suggestions')).toBe('pass none');
		expect(result('site_data', '/')).toBe('pass ok');
		for (const id of ['product_data', 'price_match', 'server_html', 'breadcrumbs', 'canonical'])
			expect(result(id, '/products/blue-lamp'), id).toBe('pass ok');
		const productCheck = run.json.checks.find((/** @type {any} */ c) => c.id === 'product_data');
		expect(productCheck.test).toBe(
			`https://search.google.com/test/rich-results?url=${encodeURIComponent(`https://${DOMAIN}/products/blue-lamp`)}`,
		);
		expect(productCheck.title).toBe(strings['seo.check.product_data.title']);
		// kept: asked again at once, the report comes back without a read of the site
		const again = await sys.call('POST', '/v1/seo/checks', { token: tokens.server, body: {} });
		expect(again.json).toEqual({ ...run.json, cached: true });
		const ticket = await sys.call('POST', '/v1/tickets', {
			token: tokens.server,
			staff: { id: 'u_9', name: 'Ana Admin', email: 'ana@shop.test' },
			body: { permissions: ['seo.check'], origin: ADMIN_ORIGIN },
		});
		const kept = await sys.call('GET', '/v1/admin/seo/report', { token: ticket.json.ticket, origin: ADMIN_ORIGIN });
		expect(kept.json.checkedAt).toBe(run.json.checkedAt);
		expect(await merchantDb.collection('ss_growth_seo_reports').countDocuments({ websiteId })).toBe(1);
	});

	it('charges the switched-on features by the hour', async () => {
		sys.clock.advance(HOUR);
		const status = await sys.productApi('GET', `/v1/product/websites/${websiteId}/status`);
		expect(status.json.todayMillicredits).toBeGreaterThanOrEqual(2 * 1500);
	});
});
