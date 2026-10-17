/**
 * The SEO checklist through the API (SEO audit §3.2 B) on a small fake website: robots.txt and a sitemap index, sample
 * pages of each kind, a missing address, redirect rules on the live site, the 404 log and visitors' Web Vitals; the
 * kept report (one write), a full run asked again within 5 minutes answered from it without a read, page runs that
 * are not kept, the admin twins and the activity log, and refusals. No real network call is made (the site is faked).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIN_INTERVAL_MS } from '../server/seo-checks.js';
import { ADMIN_ORIGIN, ALL, ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

/** @param {unknown} data */
const ld = (data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

/**
 * A page of the fake site.
 * @param {string} path @param {{ title: string, data: unknown, body?: string, head?: string }} page
 */
const pageOf = (path, { title, data, body = '', head = '' }) => ({
	status: 200,
	headers: { 'content-type': 'text/html; charset=utf-8', etag: `"${path.length}"` },
	body: `<!doctype html><html lang="en"><head><title>${title}</title>
<meta name="description" content="${title}: everything about it, with the details shoppers ask for before they buy it.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="${title}"><meta property="og:image" content="${ORIGIN}/media/og.jpg">
<link rel="canonical" href="${ORIGIN}${path.replace('&', '&amp;')}">
<meta name="google-site-verification" content="abc123">${head}${ld(data)}</head>
<body><h1>${title}</h1><img src="/media/a.jpg" alt="A" width="10" height="10">${body}</body></html>`,
});

const BREADCRUMBS = { '@type': 'BreadcrumbList', itemListElement: [] };

/** The fake website: a shop with every kind of page, an old path with a rule and one without. */
const SITE = {
	'/robots.txt': {
		status: 200,
		body: `User-agent: *\nDisallow: /cart\nDisallow: /glossary/\n\nSitemap: ${ORIGIN}/sitemaps/index.xml\n`,
	},
	'/sitemaps/index.xml': {
		status: 200,
		body: `<sitemapindex><sitemap><loc>${ORIGIN}/sitemaps/pages.xml</loc></sitemap><sitemap><loc>${ORIGIN}/sitemaps/products-1.xml</loc></sitemap></sitemapindex>`,
	},
	'/sitemaps/pages.xml': {
		status: 200,
		body: `<urlset>${[
			'/categories/lamps',
			'/categories/shades',
			'/categories/lamps?brand=acme&amp;grade=new',
			'/glossary/linen',
			'/about',
		]
			.map((path) => `<url><loc>${ORIGIN}${path}</loc></url>`)
			.join('')}</urlset>`,
	},
	'/sitemaps/products-1.xml': {
		status: 200,
		body: `<urlset><url><loc>${ORIGIN}/products/blue-lamp</loc><image:image><image:loc>${ORIGIN}/media/blue.jpg</image:loc></image:image></url><url><loc>${ORIGIN}/products/red-lamp</loc></url></urlset>`,
	},
	'/': pageOf('/', {
		title: 'Shop Example: lamps and shades',
		data: {
			'@graph': [
				{ '@type': 'OnlineStore', name: 'Shop Example' },
				{ '@type': 'WebSite', name: 'Shop Example' },
			],
		},
	}),
	'/cart': pageOf('/cart', { title: 'Your cart at Shop Example', data: {}, head: '<meta name="robots" content="noindex">' }),
	'/products/blue-lamp': pageOf('/products/blue-lamp', {
		title: 'Blue Lamp | Shop Example',
		data: {
			'@graph': [
				{
					'@type': 'Product',
					name: 'Blue Lamp',
					image: `${ORIGIN}/media/blue.jpg`,
					offers: { '@type': 'Offer', price: '1250.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
				},
				BREADCRUMBS,
			],
		},
		body: '<p>$1,250.00</p>',
	}),
	'/categories/lamps': pageOf('/categories/lamps', {
		title: 'Lamps | Shop Example',
		data: { '@graph': [{ '@type': 'CollectionPage', name: 'Lamps' }, BREADCRUMBS] },
	}),
	'/categories/lamps?brand=acme&grade=new': pageOf('/categories/lamps?brand=acme&grade=new', {
		title: 'Acme lamps | Shop Example',
		data: { '@graph': [{ '@type': 'CollectionPage', name: 'Acme lamps' }, BREADCRUMBS] },
	}),
	'/glossary/linen': pageOf('/glossary/linen', {
		title: 'Linen | Shop Example',
		data: { '@type': 'DefinedTerm', name: 'Linen' },
	}),
	'/old-lamps': { status: 301, headers: { location: '/categories/lamps' } },
	'/gone-page': pageOf('/gone-page', { title: 'Still here', data: {} }),
};

/** @param {any} report @param {string} id @param {string | null} [page] */
const find = (report, id, page) =>
	report.checks.find((/** @type {any} */ c) => c.id === id && (page === undefined || c.page === page));

beforeAll(async () => {
	env = await setup();
	await env.switchOn(ALL);
});
afterAll(async () => {
	await env.close();
});

describe('SEO checklist: the live site', () => {
	it('needs the merchant database (the report is kept there)', async () => {
		const run = await env.call('POST', '/v1/seo/checks', { token: env.server, body: {} });
		expect(run.status).toBe(403);
		expect((await run.json()).type).toMatch(/database_not_connected$/);
		await env.connectDatabase();
		expect(await (await env.call('GET', '/v1/seo/report', { token: env.server })).json()).toBeNull();
	});

	it('reads the site, samples a page of each kind and reports every check with its reason, fix and test', async () => {
		Object.assign(env.web.pages, SITE);
		await env.setting('seo_checklist', 'paths', ['/', '/cart']);
		// the shop's private pages, kept out with the online store preset (G12)
		await env.setting('robots_verification', 'blockPaths', ['/cart', '/checkout', '/account']);
		await env.setting('visitor_analytics', 'detail', 'sessions');
		const visitor = { session: 'sessionaaaaaaaaaaaaaaaaaaaaaaaaa', browser: 'chrome', os: 'android' };
		await env.collect([
			...Array.from({ length: 5 }, () => ({
				type: 'vital',
				path: '/products/red-lamp',
				name: 'LCP',
				value: 3000,
				...visitor,
			})),
			{ type: 'not_found', path: '/old-page', ...visitor },
			{ type: 'not_found', path: '/old-lamps', ...visitor },
		]);
		const rules = [
			{ from: '/old-lamps', to: '/categories/lamps' },
			{ from: '/gone-page', to: null, code: 410 },
		];
		for (const rule of rules)
			expect((await env.call('POST', '/v1/redirects', { token: env.server, body: rule })).status).toBe(201);

		const before = env.web.calls.length;
		const response = await env.call('POST', '/v1/seo/checks', { token: env.server, body: {} });
		expect(response.status).toBe(200);
		const report = await response.json();
		const read = env.web.calls.slice(before).map((call) => call.url.replace(ORIGIN, ''));
		// robots.txt, the index and its 2 files, the 2 own pages, 5 sitemap addresses, the missing address, 2 old paths
		expect(read).toHaveLength(14);
		expect(read.slice(0, 4)).toEqual(['/robots.txt', '/sitemaps/index.xml', '/sitemaps/pages.xml', '/sitemaps/products-1.xml']);
		expect(read).toContain('/old-lamps');
		expect(read.find((path) => path.startsWith('/this-page-does-not-exist-'))).toBeDefined();
		expect(report.cached).toBe(false);
		expect(report.pages.map((/** @type {any} */ { url, kind, sampled }) => ({ url, kind, sampled }))).toEqual([
			{ url: `${ORIGIN}/`, kind: 'home', sampled: false },
			{ url: `${ORIGIN}/cart`, kind: 'WebPage', sampled: false },
			{ url: `${ORIGIN}/products/blue-lamp`, kind: 'Product', sampled: true },
			{ url: `${ORIGIN}/categories/lamps?brand=acme&grade=new`, kind: 'CollectionPage', sampled: true },
			{ url: `${ORIGIN}/categories/lamps`, kind: 'CollectionPage', sampled: true },
			{ url: `${ORIGIN}/glossary/linen`, kind: 'DefinedTerm', sampled: true },
		]);
		// each page read carries its head, for the checklist's search result and share preview (R7 #105)
		expect(report.pages[2].head).toEqual({
			title: 'Blue Lamp | Shop Example',
			description: 'Blue Lamp | Shop Example: everything about it, with the details shoppers ask for before they buy it.',
			url: `${ORIGIN}/products/blue-lamp`,
			image: `${ORIGIN}/media/og.jpg`,
			siteName: '',
		});
		/** @param {string} id @param {string | null} [page] */
		const result = (id, page) => {
			const item = find(report, id, page);
			return item ? `${item.status} ${item.finding}` : undefined;
		};
		expect({
			robots_txt: result('robots_txt'),
			robots_sitemap: result('robots_sitemap'),
			robots_blocks: result('robots_blocks'),
			sitemap: result('sitemap'),
			sitemap_urls: result('sitemap_urls'),
			soft_404: result('soft_404'),
			redirects_live: result('redirects_live'),
			redirect_suggestions: result('redirect_suggestions'),
			verification: result('verification'),
			web_vitals_site: result('web_vitals_site'),
		}).toEqual({
			robots_txt: 'pass ok',
			robots_sitemap: 'pass ok',
			robots_blocks: 'fail blocked',
			sitemap: 'pass ok',
			sitemap_urls: 'fail bad',
			soft_404: 'pass ok',
			redirects_live: 'fail not_applied',
			redirect_suggestions: 'warn some',
			verification: 'pass ok',
			web_vitals_site: 'warn needs_improvement',
		});
		// a sample page blocked fails; /cart, one of the checklist's pages, is kept out on purpose (robots presets, G12)
		expect(find(report, 'robots_blocks')).toMatchObject({
			page: `${ORIGIN}/robots.txt`,
			detail: { count: 1, path: '/glossary/linen', rule: 'Disallow: /glossary/' },
			title: 'robots.txt lets Google read your pages',
			reason: 'robots.txt keeps Google from 1 of the addresses checked, for example /glossary/linen (Disallow: /glossary/).',
			fix: expect.stringContaining('Remove or narrow that rule'),
			test: null,
		});
		expect(find(report, 'sitemap')).toMatchObject({ detail: { count: 7 } });
		expect(find(report, 'sitemap_urls')).toMatchObject({ detail: { count: 1, path: '/about', status: 404 } });
		expect(find(report, 'redirects_live')).toMatchObject({
			detail: { count: 1, path: '/gone-page', status: 200, expected: 410 },
		});
		// the old path with a rule is not a suggestion
		expect(find(report, 'redirect_suggestions')).toMatchObject({ detail: { count: 1, path: '/old-page', hits: 1 } });
		expect(find(report, 'web_vitals_site')).toMatchObject({ detail: { vital: 'LCP', good: 0, samples: 5 } });

		const product = `${ORIGIN}/products/blue-lamp`;
		for (const id of ['reachable', 'canonical', 'product_data', 'price_match', 'server_html', 'breadcrumbs', 'caching'])
			expect(result(id, product), id).toBe('pass ok');
		expect(find(report, 'web_vitals', product)).toMatchObject({
			status: 'warn',
			finding: 'needs_improvement',
			detail: { pattern: '/products/*', vital: 'LCP', value: '3.0 s', samples: 5 },
			reason: 'Pages like /products/* need improvement: LCP averaged 3.0 s over the last 28 days (measurements: 5).',
			test: `https://search.google.com/test/rich-results?url=${encodeURIComponent(product)}`,
		});
		expect(find(report, 'price_match', product)).toMatchObject({
			reason: 'The page shows the price of its structured data (1250.00 USD).',
			fix: '',
		});
		expect(result('site_data', `${ORIGIN}/`)).toBe('pass ok');
		expect(result('noindex', `${ORIGIN}/cart`)).toBe('fail noindex');
		expect(result('breadcrumbs', `${ORIGIN}/glossary/linen`)).toBeUndefined();
		expect(report.summary).toEqual({
			pass: report.checks.filter((/** @type {any} */ c) => c.status === 'pass').length,
			warn: report.checks.filter((/** @type {any} */ c) => c.status === 'warn').length,
			fail: report.checks.filter((/** @type {any} */ c) => c.status === 'fail').length,
			ignored: 0,
		});

		// kept: one document, read back by GET /v1/seo/report with the texts of now
		const db = await env.merchantDb();
		expect(await db.collection('ss_growth_seo_reports').countDocuments()).toBe(1);
		const kept = await (await env.call('GET', '/v1/seo/report', { token: env.server })).json();
		expect(kept).toEqual({ ...report, cached: true });
	});

	it('answers a full run asked again within 5 minutes from the kept report, without reading the site', async () => {
		const kept = await (await env.call('GET', '/v1/seo/report', { token: env.server })).json();
		const before = env.web.calls.length;
		env.advance(MIN_INTERVAL_MS - 1000);
		const again = await (await env.call('POST', '/v1/seo/checks', { token: env.server, body: {} })).json();
		expect(again).toEqual(kept);
		expect(env.web.calls.length).toBe(before);
		// a page run is read now, has no sample pages and is not kept
		const page = await (
			await env.call('POST', '/v1/seo/checks', { token: env.server, body: { paths: ['/products/blue-lamp'] } })
		).json();
		expect(page.cached).toBe(false);
		expect(page.pages.map((/** @type {any} */ { url, kind, sampled }) => ({ url, kind, sampled }))).toEqual([
			{ url: `${ORIGIN}/`, kind: 'home', sampled: false },
			{ url: `${ORIGIN}/products/blue-lamp`, kind: 'Product', sampled: false },
		]);
		expect(env.web.calls.length).toBeGreaterThan(before);
		expect((await (await env.call('GET', '/v1/seo/report', { token: env.server })).json()).checkedAt).toBe(kept.checkedAt);
		// 5 minutes after it, a full run reads the site again and is kept
		env.advance(1000);
		const fresh = await (await env.call('POST', '/v1/seo/checks', { token: env.server, body: {} })).json();
		expect(fresh.cached).toBe(false);
		expect(fresh.checkedAt).not.toBe(kept.checkedAt);
		expect((await (await env.call('GET', '/v1/seo/report', { token: env.server })).json()).checkedAt).toBe(fresh.checkedAt);
	});

	it('the widget twins: the kept report, a run from the cache leaves no activity, a page run does', async () => {
		const ticket = await env.ticket(['seo.check']);
		const viaWidget = await env.call('GET', '/v1/admin/seo/report', { token: ticket, origin: ADMIN_ORIGIN });
		expect((await viaWidget.json()).cached).toBe(true);
		const cached = await env.call('POST', '/v1/admin/seo/checks', { token: ticket, origin: ADMIN_ORIGIN, body: {} });
		expect((await cached.json()).cached).toBe(true);
		const db = await env.merchantDb();
		expect(await db.collection('ss_growth_activity').countDocuments({ action: 'seo.checked' })).toBe(0);
		const ran = await env.call('POST', '/v1/admin/seo/checks', { token: ticket, origin: ADMIN_ORIGIN, body: { paths: ['/'] } });
		expect((await ran.json()).pages).toEqual([
			{ url: `${ORIGIN}/`, kind: 'home', sampled: false, head: expect.objectContaining({ url: `${ORIGIN}/` }) },
		]);
		expect(await db.collection('ss_growth_activity').findOne({ action: 'seo.checked' })).toMatchObject({
			actor: { kind: 'staff', id: 'u_1', name: 'Sam Staff' },
			target: 'seo_checklist',
			label: '/',
			detail: expect.stringMatching(/^\d+ passed, \d+ to improve, \d+ to fix\. Pages: \/$/),
		});
		for (const paths of ['x', Array.from({ length: 21 }, () => '/')]) {
			const refused = await env.call('POST', '/v1/admin/seo/checks', { token: ticket, origin: ADMIN_ORIGIN, body: { paths } });
			expect(refused.status).toBe(422);
		}
	});

	it('ignores a finding per page from the widget, and counts it apart (G9)', async () => {
		const ticket = await env.ticket(['seo.check']);
		const before = await (await env.call('GET', '/v1/admin/seo/report', { token: ticket, origin: ADMIN_ORIGIN })).json();
		// a finding of one page (its Rich Results Test link marks a page check)
		const caching = before.checks.find((/** @type {any} */ item) => item.status !== 'pass' && item.test !== null);
		expect(caching).toBeDefined();
		const id = caching.id;
		const path = new URL(caching.page).pathname;
		const ignore = await env.call('PUT', '/v1/admin/seo/ignored', {
			token: ticket,
			origin: ADMIN_ORIGIN,
			body: { check: id, page: path, ignored: true },
		});
		expect(ignore.status).toBe(200);
		expect((await ignore.json()).value).toEqual([{ check: id, page: path }]);
		const after = await (await env.call('GET', '/v1/admin/seo/report', { token: ticket, origin: ADMIN_ORIGIN })).json();
		const same = after.checks.find((/** @type {any} */ item) => item.id === id && item.page === caching.page);
		expect(same.ignored).toBe(true);
		expect(after.summary.ignored).toBe(1);
		expect(after.summary[caching.status]).toBe(before.summary[caching.status] - 1);
		// shown again
		await env.call('PUT', '/v1/admin/seo/ignored', {
			token: ticket,
			origin: ADMIN_ORIGIN,
			body: { check: id, page: path, ignored: false },
		});
		const again = await (await env.call('GET', '/v1/admin/seo/report', { token: ticket, origin: ADMIN_ORIGIN })).json();
		expect(again.summary).toEqual(before.summary);
		expect(
			(await env.call('PUT', '/v1/admin/seo/ignored', { token: ticket, origin: ADMIN_ORIGIN, body: { check: 'Bad id' } }))
				.status,
		).toBe(422);
	});

	it('says what is wrong when the site does not answer', async () => {
		env.web.siteDown(true);
		const down = await (await env.call('POST', '/v1/seo/checks', { token: env.server, body: { paths: [] } })).json();
		env.web.siteDown(false);
		expect(find(down, 'robots_txt')).toMatchObject({ status: 'fail', finding: 'error', detail: { status: 0 } });
		expect(find(down, 'robots_blocks')).toBeUndefined();
		expect(find(down, 'sitemap')).toMatchObject({ status: 'warn', finding: 'missing' });
		expect(find(down, 'soft_404')).toMatchObject({ status: 'fail', finding: 'error' });
		expect(find(down, 'reachable')).toMatchObject({
			status: 'fail',
			finding: 'unreachable',
			reason: 'The page could not be reached: its address does not answer or is not a public https address.',
		});
		expect(find(down, 'verification')).toBeUndefined();
		// a page that could not be read has no head
		expect(down.pages).toEqual([{ url: `${ORIGIN}/`, kind: 'home', sampled: false, head: null }]);
	});

	it('runs at most 10 times an hour per website, through the API and the widget together', async () => {
		env.advance(60 * 60_000);
		const ticket = await env.ticket(['seo.check']);
		const viaApi = () => env.call('POST', '/v1/seo/checks', { token: env.server, body: {} });
		const viaWidget = () => env.call('POST', '/v1/admin/seo/checks', { token: ticket, origin: ADMIN_ORIGIN, body: {} });
		for (let run = 0; run < 5; run += 1) {
			expect((await viaApi()).status).toBe(200);
			expect((await viaWidget()).status).toBe(200);
		}
		expect((await viaWidget()).status).toBe(429);
		expect((await viaApi()).status).toBe(429);
	});
});

describe('SEO checklist: a missing product (SEO audit §3.2 B)', () => {
	/** @type {Awaited<ReturnType<typeof setup>>} */
	let own;
	beforeAll(async () => {
		own = await setup();
		await own.switchOn(ALL);
		await own.connectDatabase();
		Object.assign(own.web.pages, SITE);
	});
	afterAll(async () => {
		await own.close();
	});

	/** A full run, past the kept report's 5 minutes. */
	const fullRun = async () => {
		own.advance(MIN_INTERVAL_MS);
		const before = own.web.calls.length;
		const report = await (await own.call('POST', '/v1/seo/checks', { token: own.server, body: {} })).json();
		return { report, read: own.web.calls.slice(before).map((call) => call.url.replace(ORIGIN, '')) };
	};

	it('without a removed product in the 404 log, tries a made-up address', async () => {
		const { report, read } = await fullRun();
		expect(find(report, 'soft_404')).toMatchObject({ status: 'pass', finding: 'ok', detail: { status: 404 } });
		expect(find(report, 'soft_404').page).toMatch(/\/this-page-does-not-exist-[0-9a-f]{8}$/);
		expect(read.filter((path) => path.startsWith('/this-page-does-not-exist-'))).toHaveLength(1);
	});

	it('tries the 404 log’s most visited removed product instead: a soft 404, moved to its replacement, back again', async () => {
		const visitor = { session: 'sessionbbbbbbbbbbbbbbbbbbbbbbbbb', browser: 'chrome', os: 'android' };
		await own.collect([
			{ type: 'not_found', path: '/products/old-lamp', ...visitor },
			{ type: 'not_found', path: '/products/old-lamp', ...visitor },
			{ type: 'not_found', path: '/products/older-lamp', ...visitor },
			{ type: 'not_found', path: '/old-page', ...visitor },
		]);
		// the product route shows its not-found page with 200: the soft 404 a made-up address at the root does not show
		own.web.pages['/products/old-lamp'] = pageOf('/products/old-lamp', { title: 'Sorry, this lamp is gone', data: {} });
		const soft = await fullRun();
		expect(find(soft.report, 'soft_404')).toMatchObject({
			status: 'fail',
			finding: 'soft',
			page: `${ORIGIN}/products/old-lamp`,
			detail: { status: 200, path: '/products/old-lamp' },
			reason:
				'/products/old-lamp, an address your site does not have, answered 200 (a soft 404), so search engines may index empty pages.',
		});
		expect(soft.read.filter((path) => path.startsWith('/this-page-does-not-exist-'))).toEqual([]);

		own.web.pages['/products/old-lamp'] = { status: 308, headers: { location: '/products/blue-lamp' } };
		expect(find((await fullRun()).report, 'soft_404')).toMatchObject({
			status: 'pass',
			finding: 'moved',
			detail: { status: 308, location: '/products/blue-lamp', path: '/products/old-lamp' },
		});

		// a product page again (it came back): the made-up address is read instead
		own.web.pages['/products/old-lamp'] = SITE['/products/blue-lamp'];
		const back = await fullRun();
		expect(back.read).toContain('/products/old-lamp');
		expect(find(back.report, 'soft_404')).toMatchObject({ status: 'pass', finding: 'ok', detail: { status: 404 } });
		expect(find(back.report, 'soft_404').page).toMatch(/\/this-page-does-not-exist-/);
	});
});
