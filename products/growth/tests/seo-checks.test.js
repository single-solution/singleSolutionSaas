/**
 * The SEO health report's reading and checks (SEO audit §3.2 B), on HTML, robots.txt and sitemap fixtures: every
 * check's pass, warn and fail. Pure: no network (reads are given as `Fetched` values).
 */
import { describe, expect, it } from 'vitest';
import {
	CHECKS,
	MAX_CANDIDATES,
	SITE_CHECKS,
	candidatesOf,
	keptOutBy,
	isProductKind,
	kindOf,
	pageChecks,
	pageVitalsOf,
	pagesOf,
	patternOf,
	productOf,
	redirectsLiveCheck,
	removedProductOf,
	richResultsTestOf,
	robotsChecks,
	siteVitalsCheck,
	sitemapCheck,
	sitemapUrlsCheck,
	soft404Check,
	suggestionsCheck,
	summaryOf,
	verificationCheck,
} from '../core/seo-checks.js';
import {
	allNodesOf,
	attributesOf,
	numbersIn,
	robotsAllows,
	robotsGroupsOf,
	scanHtml,
	sitemapOf,
	sitemapsIn,
	typesOf,
} from '../core/seo-scan.js';

const DOMAIN = 'shop.example.com';
const ORIGIN = `https://${DOMAIN}`;

/** @typedef {import('../core/seo-checks.js').Fetched} Fetched */
/** @typedef {import('../core/seo-checks.js').Check} Check */

/**
 * A read of the site.
 * @param {string} path @param {Partial<Fetched>} [rest]
 * @returns {Fetched}
 */
const read = (path, rest = {}) => ({
	url: `${ORIGIN}${path}`,
	status: 200,
	headers: {},
	body: '',
	ms: 120,
	error: null,
	...rest,
});

/** @param {unknown} data */
const ld = (data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

/**
 * A page with everything a search engine wants; `head` and `body` add to it, `jsonLd` replaces its structured data.
 * @param {{ path?: string, head?: string, body?: string, jsonLd?: string, title?: string, canonical?: string | null }} [parts]
 */
const html = ({
	path = '/products/blue-lamp',
	head = '',
	body = '',
	jsonLd,
	title = 'Blue Lamp | Shop Example',
	canonical,
} = {}) =>
	`<!doctype html><html lang="en"><head><title>${title}</title>
<meta name="description" content="A blue table lamp with a linen shade, a warm light and a five-year warranty; ships in two days.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="Blue Lamp"><meta property="og:image" content="${ORIGIN}/media/blue-lamp.jpg">
${canonical === null ? '' : `<link rel="canonical" href="${canonical ?? `${ORIGIN}${path}`}">`}
${jsonLd ?? ld({ '@context': 'https://schema.org', '@type': 'WebPage', name: 'A page' })}
${head}</head><body><h1>Blue Lamp</h1><img src="/media/blue-lamp.jpg" alt="A blue lamp" width="800" height="800">${body}</body></html>`;

const PRODUCT = {
	'@context': 'https://schema.org',
	'@graph': [
		{
			'@type': 'Product',
			name: 'Blue Lamp',
			image: [`${ORIGIN}/media/blue-lamp.jpg`, { '@type': 'ImageObject', url: 'https://cdn.example.net/lamp-2.jpg' }],
			offers: { '@type': 'Offer', price: '1250.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
		},
		{ '@type': 'BreadcrumbList', itemListElement: [] },
	],
};

/**
 * Each check by id: status and finding, after checking every finding is one the check names.
 * @param {Check[]} checks
 */
const byId = (checks) => {
	for (const item of checks) expect(CHECKS[item.id], `${item.id}: ${item.finding}`).toContain(item.finding);
	return Object.fromEntries(checks.map((item) => [item.id, `${item.status} ${item.finding}`]));
};

/**
 * The checks of a page that answered 200.
 * @param {string} body @param {{ path?: string, listed?: boolean, headers?: Record<string, string>, ms?: number | null }} [options]
 */
const checksOf = (body, { path = '/products/blue-lamp', listed = false, headers = {}, ms = 120 } = {}) =>
	pageChecks(read(path, { body, headers, ms }), { domain: DOMAIN, listed });

describe('reading pages', () => {
	it('reads tags, entities, text without scripts, and JSON-LD blocks', () => {
		expect(attributesOf('<img src=a.png alt="" data-x=\'y\' title="A &amp; B" hidden>')).toEqual({
			src: 'a.png',
			alt: '',
			'data-x': 'y',
			title: 'A & B',
			hidden: '',
		});
		// references as HTML reads them (@ss/contracts/text): an unknown name stays as written, even one every object has
		// (`&constructor;`), and a code point that is no character becomes U+FFFD
		expect(attributesOf('<a title="&#36;12 &#x20B9;5 &AMP; &nbsp;&bogus; &constructor; &#0; &#xD800;">')).toEqual({
			title: '$12 ₹5 & \u00a0&bogus; &constructor; \uFFFD \uFFFD',
		});
		const scan = scanHtml(
			`<!-- <title>no</title> --><html lang=en><title> A &amp; B&nbsp;&lt;&gt;&quot;&#39; </title>
<script>var x = "<h1>"</script><style>h1 { color: red }</style><template><h1>later</h1></template>
<meta name="googlebot" content="NoIndex">
<script type="application/ld+json"><!-- {"@type":"Organization","name":"Shop"} --></script>
<script type='application/ld+json'><![CDATA[{"@graph":[{"@type":["schema:Product"],"name":"P"},[{"@type":"WebSite"}]]}]]></script>
<script type="application/ld+json">{ broken</script>
<h1 class="x">Main</h1><p>Price: <b>$1,250.00</b></p><noscript><img src="/pixel.gif"></noscript>`,
		);
		expect(scan).toMatchObject({ title: 'A & B <>"\'', lang: 'en', h1: 1, description: null });
		expect(scan.robots).toBe('noindex');
		expect(scan.canonicals).toEqual([]);
		expect(scan.images).toBe(0);
		expect(scan.jsonLd.blocks).toBe(3);
		expect(scan.jsonLd.invalid).toBe(1);
		expect(scan.jsonLd.nodes.map((node) => typesOf(node)[0])).toEqual(['Organization', 'Product', 'WebSite']);
		expect(scan.text).toBe('Main Price: $1,250.00');
		expect(typesOf('Product')).toEqual([]);
		expect(typesOf({ '@type': ['https://schema.org/Store', 3] })).toEqual(['Store']);
		expect(allNodesOf([{ a: { b: [{ c: 1 }] } }])).toHaveLength(3);
	});

	it('reads a hostile page quickly: tags, comments and scripts left open, many times over', () => {
		const size = 200_000;
		/** @param {string} part */
		const page = (part) => part.repeat(Math.ceil(size / part.length));
		const started = performance.now();
		for (const part of ['<!--', '<script>', '<style ', '<title>', '<head ', '<meta ', '< a ', '<img alt="', '<html'])
			scanHtml(`<html lang="en"><title>T</title>${page(part)}`);
		expect(performance.now() - started).toBeLessThan(1000);
		// what is closed is still read
		expect(scanHtml(`<title>T</title><h1>A</h1>${page('<!--')}`)).toMatchObject({ title: 'T', h1: 1 });
	});

	it('finds a price however the page writes it', () => {
		for (const [text, value] of /** @type {Array<[string, number]>} */ ([
			['$1,250.00', 1250],
			['1.250,00 €', 1250],
			['CHF 1’250', 1250],
			['1\u00a0250,50', 1250.5],
			['Only 12.5 left', 12.5],
			['7', 7],
		]))
			expect(numbersIn(text), text).toContain(value);
		expect(numbersIn('2026-10-15')).toEqual([2026, 10, 15]);
		expect(numbersIn('no numbers')).toEqual([]);
	});

	it('tells the kind of a page from its address and its main schema.org type (G11)', () => {
		/** @param {unknown} data @param {string} [path] */
		const kind = (data, path = '/x') => kindOf(`${ORIGIN}${path}`, scanHtml(ld(data)));
		expect(kind({}, '/')).toBe('home');
		expect(kind({ '@type': 'Product' }, '/?ref=a')).toBe('Product');
		expect(kind(PRODUCT)).toBe('Product');
		expect(kind({ '@type': 'ItemPage', mainEntity: { '@type': 'ProductGroup' } })).toBe('ProductGroup');
		expect(kind({ '@type': 'WebPage', mainEntity: [{ '@type': 'DefinedTerm' }] })).toBe('DefinedTerm');
		expect(kind({ '@graph': [{ '@type': 'CollectionPage' }, { '@type': 'ItemList' }] })).toBe('CollectionPage');
		expect(kind({ '@type': 'CollectionPage' }, '/lamps?brand=acme')).toBe('CollectionPage');
		// products listed in a category's ItemList do not make it a product page
		expect(kind({ '@type': 'ItemList', itemListElement: [{ item: { '@type': 'Product' } }] })).toBe('ItemList');
		expect(kind({ '@type': 'AboutPage', mainEntity: 'x' })).toBe('AboutPage');
		// any kind of site: an article, an event, a service; the site's own nodes never name the page
		expect(kind({ '@graph': [{ '@type': 'WebSite' }, { '@type': 'Organization' }, { '@type': 'BlogPosting' }] })).toBe(
			'BlogPosting',
		);
		expect(kind({ '@type': 'Event' })).toBe('Event');
		expect(kind({ '@graph': [{ '@type': 'WebSite' }, { '@type': 'BreadcrumbList' }] })).toBe('WebPage');
		expect(kind({ '@type': 'Dentist' })).toBe('Dentist');
		expect(isProductKind('ProductGroup')).toBe(true);
		expect(isProductKind('CollectionPage')).toBe(false);
	});

	it('reads the product of a page: a product or each variant of a group', () => {
		const group = productOf(
			scanHtml(
				ld({
					'@type': 'ProductGroup',
					name: ' Lamp ',
					hasVariant: [
						{ '@type': 'Product', image: 'a.jpg', offers: { price: 10, priceCurrency: 'USD', availability: 'InStock' } },
						{ '@type': 'Product', offers: { priceSpecification: [{ price: '12.50', priceCurrency: 'USD' }] } },
						'not a node',
					],
				}),
			).jsonLd.nodes,
		);
		expect(group).toEqual({
			name: 'Lamp',
			image: true,
			images: ['a.jpg'],
			offers: [
				{ price: 10, currency: 'USD', availability: true },
				{ price: 12.5, currency: 'USD', availability: false },
			],
		});
		expect(productOf(scanHtml(ld({ '@type': 'Product', offers: 'free' })).jsonLd.nodes)?.offers).toEqual([
			{ price: null, currency: null, availability: false },
		]);
		expect(productOf([])).toBeNull();
	});
});

describe('checks of a page', () => {
	it('a complete product page passes every check', () => {
		const checks = checksOf(
			html({ jsonLd: ld(PRODUCT), body: '<p class="price">$1,250.00</p><script>window.price = 999</script>' }),
			{ listed: true, headers: { etag: '"v1"' }, ms: 300 },
		);
		expect(checks.kind).toBe('Product');
		expect(byId(checks.checks)).toEqual({
			reachable: 'pass ok',
			noindex: 'pass ok',
			title: 'pass ok',
			description: 'pass ok',
			h1: 'pass ok',
			canonical: 'pass ok',
			lang: 'pass ok',
			viewport: 'pass ok',
			social: 'pass ok',
			image_alt: 'pass ok',
			image_size: 'pass ok',
			structured_data: 'pass ok',
			product_data: 'pass ok',
			price_match: 'pass ok',
			server_html: 'pass ok',
			breadcrumbs: 'pass ok',
			response_time: 'pass ok',
			caching: 'pass ok',
		});
		expect(checks.checks.find((item) => item.id === 'price_match')?.detail).toEqual({ price: '1250.00', currency: 'USD' });
		expect(checks.checks[0]?.detail).toEqual({ status: 200, ms: 300 });
	});

	it('a product drawn by scripts: no price or name in the server HTML, and missing data', () => {
		const scripted = byId(
			checksOf(
				`<html><head><title>Blue Lamp</title>${ld(PRODUCT)}</head><body><div id="app"></div><script>render("Blue Lamp", "$1,250.00")</script></body></html>`,
			).checks,
		);
		expect(scripted).toMatchObject({
			price_match: 'fail not_shown',
			server_html: 'fail missing',
			h1: 'warn missing',
			canonical: 'warn missing',
			lang: 'warn missing',
			viewport: 'fail missing',
			social: 'warn missing',
			description: 'warn missing',
			title: 'warn short',
		});
		/** @param {unknown} product */
		const dataOf = (product) => {
			const checks = checksOf(html({ jsonLd: ld(product), body: '<p>$10</p>' })).checks;
			return checks.find((item) => item.id === 'product_data');
		};
		expect(dataOf({ '@type': 'Product', name: 'Blue Lamp' })).toMatchObject({
			status: 'fail',
			finding: 'incomplete',
			detail: { missing: 'offers.price, offers.priceCurrency, image, offers.availability' },
		});
		expect(
			dataOf({ '@type': 'Product', offers: { price: 10, priceCurrency: 'USD', availability: 'InStock' }, image: 'a' }),
		).toMatchObject({ status: 'fail', finding: 'incomplete', detail: { missing: 'name' } });
		expect(dataOf({ '@type': 'Product', name: 'Blue Lamp', offers: { price: 10, priceCurrency: 'USD' } })).toMatchObject({
			status: 'warn',
			finding: 'partial',
			detail: { missing: 'image, offers.availability' },
		});
		// one variant's price shown is enough; without a name there is no server_html check
		const variants = byId(
			checksOf(
				html({
					jsonLd: ld({
						'@type': 'ProductGroup',
						hasVariant: [{ offers: { price: 10, priceCurrency: 'USD' } }, { offers: { price: 12 } }],
					}),
					body: '<p>From 12.00</p>',
				}),
			).checks,
		);
		expect(variants.price_match).toBe('pass ok');
		expect(variants.server_html).toBeUndefined();
		// no price at all: no price check
		expect(byId(checksOf(html({ jsonLd: ld({ '@type': 'Product', name: 'Blue Lamp' }) })).checks).price_match).toBeUndefined();
	});

	it('the home page needs Organization and WebSite; categories, listings and products need breadcrumbs', () => {
		const home = checksOf(html({ path: '/', jsonLd: ld({ '@type': 'WebSite', name: 'Shop' }) }), { path: '/' });
		expect(home.kind).toBe('home');
		expect(home.checks.find((item) => item.id === 'site_data')).toMatchObject({
			status: 'warn',
			finding: 'missing',
			detail: { missing: 'Organization' },
		});
		expect(byId(checksOf(html({ path: '/', jsonLd: '' }), { path: '/' }).checks).site_data).toBe('warn missing');
		const full = ld({
			'@graph': [
				{ '@type': 'OnlineStore', name: 'Shop' },
				{ '@type': 'WebSite', name: 'Shop' },
			],
		});
		expect(byId(checksOf(html({ path: '/', jsonLd: full }), { path: '/' }).checks).site_data).toBe('pass ok');
		// every Organization type of schema.org (G10): a bakery, a dentist, a plumber or a school
		for (const type of [
			'Corporation',
			'ClothingStore',
			'OnlineBusiness',
			'NewsMediaOrganization',
			'Bakery',
			'Dentist',
			'Plumber',
			'School',
			'Library',
			'Physician',
		])
			expect(
				byId(checksOf(html({ path: '/', jsonLd: ld([{ '@type': type }, { '@type': 'WebSite' }]) }), { path: '/' }).checks)
					.site_data,
			).toBe('pass ok');
		const category = checksOf(html({ path: '/categories/lamps', jsonLd: ld({ '@type': 'CollectionPage' }) }), {
			path: '/categories/lamps',
		});
		expect(category.kind).toBe('CollectionPage');
		expect(byId(category.checks).breadcrumbs).toBe('warn missing');
		const glossary = checksOf(html({ path: '/glossary/linen', jsonLd: ld({ '@type': 'DefinedTerm' }) }), {
			path: '/glossary/linen',
		});
		expect(glossary.kind).toBe('DefinedTerm');
		expect(byId(glossary.checks).breadcrumbs).toBeUndefined();
	});

	it('canonical links: one, absolute, on the website, the page itself', () => {
		/** @param {string | null} canonical @param {{ listed?: boolean, head?: string }} [options] */
		const canonicalOf = (canonical, { listed = false, head = '' } = {}) =>
			checksOf(html({ canonical, head }), { listed }).checks.find((item) => item.id === 'canonical');
		expect(canonicalOf(null)).toMatchObject({ status: 'warn', finding: 'missing' });
		expect(canonicalOf(`${ORIGIN}/products/blue-lamp#top`)).toMatchObject({ status: 'pass', finding: 'ok' });
		// the same address twice is one canonical
		expect(
			canonicalOf(`${ORIGIN}/products/blue-lamp`, { head: `<link rel="canonical" href="${ORIGIN}/products/blue-lamp">` }),
		).toMatchObject({
			finding: 'ok',
		});
		expect(canonicalOf(`${ORIGIN}/a`, { head: `<link rel="Canonical alternate" href="${ORIGIN}/b">` })).toMatchObject({
			status: 'fail',
			finding: 'several',
			detail: { count: 2 },
		});
		expect(canonicalOf('/products/blue-lamp')).toMatchObject({ status: 'warn', finding: 'relative' });
		expect(canonicalOf('https://other.example/products/blue-lamp')).toMatchObject({ status: 'warn', finding: 'other_host' });
		expect(canonicalOf(`${ORIGIN}/`)).toMatchObject({ status: 'warn', finding: 'other_page', detail: { url: `${ORIGIN}/` } });
		expect(canonicalOf(`${ORIGIN}/`, { listed: true })).toMatchObject({ status: 'fail', finding: 'not_self' });
		expect(canonicalOf('http://[bad')).toMatchObject({ status: 'fail', finding: 'invalid' });
	});

	it('noindex, titles, descriptions, headings and images', () => {
		expect(byId(checksOf(html({ head: '<meta name="robots" content="none">' })).checks).noindex).toBe('fail noindex');
		expect(byId(checksOf(html(), { headers: { 'x-robots-tag': 'googlebot: noindex' } }).checks).noindex).toBe('fail noindex');
		expect(
			byId(checksOf(html({ head: '<meta name="robots" content="noindex, follow">' }), { listed: true }).checks).noindex,
		).toBe('fail in_sitemap');
		expect(byId(checksOf(html({ title: '' })).checks).title).toBe('fail missing');
		expect(byId(checksOf(html({ title: 'x'.repeat(61) })).checks).title).toBe('warn long');
		const long = html({ head: `<meta name="description" content="${'d'.repeat(161)}">` }).replace(
			/<meta name="description"[^>]*>\n/,
			'',
		);
		expect(byId(checksOf(long).checks).description).toBe('warn long');
		const short = html().replace(/content="A blue[^"]*"/, 'content="Short."');
		expect(byId(checksOf(short).checks).description).toBe('warn short');
		expect(byId(checksOf(html({ body: '<h1>Again</h1>' })).checks).h1).toBe('warn several');
		const images = checksOf(
			html({ body: '<img src="/a.jpg"><img src="/b.jpg" alt="B" width="10"><noscript><img src="/px.gif"></noscript>' }),
		).checks;
		expect(images.find((item) => item.id === 'image_alt')).toMatchObject({
			status: 'warn',
			finding: 'missing',
			detail: { count: 1 },
		});
		expect(images.find((item) => item.id === 'image_size')).toMatchObject({
			status: 'warn',
			finding: 'missing',
			detail: { count: 2 },
		});
		expect(byId(checksOf(html({ jsonLd: '' })).checks).structured_data).toBe('warn none');
		expect(
			checksOf(html({ head: '<script type="application/ld+json">{oops</script>' })).checks.find(
				(c) => c.id === 'structured_data',
			),
		).toMatchObject({ status: 'fail', finding: 'invalid', detail: { count: 1 } });
	});

	it('speed: the response time and the caching headers', () => {
		/** @param {number | null} ms @param {Record<string, string>} [headers] */
		const speed = (ms, headers = {}) => {
			const checks = byId(checksOf(html(), { ms, headers }).checks);
			return [checks.response_time, checks.caching];
		};
		expect(speed(800, { 'last-modified': 'Wed, 14 Oct 2026 10:00:00 GMT' })).toEqual(['pass ok', 'pass ok']);
		expect(speed(1800)).toEqual(['warn slow', 'warn none']);
		expect(speed(1801)).toEqual(['fail very_slow', 'warn none']);
		expect(speed(null)).toEqual([undefined, 'warn none']);
		// Cache-Control: a validator kept by any cache that may store the page; no-store keeps nothing to ask again about
		for (const value of ['private, no-cache', 'public, max-age=60, stale-while-revalidate=600', 'max-age=0, must-revalidate'])
			expect(speed(100, { etag: '"a"', 'cache-control': value })).toEqual(['pass ok', 'pass ok']);
		const stored = checksOf(html(), { headers: { etag: '"a"', 'cache-control': 'Private, No-Store' } }).checks;
		expect(stored.find((item) => item.id === 'caching')).toMatchObject({
			status: 'warn',
			finding: 'no_store',
			detail: { cacheControl: 'Private, No-Store' },
		});
		expect(speed(100, { 'cache-control': 'no-store' })).toEqual(['pass ok', 'warn no_store']);
		expect(speed(100, { 'cache-control': 'public, max-age=3600' })).toEqual(['pass ok', 'warn none']);
	});

	it('a page that did not answer 200 has only its reachable check', () => {
		/** @param {Partial<Fetched>} rest @param {boolean} [listed] */
		const reachable = (rest, listed = false) => {
			const result = pageChecks(read('/a', { ms: null, ...rest }), { domain: DOMAIN, listed });
			expect(result.checks).toHaveLength(1);
			return result.checks[0];
		};
		expect(reachable({ status: 301, headers: { location: '/b' } })).toMatchObject({
			status: 'warn',
			finding: 'redirect',
			detail: { status: 301, location: '/b' },
		});
		expect(reachable({ status: 308 }, true)).toMatchObject({ status: 'fail', finding: 'redirect', detail: { location: '' } });
		expect(reachable({ status: 404 })).toMatchObject({ status: 'fail', finding: 'not_found' });
		expect(reachable({ status: 410 })).toMatchObject({ finding: 'not_found' });
		expect(reachable({ status: 503 })).toMatchObject({ status: 'fail', finding: 'error', detail: { status: 503 } });
		for (const error of /** @type {const} */ (['timeout', 'too_large', 'unreachable']))
			expect(reachable({ status: null, error })).toMatchObject({ status: 'fail', finding: error, detail: { status: 0 } });
		expect(reachable({ status: null, error: null })).toMatchObject({ finding: 'unreachable' });
		expect(reachable({ status: null, error: 'time' })).toMatchObject({ status: 'warn', finding: 'not_read' });
		expect(pageChecks(read('/', { status: 500 }), { domain: DOMAIN, listed: false }).kind).toBe('home');
	});
});

describe('Web Vitals', () => {
	const rows = [
		{ metric: 'vital_page', key: '/products/a\nLCP', count: 3, sum: 9000 },
		{ metric: 'vital_page', key: '/products/b\nLCP', count: 3, sum: 6000 },
		{ metric: 'vital_page', key: '/products/b\nINP', count: 6, sum: 600 },
		{ metric: 'vital_page', key: '/products/b\nFCP', count: 9, sum: 900 },
		{ metric: 'vital_page', key: '/products/b/reviews\nLCP', count: 50, sum: 50 },
		{ metric: 'vital_page', key: '/\nCLS', count: 5, sum: 1500 },
		{ metric: 'vital_page', key: '/about\nCLS', count: 5, sum: 50 },
		{ metric: 'page', key: '/products/a', count: 100, sum: 0 },
	];

	it('judges a page with the pages at its level', () => {
		expect(patternOf('/')).toBe('/');
		expect(patternOf('/products/blue-lamp')).toBe('/products/*');
		expect(patternOf('/about')).toBe('/*');
		expect(pageVitalsOf(rows, '/products/c')).toEqual({
			pattern: '/products/*',
			samples: 6,
			averages: { LCP: 2500, INP: 100 },
		});
		expect(pageVitalsOf(rows, '/')).toEqual({ pattern: '/', samples: 5, averages: { CLS: 300 } });
		expect(pageVitalsOf(rows, '/contact')).toEqual({ pattern: '/*', samples: 5, averages: { CLS: 10 } });
		expect(pageVitalsOf(rows, '/blog/a')).toBeNull();
		/** @param {import('../core/seo-checks.js').PageVitals} vitals */
		const vitalsOf = (vitals) =>
			pageChecks(read('/products/c', { body: html() }), { domain: DOMAIN, listed: false, vitals }).checks.find(
				(item) => item.id === 'web_vitals',
			);
		expect(vitalsOf(/** @type {any} */ (pageVitalsOf(rows, '/products/c')))).toMatchObject({
			status: 'pass',
			finding: 'ok',
			detail: { pattern: '/products/*', samples: 6, vital: 'LCP', value: '2.5 s' },
		});
		expect(vitalsOf({ pattern: '/*', samples: 9, averages: { LCP: 2000, INP: 300 } })).toMatchObject({
			status: 'warn',
			finding: 'needs_improvement',
			detail: { vital: 'INP', value: '300 ms' },
		});
		expect(vitalsOf({ pattern: '/', samples: 5, averages: { CLS: 300 } })).toMatchObject({
			status: 'fail',
			finding: 'poor',
			detail: { vital: 'CLS', value: '0.30' },
		});
		expect(byId(pageChecks(read('/a', { body: html() }), { domain: DOMAIN, listed: false }).checks).web_vitals).toBeUndefined();
	});

	it('judges the site as Google does: 75 % of visits good', () => {
		/** @param {Record<string, number>} counts `<vital>:<rating>` → visits */
		const site = (counts) =>
			siteVitalsCheck(Object.entries(counts).map(([key, count]) => ({ metric: 'vital', key, count, sum: 0 })));
		expect(site({ 'LCP:good': 4 })).toBeNull();
		expect(site({ 'LCP:good': 8, 'LCP:needs_improvement': 2, 'CLS:good': 5, 'FCP:poor': 9 })).toMatchObject({
			id: 'web_vitals_site',
			status: 'pass',
			finding: 'ok',
			detail: { samples: 10 },
		});
		expect(site({ 'LCP:good': 7, 'LCP:needs_improvement': 3, 'INP:good': 10 })).toMatchObject({
			status: 'warn',
			finding: 'needs_improvement',
			detail: { vital: 'LCP', good: 70 },
		});
		expect(site({ 'LCP:good': 9, 'LCP:poor': 1, 'CLS:good': 6, 'CLS:poor': 4 })).toMatchObject({
			status: 'fail',
			finding: 'poor',
			detail: { vital: 'CLS', good: 60, samples: 10 },
		});
	});
});

describe('robots.txt', () => {
	const ROBOTS = `# rules
Disallow: /before-any-group
User-agent: *
Disallow: /cart
Disallow: /*?sort=
Allow: /cart/share
Disallow: /*.pdf$
Disallow:

User-agent: Googlebot
User-agent: other
Disallow: /private
Allow: /private/open
Disallow: /private/open/x

user-agent: googlebot-news
Disallow: /

Sitemap: ${ORIGIN}/sitemap.xml
User-agent: Googlebot
Disallow: /drafts/ # comment
Disallow: /été`;

	it('reads groups and decides as Google does', () => {
		const groups = robotsGroupsOf(ROBOTS);
		expect(groups.map((group) => group.agents)).toEqual([['*'], ['googlebot', 'other'], ['googlebot-news'], ['googlebot']]);
		/** @param {string[]} tokens @param {string} path */
		const allows = (tokens, path) => robotsAllows(groups, tokens, path);
		// Googlebot follows its own groups (both of them), never *
		expect(allows(['googlebot'], '/cart')).toEqual({ allowed: true, rule: null });
		expect(allows(['googlebot'], '/private/a')).toEqual({ allowed: false, rule: 'Disallow: /private' });
		expect(allows(['googlebot'], '/private/open/a')).toEqual({ allowed: true, rule: 'Allow: /private/open' });
		expect(allows(['googlebot'], '/private/open/x1')).toEqual({ allowed: false, rule: 'Disallow: /private/open/x' });
		expect(allows(['googlebot'], '/drafts/a')).toMatchObject({ allowed: false });
		expect(allows(['googlebot'], `/${encodeURIComponent('été')}/a`)).toMatchObject({ allowed: false });
		// Googlebot-Image has no group: it follows Googlebot's
		expect(allows(['googlebot-image', 'googlebot'], '/private/x.jpg')).toMatchObject({ allowed: false });
		// any other crawler follows *: longest match, Allow on a tie, wildcards and the end anchor
		expect(allows(['bingbot'], '/cart/share/1')).toEqual({ allowed: true, rule: 'Allow: /cart/share' });
		expect(allows(['bingbot'], '/cart/2')).toEqual({ allowed: false, rule: 'Disallow: /cart' });
		expect(allows(['bingbot'], '/list?sort=price')).toMatchObject({ allowed: false });
		expect(allows(['bingbot'], '/files/a.pdf')).toMatchObject({ allowed: false });
		expect(allows(['bingbot'], '/files/a.pdf?x=1')).toMatchObject({ allowed: true });
		expect(allows(['bingbot'], '/before-any-group')).toMatchObject({ allowed: true });
		expect(allows(['googlebot-news'], '/robots.txt')).toEqual({ allowed: true, rule: null });
		expect(robotsAllows(robotsGroupsOf('User-agent: a\nAllow: /x\nDisallow: /x'), ['a'], '/x')).toMatchObject({
			allowed: true,
		});
		expect(robotsAllows(robotsGroupsOf('User-agent: a\nDisallow: /'), ['b'], '/x')).toEqual({ allowed: true, rule: null });
		expect(sitemapsIn(ROBOTS)).toEqual([`${ORIGIN}/sitemap.xml`]);
	});

	it('decides quickly whatever the rules, as long as the file Google reads may be', () => {
		const started = performance.now();
		const hostile = robotsGroupsOf(`User-agent: *\nDisallow: /${'*'.repeat(40)}Q\nAllow: /${'*a'.repeat(30)}$`);
		expect(robotsAllows(hostile, ['googlebot'], '/sitemap.xml')).toEqual({ allowed: true, rule: null });
		expect(robotsAllows(hostile, ['googlebot'], `/products/${'a'.repeat(2000)}`)).toMatchObject({ allowed: true });
		expect(robotsAllows(hostile, ['googlebot'], '/x/Q')).toMatchObject({ allowed: false });
		const many = robotsGroupsOf(
			`User-agent: *\n${Array.from({ length: 40_000 }, (_, i) => `Disallow: /p${i}/*/x`).join('\n')}`,
		);
		for (let i = 0; i < 30; i += 1) robotsAllows(many, ['googlebot-image', 'googlebot'], `/media/${i}.jpg`);
		// a run's addresses against the largest file Google reads: minutes with a matcher that tries every split, about
		// 0.2 s here (up to 2 s with coverage on a busy machine)
		expect(performance.now() - started).toBeLessThan(5000);
	});

	it('tells the pages the robots presets keep out on purpose (G12), as Google reads them', () => {
		const keptOut = keptOutBy([
			'Disallow: /*?q=',
			'Disallow: /*&q=',
			'Disallow: /cart$',
			'Disallow: /cart/',
			'Disallow: /cart?',
		]);
		for (const path of ['/cart', '/cart/', '/cart?step=1', '/search?q=lamp', '/x?a=1&q=2']) expect(keptOut(path)).toBe(true);
		for (const path of ['/', '/cartoons', '/search', '/x?qq=1']) expect(keptOut(path)).toBe(false);
		expect(keptOutBy([])('/cart')).toBe(false);
	});

	it('checks robots.txt: it answers, names the sitemap and lets Google in', () => {
		const ok = robotsChecks(read('/robots.txt', { body: `User-agent: *\nDisallow: /cart\nSitemap: ${ORIGIN}/sitemap.xml` }), {
			paths: [{ path: '/' }, { path: '/sitemap.xml' }, { path: '/media/a.jpg', image: true }],
		});
		expect(byId(ok)).toEqual({ robots_txt: 'pass ok', robots_sitemap: 'pass ok', robots_blocks: 'pass ok' });
		expect(ok[2]?.detail).toEqual({ count: 3 });
		const blocked = robotsChecks(read('/robots.txt', { body: 'User-agent: Googlebot-Image\nDisallow: /media/' }), {
			paths: [{ path: '/' }, { path: '/media/a.jpg', image: true }, { path: '/media/b.jpg', image: true }],
		});
		expect(byId(blocked)).toEqual({ robots_txt: 'pass ok', robots_sitemap: 'warn none', robots_blocks: 'fail blocked' });
		expect(blocked[2]?.detail).toEqual({ count: 2, path: '/media/a.jpg', rule: 'Disallow: /media/' });
		// an app that answers every address with its page: no rules at all
		expect(
			byId(
				robotsChecks(read('/robots.txt', { body: '<!DOCTYPE html><html><body>Shop</body></html>' }), {
					paths: [{ path: '/' }],
				}),
			),
		).toEqual({ robots_txt: 'warn not_text', robots_sitemap: 'warn none', robots_blocks: 'pass ok' });
		expect(byId(robotsChecks(read('/robots.txt', { status: 404 }), { paths: [] }))).toEqual({
			robots_txt: 'warn missing',
			robots_sitemap: 'warn none',
		});
		expect(
			byId(
				robotsChecks(read('/robots.txt', { status: 301, headers: { location: 'https://www.shop.example.com/robots.txt' } }), {
					paths: [],
				}),
			),
		).toMatchObject({ robots_txt: 'warn redirect' });
		expect(byId(robotsChecks(read('/robots.txt', { status: 503 }), { paths: [] }))).toMatchObject({ robots_txt: 'fail error' });
		expect(robotsChecks(read('/robots.txt', { status: null, error: 'timeout' }), { paths: [] })[0]).toMatchObject({
			finding: 'error',
			detail: { status: 0 },
		});
	});
});

describe('sitemaps', () => {
	it('reads an index and a list of addresses with their images', () => {
		expect(
			sitemapOf(
				`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${ORIGIN}/s/categories</loc></sitemap><sitemap><lastmod>2026-10-01</lastmod><loc> ${ORIGIN}/s/products-1 </loc></sitemap></sitemapindex>`,
			),
		).toEqual({ type: 'index', files: [`${ORIGIN}/s/categories`, `${ORIGIN}/s/products-1`], entries: [] });
		expect(
			sitemapOf(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
<url><loc>${ORIGIN}/a?x=1&amp;y=2</loc></url>
<url><loc><![CDATA[${ORIGIN}/b]]></loc><image:image><image:loc>${ORIGIN}/1.jpg</image:loc></image:image><image:image><image:loc>${ORIGIN}/2.jpg</image:loc></image:image></url>
<url><lastmod>2026-10-01</lastmod></url>
</urlset>`),
		).toEqual({
			type: 'urlset',
			files: [],
			entries: [
				{ loc: `${ORIGIN}/a?x=1&y=2`, images: 0 },
				{ loc: `${ORIGIN}/b`, images: 2 },
			],
		});
		expect(sitemapOf('<html><body>Not here</body></html>')).toEqual({ type: null, files: [], entries: [] });
	});

	it('reads a hostile sitemap quickly: elements left open, many times over', () => {
		const started = performance.now();
		sitemapOf(`<urlset>${'<url><loc>'.repeat(40_000)}`);
		sitemapOf(`<urlset><url>${'<loc>x'.repeat(60_000)}</url>`);
		sitemapOf(`<sitemapindex>${'<sitemap><loc>'.repeat(30_000)}`);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it('checks the sitemap and the addresses read from it', () => {
		const at = read('/sitemap.xml');
		expect(byId([sitemapCheck({ read: at, type: 'urlset', entries: 3, files: [] })])).toEqual({ sitemap: 'pass ok' });
		expect(sitemapCheck({ read: { ...at, status: 404 }, type: null, entries: 0, files: [] })).toMatchObject({
			status: 'warn',
			finding: 'missing',
			detail: { status: 404 },
		});
		expect(
			sitemapCheck({ read: { ...at, status: null, error: 'too_large' }, type: null, entries: 0, files: [] }),
		).toMatchObject({
			status: 'warn',
			finding: 'too_large',
		});
		expect(sitemapCheck({ read: { ...at, status: null, error: 'timeout' }, type: null, entries: 0, files: [] })).toMatchObject({
			finding: 'missing',
			detail: { status: 0 },
		});
		expect(sitemapCheck({ read: at, type: null, entries: 0, files: [] })).toMatchObject({ status: 'fail', finding: 'invalid' });
		expect(sitemapCheck({ read: at, type: 'urlset', entries: 0, files: [] })).toMatchObject({
			status: 'warn',
			finding: 'empty',
		});
		expect(
			sitemapCheck({ read: at, type: 'index', entries: 9, files: [read('/s/1'), read('/s/2', { status: null })] }),
		).toMatchObject({ status: 'fail', finding: 'file_missing', detail: { path: '/s/2', status: 0 } });

		expect(sitemapUrlsCheck({ reads: [], entries: [], domain: DOMAIN })).toBeNull();
		const entries = [
			{ loc: `${ORIGIN}/a` },
			{ loc: 'http://shop.example.com/b' },
			{ loc: 'https://cdn.example.net/c' },
			{ loc: 'bad' },
		];
		expect(sitemapUrlsCheck({ reads: [read('/a'), read('/b', { status: 301 })], entries, domain: DOMAIN })).toMatchObject({
			status: 'fail',
			finding: 'bad',
			page: null,
			detail: { count: 1, path: '/b', status: 301 },
		});
		expect(sitemapUrlsCheck({ reads: [read('/a', { status: null })], entries, domain: DOMAIN })).toMatchObject({
			detail: { status: 0 },
		});
		expect(sitemapUrlsCheck({ reads: [read('/a')], entries, domain: DOMAIN })).toMatchObject({
			status: 'warn',
			finding: 'other_host',
			detail: { count: 3, url: 'http://shop.example.com/b' },
		});
		expect(sitemapUrlsCheck({ reads: [read('/a')], entries: [{ loc: `${ORIGIN}/a` }], domain: DOMAIN })).toMatchObject({
			status: 'pass',
			finding: 'ok',
			detail: { count: 1 },
		});
	});

	it('picks sample addresses: one with images, one with a query, then the largest groups first', () => {
		const entries = [
			{ loc: `${ORIGIN}/`, images: 0 },
			{ loc: `${ORIGIN}/categories/lamps`, images: 0 },
			{ loc: `${ORIGIN}/categories/shades`, images: 0 },
			{ loc: `${ORIGIN}/categories/lamps?brand=acme`, images: 0 },
			{ loc: `${ORIGIN}/glossary/linen`, images: 0 },
			{ loc: `${ORIGIN}/about`, images: 0 },
			{ loc: 'not an address', images: 0 },
			{ loc: `http://${DOMAIN}/products/x`, images: 1 },
			{ loc: `https://cdn.example.net/products/y`, images: 1 },
			{ loc: `${ORIGIN}/products/blue-lamp#top`, images: 2 },
			{ loc: `${ORIGIN}/products/blue-lamp`, images: 2 },
			{ loc: `${ORIGIN}/products/red-lamp`, images: 1 },
			{ loc: `${ORIGIN}/products/green-lamp`, images: 1 },
			{ loc: `${ORIGIN}/shop`, images: 0 },
		];
		expect(candidatesOf(entries, { domain: DOMAIN, skip: [`${ORIGIN}/shop`] })).toEqual([
			`${ORIGIN}/products/blue-lamp`,
			`${ORIGIN}/categories/lamps?brand=acme`,
			`${ORIGIN}/categories/lamps`,
			`${ORIGIN}/glossary/linen`,
			`${ORIGIN}/about`,
		]);
		expect(candidatesOf(entries, { domain: DOMAIN, skip: [], limit: 2 })).toHaveLength(2);
		const many = Array.from({ length: 20 }, (_, i) => ({ loc: `${ORIGIN}/g${i}/a`, images: 0 }));
		expect(candidatesOf(many, { domain: DOMAIN, skip: [] })).toHaveLength(MAX_CANDIDATES);
	});
});

describe('checks of the whole site', () => {
	it('an address the site does not have answers 404 or 410', () => {
		const at = '/this-page-does-not-exist-1';
		expect(soft404Check(read(at, { status: 404 }))).toMatchObject({ status: 'pass', finding: 'ok' });
		expect(soft404Check(read(at, { status: 410 }))).toMatchObject({ status: 'pass', finding: 'ok' });
		expect(soft404Check(read(at))).toMatchObject({ status: 'fail', finding: 'soft' });
		expect(soft404Check(read(at, { status: 302, headers: { location: '/' } }))).toMatchObject({
			status: 'warn',
			finding: 'redirect',
			detail: { location: '/' },
		});
		expect(soft404Check(read(at, { status: 307 }))).toMatchObject({ detail: { location: '' } });
		expect(soft404Check(read(at, { status: 500 }))).toMatchObject({ status: 'fail', finding: 'error' });
		expect(soft404Check(read(at, { status: null }))).toMatchObject({ finding: 'error', detail: { status: 0 } });
		// the reason names the address tried; not read before the run's time was up: nothing to judge
		expect(soft404Check(read(at, { status: 404 }))?.detail).toEqual({ status: 404, path: at });
		expect(soft404Check(read(at, { status: null, error: 'time' }))).toBeNull();
	});

	it('a removed product answers 404 or 410, or sends visitors to another product (SEO audit §3.2 B)', () => {
		const pattern = '/products/*';
		const removed = '/products/old-lamp';
		expect(soft404Check(read(removed, { status: 410 }), pattern)).toMatchObject({
			status: 'pass',
			finding: 'ok',
			detail: { status: 410, path: removed },
		});
		// moved to its replacement: a product page, the same address level (Ecommerce's replacedBy)
		for (const location of ['/products/new-lamp', `${ORIGIN}/products/new-lamp?ref=old`])
			expect(soft404Check(read(removed, { status: 308, headers: { location } }), pattern)).toMatchObject({
				status: 'pass',
				finding: 'moved',
				detail: { status: 308, location, path: removed },
			});
		// to its category or the home page, or not permanently: Google treats it as a soft 404
		for (const [status, location] of [
			[301, '/categories/lamps'],
			[301, '/'],
			[302, '/products/new-lamp'],
			[301, 'https://other.example/products/x'],
		])
			expect(
				soft404Check(read(removed, { status: Number(status), headers: { location: String(location) } }), pattern),
			).toMatchObject({ status: 'warn', finding: 'redirect' });
		expect(soft404Check(read(removed), pattern)).toMatchObject({ status: 'fail', finding: 'soft' });
	});

	it('finds a real removed product to try: the 404 log’s most visited address at a product page’s level', () => {
		/** @param {Array<[string, number]>} rows */
		const log = (rows) => [
			{ metric: 'page', key: '/products/gone-a', count: 500 },
			...rows.map(([key, count]) => ({ metric: 'not_found', key, count })),
		];
		const pick = (/** @type {Array<[string, number]>} */ rows, more = {}) =>
			removedProductOf({
				notFound: log(rows),
				products: ['/products/blue-lamp'],
				listed: new Set([`${ORIGIN}/products/red-lamp`]),
				answered: (path) => path.startsWith('/products/ruled'),
				origin: ORIGIN,
				...more,
			});
		expect(
			pick([
				['/old-page', 90],
				['/products/blue-lamp', 80],
				['/products/red-lamp', 70],
				['/products/ruled-1', 60],
				['/products/a/b', 50],
				['/products/gone-a', 3],
				['/products/gone-b', 9],
			]),
		).toEqual({ url: `${ORIGIN}/products/gone-b`, pattern: '/products/*' });
		expect(pick([['/products/gone-a', 3]], { products: [] })).toBeNull();
		expect(pick([['/old-page', 3]])).toBeNull();
		// products at the top level of the site
		expect(pick([['/gone-c', 2]], { products: ['/blue-lamp'] })).toEqual({ url: `${ORIGIN}/gone-c`, pattern: '/*' });
		expect(pick([['/', 2]], { products: ['/blue-lamp'] })).toBeNull();
	});

	it('the redirect rules answer on the live site', () => {
		expect(redirectsLiveCheck([], ORIGIN)).toBeNull();
		const ok = redirectsLiveCheck(
			[
				{ read: read('/old', { status: 301, headers: { location: '/new' } }), code: 301, location: '/new' },
				{ read: read('/old2', { status: 308, headers: { location: `${ORIGIN}/new2` } }), code: 301, location: '/new2' },
				{ read: read('/gone', { status: 404 }), code: 410, location: null },
				{ read: read('/gone2', { status: 410 }), code: 410, location: null },
			],
			ORIGIN,
		);
		expect(ok).toMatchObject({ status: 'pass', finding: 'ok', detail: { count: 4 } });
		const wrong = redirectsLiveCheck(
			[
				{ read: read('/old', { status: 302, headers: { location: '/new' } }), code: 301, location: '/new' },
				{ read: read('/old2', { status: 301, headers: { location: '/elsewhere' } }), code: 308, location: '/new2' },
				{ read: read('/old3', { status: 301, headers: { location: 'http://[bad' } }), code: 301, location: '/new3' },
				{ read: read('/gone'), code: 410, location: null },
			],
			ORIGIN,
		);
		expect(wrong).toMatchObject({
			status: 'fail',
			finding: 'not_applied',
			detail: { count: 4, path: '/old', status: 302, expected: 301 },
		});
		// a temporary rule (G14) is applied when the site answers a temporary redirect to its address
		expect(
			redirectsLiveCheck(
				[
					{ read: read('/sale', { status: 302, headers: { location: '/summer' } }), code: 302, location: '/summer' },
					{ read: read('/form', { status: 307, headers: { location: '/new-form' } }), code: 307, location: '/new-form' },
				],
				ORIGIN,
			),
		).toMatchObject({ status: 'pass' });
		expect(
			redirectsLiveCheck(
				[{ read: read('/sale', { status: 301, headers: { location: '/summer' } }), code: 302, location: '/summer' }],
				ORIGIN,
			),
		).toMatchObject({ status: 'fail', detail: { expected: 302 } });
		expect(redirectsLiveCheck([{ read: read('/x', { status: null }), code: 301, location: '/y' }], ORIGIN)).toMatchObject({
			detail: { status: 0 },
		});
	});

	it('the 404 log and the verification tag', () => {
		expect(suggestionsCheck([])).toMatchObject({ status: 'pass', finding: 'none' });
		expect(
			suggestionsCheck([
				{ path: '/old', hits: 9 },
				{ path: '/b', hits: 2 },
			]),
		).toMatchObject({
			status: 'warn',
			finding: 'some',
			detail: { count: 2, path: '/old', hits: 9 },
		});
		const home = read('/');
		expect(verificationCheck(home, scanHtml('<meta name="msvalidate.01" content="x">'))).toMatchObject({
			status: 'pass',
			detail: { count: 1 },
		});
		expect(verificationCheck(home, scanHtml(''))).toMatchObject({ status: 'warn', finding: 'none' });
	});
});

describe('the report', () => {
	it('lists the pages, counts and links to the Rich Results Test', () => {
		expect(pagesOf(['/', '/a', '//b', 'c', '/a b', 3, '/a'], DOMAIN)).toEqual([`${ORIGIN}/`, `${ORIGIN}/a`]);
		expect(pagesOf(undefined, DOMAIN)).toEqual([`${ORIGIN}/`]);
		expect(
			pagesOf(
				Array.from({ length: 30 }, (_, i) => `/p${i}`),
				DOMAIN,
			),
		).toHaveLength(20);
		expect(summaryOf([{ status: 'pass' }, { status: 'warn' }, { status: 'fail' }, { status: 'fail' }])).toMatchObject({
			pass: 1,
			warn: 1,
			fail: 2,
		});
		expect(richResultsTestOf(`${ORIGIN}/a?b=1`)).toBe(
			'https://search.google.com/test/rich-results?url=https%3A%2F%2Fshop.example.com%2Fa%3Fb%3D1',
		);
		expect(SITE_CHECKS.every((id) => Object.hasOwn(CHECKS, id))).toBe(true);
	});
});
