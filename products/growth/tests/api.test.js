import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ORIGIN, ALL, BASE, DOMAIN, ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** @param {Response} response */
const codeOf = async (response) =>
	String((await response.json()).type ?? '')
		.split('/')
		.pop();

const HOME = `<!doctype html><html lang="en"><head>
<title>Shop Example: phones and cases</title>
<meta name="description" content="Phones, cases and chargers with delivery across the country and easy returns.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="Shop"><meta property="og:image" content="https://shop.example.com/og.png">
<link rel="canonical" href="https://shop.example.com/">
<meta name="google-site-verification" content="abc123">
<script type="application/ld+json">{"@type":"Organization"}</script>
</head><body><h1>Shop</h1><img src="/a.png" alt="A phone"></body></html>`;

beforeAll(async () => {
	env = await setup();
});
afterAll(async () => {
	await env.close();
});

describe('before setup', () => {
	it('refuses events while their features are off and until the merchant database is connected', async () => {
		const off = await env.collect([{ type: 'page_view', path: '/' }]);
		expect(off.status).toBe(403);
		expect(await codeOf(off)).toBe('feature_off');
		await env.switchOn(ALL);
		const noDb = await env.collect([{ type: 'page_view', path: '/' }]);
		expect(await codeOf(noDb)).toBe('database_not_connected');
		await env.connectDatabase();
	});

	it('takes the browser token only from the website or a local page, never the server token', async () => {
		const elsewhere = await env.call('POST', '/v1/collect', {
			token: env.browser,
			origin: 'https://evil.example.net',
			body: { events: [] },
		});
		expect(elsewhere.status).toBe(401);
		const local = await env.call('POST', '/v1/collect', {
			token: env.browser,
			origin: 'http://localhost:3000',
			body: { events: [] },
		});
		expect(local.status).toBe(202);
		const server = await env.call('POST', '/v1/collect', { token: env.server, origin: ORIGIN, body: { events: [] } });
		expect(server.status).toBe(401);
		const serverWithOrigin = await env.call('GET', '/v1/analytics', { token: env.server, origin: ORIGIN });
		expect(serverWithOrigin.status).toBe(401);
	});
});

describe('events and totals', () => {
	it('records a batch: raw events with their expiry and the daily totals by $inc', async () => {
		const answer = await env.collect(
			[
				{
					type: 'page_view',
					path: '/shop?q=secret#x',
					visit: true,
					referrer: 'www.google.com',
					device: 'mobile',
					campaign: { source: '', medium: '', name: '' },
				},
				{ type: 'page_view', path: '/shop', visit: false, device: 'mobile' },
				{
					type: 'view_item',
					path: '/p/1',
					items: [{ id: 'prod_1', variantId: 'var_1', quantity: 1 }],
					value: 1250,
					currency: 'USD',
				},
				{
					type: 'purchase',
					path: '/cart',
					items: [{ id: 'prod_1', quantity: 2 }],
					value: 2500,
					currency: 'USD',
					orderId: 'ord_1',
				},
				{ type: 'search', path: '/search', term: '  Blue  Shoes ', results: 0 },
				{ type: 'not_found', path: '/missing' },
				{ type: 'vital', path: '/', name: 'LCP', value: 1800 },
				{ type: 'vital', path: '/', name: 'CLS', value: 300 },
				{ type: 'nonsense', path: '/' },
				{ type: 'page_view', path: 'no-slash' },
			],
			{ 'x-vercel-ip-country': 'pk' },
		);
		expect(answer.status).toBe(202);
		expect(await answer.json()).toEqual({ accepted: 8 });
		const db = await env.merchantDb();
		const events = await db.collection('ss_growth_events').find({}).toArray();
		expect(events).toHaveLength(8);
		const first = events.find((event) => event.type === 'page_view' && event.data.visit);
		expect(first).toMatchObject({
			websiteId: env.websiteId,
			path: '/shop',
			data: { source: 'www.google.com', device: 'mobile', country: 'PK' },
		});
		expect(JSON.stringify(events)).not.toContain('secret');
		expect(first?.expiresAt.toISOString()).toBe('2027-11-01T10:00:00.000Z');
		const indexes = await db.collection('ss_growth_events').indexes();
		expect(indexes.find((index) => index.name === 'expiry')).toMatchObject({ key: { expiresAt: 1 }, expireAfterSeconds: 0 });
		const daily = await db.collection('ss_growth_daily').find({}).toArray();
		/** @param {string} metric @param {string} key */
		const total = (metric, key) => daily.find((row) => row.metric === metric && row.key === key);
		expect(total('page_views', '')).toMatchObject({ day: '2026-10-01', count: 2 });
		expect(total('visits', '')?.count).toBe(1);
		expect(total('revenue', 'USD')).toMatchObject({ count: 1, sum: 2500 });
		expect(total('search_empty', 'blue shoes')?.count).toBe(1);
		expect(total('vital', 'CLS:poor')?.count).toBe(1);
		expect(total('page_views', '')?.merchantId).toBeTruthy();

		await env.collect([{ type: 'page_view', path: '/shop', visit: false }]);
		const again = await db.collection('ss_growth_daily').findOne({ metric: 'page_views', key: '' });
		expect(again?.count).toBe(3);
	});

	it('follows the retention and privacy settings, and drops events of features that are off', async () => {
		await env.setting('visitor_analytics', 'retentionMonths', 1);
		await env.setting('visitor_analytics', 'recordCountry', false);
		await env.collect([{ type: 'page_view', path: '/later', visit: true }], { 'cf-ipcountry': 'DE' });
		const db = await env.merchantDb();
		const later = await db.collection('ss_growth_events').findOne({ path: '/later' });
		expect(later?.expiresAt.toISOString()).toBe('2026-11-01T10:00:00.000Z');
		expect(later?.data.country).toBe('(unknown)');
		await env.switchOn(['visitor_analytics']);
		const answer = await env.collect([
			{ type: 'search', path: '/s', term: 'x' },
			{ type: 'page_view', path: '/only', visit: false },
		]);
		expect(await answer.json()).toEqual({ accepted: 1 });
		await env.switchOn(ALL);
		await env.setting('visitor_analytics', 'recordCountry', true);
	});

	it('answers the analytics report to the server token and to a ticket', async () => {
		const bad = await env.call('GET', '/v1/analytics?from=2026-10-05&to=2026-10-01', { token: env.server });
		expect(bad.status).toBe(422);
		const report = await (await env.call('GET', '/v1/analytics', { token: env.server })).json();
		expect(report).toMatchObject({
			from: '2026-09-02',
			to: '2026-10-01',
			timeZone: 'UTC',
			totals: { visits: 2, pageViews: 5 },
		});
		expect(report.days).toHaveLength(30);
		expect(report.funnel.steps[3]).toEqual({ step: 'purchase', count: 1 });
		expect(report.funnel.revenue).toEqual([{ currency: 'USD', value: 2500, orders: 1 }]);
		expect(report.searches).toEqual([{ key: 'blue shoes', count: 1 }]);
		expect(report.vitals[0]).toMatchObject({ name: 'LCP', average: 1800, good: 1 });
		const ticket = await env.ticket(['analytics.read']);
		const viaTicket = await env.call('GET', '/v1/admin/analytics?from=2026-10-01&to=2026-10-01', {
			token: ticket,
			origin: ADMIN_ORIGIN,
		});
		expect(viaTicket.status).toBe(200);
		expect(viaTicket.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
		expect((await viaTicket.json()).totals.visits).toBe(2);
		const noPermission = await env.call('GET', '/v1/admin/analytics', {
			token: await env.ticket(['seo.check']),
			origin: ADMIN_ORIGIN,
		});
		expect(noPermission.status).toBe(403);
	});

	it('lists raw events newest first, by type, paged', async () => {
		const page = await (await env.call('GET', '/v1/events?limit=2', { token: env.server })).json();
		expect(page.items).toHaveLength(2);
		expect(page.hasMore).toBe(true);
		const next = await (
			await env.call(`GET`, `/v1/events?limit=50&cursor=${encodeURIComponent(page.nextCursor)}`, { token: env.server })
		).json();
		expect(next.items.length).toBeGreaterThan(5);
		const purchases = await (await env.call('GET', '/v1/events?type=purchase', { token: env.server })).json();
		expect(purchases.items).toEqual([
			expect.objectContaining({ type: 'purchase', data: expect.objectContaining({ orderId: 'ord_1', value: 2500 }) }),
		]);
	});
});

describe('the widget config', () => {
	it('gives the page script the switched-on tags, consent and the notice bar while its dates say so', async () => {
		await env.setting('meta_pixel', 'pixelId', '1234567890');
		await env.setting('google_tags', 'ga4Id', 'G-ABC123');
		await env.setting('google_tags', 'gtmId', 'not-an-id');
		await env.setting('notice_bar', 'text', 'Free delivery this week');
		await env.setting('notice_bar', 'linkUrl', '/deals');
		await env.setting('notice_bar', 'linkText', 'See deals');
		await env.setting('notice_bar', 'startsAt', '2026-10-02T00:00:00Z');
		/** @returns {Promise<any>} */
		const config = async () =>
			(await (await env.call('GET', '/v1/widget/config', { token: env.browser, origin: ORIGIN })).json()).settings;
		const before = await config();
		expect(before.tags).toMatchObject({ meta: '1234567890', ga4: 'G-ABC123', gtm: null });
		expect(before.notice).toBeNull();
		expect(before.consent).toMatchObject({ banner: true, position: 'bottom' });
		env.advance(24 * 3_600_000);
		expect((await config()).notice).toEqual({
			text: 'Free delivery this week',
			linkUrl: '/deals',
			linkText: 'See deals',
			dismissible: true,
		});
	});
});

describe('robots and verification', () => {
	it('serves robots.txt and the verification tags to the server token', async () => {
		await env.setting('robots_verification', 'robotsRules', 'User-agent: *\nDisallow: /admin\nSitemap: https://evil.example/x');
		await env.setting('robots_verification', 'sitemaps', [`${ORIGIN}/sitemap.xml`, 'https://other.example/s.xml']);
		await env.setting('robots_verification', 'googleVerification', '<meta name="google-site-verification" content="tok-1">');
		const robots = await env.call('GET', '/v1/robots.txt', { token: env.server });
		expect(robots.headers.get('content-type')).toContain('text/plain');
		expect(await robots.text()).toBe(`User-agent: *\nDisallow: /admin\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
		const tags = await (await env.call('GET', '/v1/verification', { token: env.server })).json();
		expect(tags).toEqual({
			tags: [{ name: 'google-site-verification', content: 'tok-1' }],
			html: '<meta name="google-site-verification" content="tok-1">',
		});
	});
});

describe('IndexNow', () => {
	it('needs the key, takes only the website’s URLs and says what IndexNow answered', async () => {
		const noKey = await env.call('GET', '/v1/indexnow/key.txt', { token: env.server });
		expect(noKey.status).toBe(404);
		const withoutKey = await env.call('POST', '/v1/indexnow', { token: env.server, body: { urls: [`${ORIGIN}/a`] } });
		expect(withoutKey.status).toBe(422);
		await env.setting('indexnow', 'key', 'key-0123456789');
		expect(await (await env.call('GET', '/v1/indexnow/key.txt', { token: env.server })).text()).toBe('key-0123456789');
		const foreign = await env.call('POST', '/v1/indexnow', { token: env.server, body: { urls: ['https://other.example/a'] } });
		expect(foreign.status).toBe(422);
		const sent = await env.call('POST', '/v1/indexnow', {
			token: env.server,
			body: { urls: [`${ORIGIN}/a`, `${ORIGIN}/a`, `${ORIGIN}/b`] },
		});
		expect(await sent.json()).toEqual({ submitted: 2, status: 200 });
		expect(JSON.parse(env.web.calls.at(-1)?.body ?? '{}')).toEqual({
			host: DOMAIN,
			key: 'key-0123456789',
			keyLocation: `${ORIGIN}/key-0123456789.txt`,
			urlList: [`${ORIGIN}/a`, `${ORIGIN}/b`],
		});
		for (const [status, words] of /** @type {const} */ ([
			[403, 'serve it'],
			[422, 'match'],
			[429, 'fewer'],
			[500, '500'],
		])) {
			env.web.indexNowAnswers(status);
			const refused = await env.call('POST', '/v1/indexnow', { token: env.server, body: { urls: [`${ORIGIN}/c`] } });
			expect(refused.status).toBe(502);
			expect((await refused.json()).detail).toContain(words);
		}
		env.web.indexNowAnswers(202);
		const ticket = await env.ticket(['indexnow.submit']);
		const viaWidget = await env.call('POST', '/v1/admin/indexnow', {
			token: ticket,
			origin: ADMIN_ORIGIN,
			body: { urls: [`${ORIGIN}/d`] },
		});
		expect(await viaWidget.json()).toEqual({ submitted: 1, status: 202 });
		const badWidget = await env.call('POST', '/v1/admin/indexnow', { token: ticket, origin: ADMIN_ORIGIN, body: { urls: [] } });
		expect(badWidget.status).toBe(422);
		const db = await env.merchantDb();
		const logged = await db.collection('ss_growth_activity').findOne({ action: 'indexnow.submitted' });
		expect(logged).toMatchObject({
			actor: { kind: 'staff', id: 'u_1', name: 'Sam Staff' },
			target: 'indexnow',
			label: '1 page submitted to IndexNow',
			detail: 'IndexNow answered 202. Pages: /d',
		});
		// the server token's own submissions are not in the activity log
		expect(await db.collection('ss_growth_activity').countDocuments({ action: 'indexnow.submitted' })).toBe(1);
	});
});

describe('SEO checklist', () => {
	it('reads the pages on request and reports each check with its fix steps', async () => {
		env.web.pages['/'] = { status: 200, body: HOME };
		env.web.pages['/robots.txt'] = { status: 200, body: `User-agent: *\nDisallow: /\nSitemap: ${ORIGIN}/sm.xml` };
		env.web.pages['/sm.xml'] = { status: 200, body: '<urlset/>' };
		env.web.pages['/thin'] = {
			status: 200,
			body: '<html><head><meta name="robots" content="noindex"></head><body><img src="x"><h1>a</h1><h1>b</h1></body></html>',
		};
		await env.setting('seo_checklist', 'paths', ['/', '/thin', '/gone', 'bad path']);
		const report = await (await env.call('POST', '/v1/seo/checks', { token: env.server, body: {} })).json();
		expect(report.pages).toEqual([`${ORIGIN}/`, `${ORIGIN}/thin`, `${ORIGIN}/gone`]);
		/** @param {string} id @param {string} [page] */
		const find = (id, page) =>
			report.checks.find((/** @type {any} */ c) => c.id === id && (page === undefined || c.page === page));
		expect(find('robots_txt')).toMatchObject({ status: 'pass' });
		expect(find('robots_blocks')).toMatchObject({ status: 'fail', title: 'robots.txt lets search engines in' });
		expect(find('robots_blocks').fix).toContain('Disallow');
		expect(find('sitemap')).toMatchObject({ status: 'pass', page: `${ORIGIN}/sm.xml`, fix: '' });
		expect(find('verification').status).toBe('pass');
		expect(find('title', `${ORIGIN}/`).status).toBe('pass');
		expect(find('noindex', `${ORIGIN}/thin`).status).toBe('fail');
		expect(find('image_alt', `${ORIGIN}/thin`).fix).toContain('(1 have none)');
		expect(find('reachable', `${ORIGIN}/gone`)).toMatchObject({ status: 'fail', fix: expect.stringContaining('404') });
		expect(report.summary.fail).toBeGreaterThan(2);

		const asked = await env.call('POST', '/v1/seo/checks', { token: env.server, body: { paths: 'x' } });
		expect(asked.status).toBe(422);
		const ticket = await env.ticket(['seo.check']);
		const viaWidget = await env.call('POST', '/v1/admin/seo/checks', {
			token: ticket,
			origin: ADMIN_ORIGIN,
			body: { paths: ['/'] },
		});
		expect((await viaWidget.json()).pages).toEqual([`${ORIGIN}/`]);
		const db = await env.merchantDb();
		expect(await db.collection('ss_growth_activity').findOne({ action: 'seo.checked' })).toMatchObject({
			actor: { kind: 'staff', id: 'u_1', name: 'Sam Staff' },
			target: 'seo_checklist',
			label: '/',
			detail: expect.stringMatching(/^\d+ passed, \d+ to improve, \d+ to fix\. Pages: \/$/),
		});
		const badWidget = await env.call('POST', '/v1/admin/seo/checks', {
			token: ticket,
			origin: ADMIN_ORIGIN,
			body: { paths: 1 },
		});
		expect(badWidget.status).toBe(422);

		env.web.siteDown(true);
		const down = await (await env.call('POST', '/v1/seo/checks', { token: env.server, body: { paths: [] } })).json();
		expect(down.checks.find((/** @type {any} */ c) => c.id === 'reachable')).toMatchObject({ status: 'fail' });
		expect(down.checks.find((/** @type {any} */ c) => c.id === 'robots_txt')).toMatchObject({ status: 'warn' });
		env.web.siteDown(false);
	});
});

describe('statuses, data rights and public routes', () => {
	it('refuses everything while the product is stopped', async () => {
		env.portal.setStatus(env.websiteId, { status: 'stopped' });
		env.advance(1000);
		await env.portal.sendNotice('growth', { type: 'status.changed', websiteId: env.websiteId });
		await env.flush();
		const stopped = await env.collect([{ type: 'page_view', path: '/' }]);
		expect(stopped.status).toBe(403);
		expect((await stopped.json()).reason).toBe('stopped');
		env.portal.setStatus(env.websiteId, { status: 'active' });
		env.advance(1000);
		await env.portal.sendNotice('growth', { type: 'status.changed', websiteId: env.websiteId });
		await env.flush();
		expect((await env.collect([])).status).toBe(202);
	});

	it('keeps nothing about a person: export and delete find nothing', async () => {
		const exported = await env.call('POST', '/v1/data-rights/export', {
			token: env.server,
			body: { user: { email: 'a@b.co' } },
		});
		expect(exported.status).toBe(200);
		const deleted = await (
			await env.call('POST', '/v1/data-rights/delete', { token: env.server, body: { user: { email: 'a@b.co' } } })
		).json();
		expect(deleted).toMatchObject({ deleted: 0, anonymised: 0 });
	});

	it('serves the page script and the public docs', async () => {
		const script = await env.call('GET', '/widget.js');
		expect(script.headers.get('content-type')).toContain('javascript');
		expect(await script.text()).toContain('SSGrowth');
		const docs = await env.call('GET', '/docs');
		const html = await docs.text();
		expect(html).toContain('Growth docs');
		expect(html).toContain('ss:purchase');
		expect(html).toContain(`${BASE}/widget.js`);
		expect(html).toContain('feature-seo_checklist');
		for (const id of ['server-settings', 'acting-user', 'server-visitors', 'counts', 'activity', 'format'])
			expect(html).toContain(`<h2 id="${id}">`);
		expect(html).toContain('/v1/events/counts');
	});
});

describe('store conversion kit (PLAN 0.8.10 K2–K9)', () => {
	/** @type {Awaited<ReturnType<typeof setup>>} */
	let kit;
	const VISITOR = '203.0.113.7';

	beforeAll(async () => {
		// 20:00 UTC on 1 October is already 2 October in Karachi (UTC+5)
		kit = await setup({ start: Date.parse('2026-10-01T20:00:00Z') });
		await kit.switchOn(ALL);
		await kit.connectDatabase();
		kit.web.pages['/.well-known/business.json'] = {
			status: 200,
			body: JSON.stringify({ name: 'Shop', timeZone: 'Asia/Karachi' }),
		};
		const refreshed = await kit.dashboard(
			await kit.adminSession(),
			'POST',
			`/v1/dashboard/websites/${kit.websiteId}/business/refresh`,
		);
		expect((await refreshed.json()).business.timeZone).toBe('Asia/Karachi');
	});
	afterAll(async () => {
		await kit.close();
	});

	it('counts the daily totals and the analytics days in the business time zone (K8)', async () => {
		await kit.collect([
			{ type: 'page_view', path: '/', visit: true },
			{ type: 'page_view', path: '/shop', visit: false },
		]);
		const db = await kit.merchantDb();
		expect(await db.collection('ss_growth_daily').distinct('day')).toEqual(['2026-10-02']);
		const report = await (await kit.call('GET', '/v1/analytics', { token: kit.server })).json();
		expect(report).toMatchObject({
			from: '2026-09-03',
			to: '2026-10-02',
			timeZone: 'Asia/Karachi',
			totals: { visits: 1, pageViews: 2 },
		});
		expect(report.days.at(-1)).toEqual({ day: '2026-10-02', visits: 1, pageViews: 2 });
		const utcDay = await (await kit.call('GET', '/v1/analytics?from=2026-10-01&to=2026-10-01', { token: kit.server })).json();
		expect(utcDay.totals).toEqual({ visits: 0, pageViews: 0 });
		const invalid = await kit.call('GET', '/v1/analytics?from=2026-02-30&to=2026-03-02', { token: kit.server });
		expect(invalid.status).toBe(422);
		const config = await (await kit.call('GET', '/v1/widget/config', { token: kit.browser, origin: ORIGIN })).json();
		expect(config.timeZone).toBe('Asia/Karachi');
	});

	it('takes the page script’s events from the merchant’s server for one visitor (K3)', async () => {
		/** @param {string | null} ip @param {unknown[]} [events] */
		const fromServer = (ip, events = []) =>
			kit.call('POST', '/v1/collect', {
				token: kit.server,
				body: { events },
				headers: ip ? { 'ss-visitor-ip': ip } : {},
			});
		const noIp = await fromServer(null);
		expect(noIp.status).toBe(400);
		expect(await codeOf(noIp)).toBe('visitor_ip_required');
		const sent = await fromServer(VISITOR, [{ type: 'search', path: '/search', term: 'phone case', results: 3 }]);
		expect(sent.status).toBe(202);
		expect(sent.headers.get('access-control-allow-origin')).toBeNull();
		expect(await sent.json()).toEqual({ accepted: 1 });
		const db = await kit.merchantDb();
		expect(await db.collection('ss_growth_daily').findOne({ metric: 'search', key: 'phone case' })).toMatchObject({
			day: '2026-10-02',
			count: 1,
		});
		// the per-visitor limit (120 a minute) counts by SS-Visitor-IP
		for (let i = 0; i < 119; i += 1) expect((await fromServer(VISITOR)).status).toBe(202);
		const limited = await fromServer(VISITOR);
		expect(limited.status).toBe(429);
		expect((await fromServer('203.0.113.8')).status).toBe(202);
		kit.advance(61_000);
		expect((await fromServer(VISITOR)).status).toBe(202);
	});

	it('counts the raw events with the list’s own filter (K4)', async () => {
		await kit.collect([
			{ type: 'not_found', path: '/old' },
			{ type: 'vital', path: '/', name: 'LCP', value: 900 },
			{ type: 'page_view', path: '/a', visit: false },
		]);
		/** @param {string} path @returns {Promise<any>} */
		const read = async (path) => {
			const response = await kit.call('GET', path, { token: kit.server });
			expect(response.status).toBe(200);
			return response.json();
		};
		const all = (await read('/v1/events?limit=100')).items;
		expect(all).toHaveLength(6);
		expect(await read('/v1/events/count')).toEqual({ count: all.length, capped: false });
		for (const type of ['page_view', 'search', 'vital', 'purchase']) {
			const listed = (await read(`/v1/events?type=${type}&limit=100`)).items;
			expect(await read(`/v1/events/count?type=${type}`)).toEqual({ count: listed.length, capped: false });
		}
		// an unknown type is ignored by the list, so by the count too
		expect((await read('/v1/events?type=bogus&limit=100')).items).toHaveLength(all.length);
		expect(await read('/v1/events/count?type=bogus')).toEqual({ count: all.length, capped: false });
		expect(await read('/v1/events/counts?by=type')).toEqual({
			total: 6,
			groups: { page_view: 3, not_found: 1, search: 1, vital: 1 },
		});
		expect(await read('/v1/events/counts?by=type&type=vital')).toEqual({ total: 1, groups: { vital: 1 } });
		const badBy = await kit.call('GET', '/v1/events/counts?by=path', { token: kit.server });
		expect(badBy.status).toBe(422);
		const viaBrowser = await kit.call('GET', '/v1/events/count', { token: kit.browser, origin: ORIGIN });
		expect(viaBrowser.status).toBe(401);
	});

	it('names the acting user and the widgets’ Format (K2, K7, K9)', async () => {
		const bad = await kit.call('GET', '/v1/analytics', { token: kit.server, headers: { 'ss-actor-id': 'u 1' } });
		expect(bad.status).toBe(400);
		expect(await codeOf(bad)).toBe('invalid_actor');
		const format = await kit.call('PUT', '/v1/format', {
			token: kit.server,
			body: { locale: 'en-GB', currencyDisplay: 'custom', currencySymbol: 'Rs', wholeUnits: true, times: 'business' },
			headers: { 'ss-actor-id': 'u_7', 'ss-actor-name': encodeURIComponent('Ayesha Khan'), 'ss-actor-role': 'Manager' },
		});
		expect(format.status).toBe(200);
		const overview = await (
			await kit.dashboard(await kit.adminSession(), 'GET', `/v1/dashboard/websites/${kit.websiteId}/overview`)
		).json();
		expect(overview.recentChanges[0].who).toEqual({ kind: 'user', id: 'u_7', name: 'Ayesha Khan', role: 'Manager' });
		const config = await (await kit.call('GET', '/v1/widget/config', { token: kit.browser, origin: ORIGIN })).json();
		expect(config.format).toEqual({
			locale: 'en-GB',
			currencyDisplay: 'custom',
			currencySymbol: 'Rs',
			wholeUnits: true,
			times: 'business',
		});
		const ticket = await kit.ticket(['seo.check']);
		const admin = await (await kit.call('GET', '/v1/widget/admin/config', { token: ticket, origin: ADMIN_ORIGIN })).json();
		expect(admin).toMatchObject({ timeZone: 'Asia/Karachi', format: { currencySymbol: 'Rs' } });
		kit.web.pages['/'] = { status: 200, body: HOME };
		const checked = await kit.call('POST', '/v1/admin/seo/checks', {
			token: ticket,
			origin: ADMIN_ORIGIN,
			body: { paths: ['/', '/shop'] },
		});
		expect(checked.status).toBe(200);
		const activity = await (await kit.call('GET', '/v1/activity?action=seo.checked', { token: kit.server })).json();
		expect(activity.items).toEqual([
			expect.objectContaining({
				actor: { kind: 'staff', id: 'u_1', name: 'Sam Staff' },
				target: 'seo_checklist',
				label: '/ and 1 more',
				detail: expect.stringContaining('Pages: /, /shop'),
			}),
		]);
	});
});
