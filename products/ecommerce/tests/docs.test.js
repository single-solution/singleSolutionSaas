import { KIT_GUIDE } from '@ss/app-kit';
import { createMemoryStore } from '@ss/app-kit/testing';
import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json' with { type: 'json' };
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { createProductInstance } from '../adapters/product.js';
import { escape, featuresOf, operations, renderDocs } from '../server/docs.js';
import { createRoutes } from '../server/routes.js';
import { DEFAULT_FLOW } from '../core/flow.js';
import { GROWTH_EVENTS } from '../core/growth-events.js';
import { SEARCH_INDEX_DEFINITION } from '../core/search.js';
import { SITE_ROUTES, WIDGET_ATTRIBUTES, createSnippets, proxyRoute, sitemapRoute } from '../core/snippets.js';
import { ADD_TO_CART_EVENT, WIDGET_GLOBAL } from '../core/widgets.js';

const BASE = 'https://shop-api.example.com';
/** The guide's Catalog and SEO sections, with their routes as `[route, feature]`. */
const SECTIONS =
	/** @type {Array<{ id: string, title: string, paragraphs: Array<string | { code: string }>, routes: Array<[string, string]> }>} */ (
		guide.catalogSeo.sections
	);
const permissions = manifest.permissions.map((permission) => permission.key);

describe('createSnippets', () => {
	const snippets = createSnippets({ base: BASE, widgets: manifest.widgets, permissions });

	it('places the script and every visitor widget with its data attributes', () => {
		expect(snippets.visitor).toContain(`<script src="${BASE}/widget.js" data-token="YOUR_BROWSER_TOKEN" async></script>`);
		for (const widget of manifest.widgets.filter((w) => w.kind === 'visitor'))
			expect(snippets.visitor).toContain(`data-ss-ecommerce="${widget.key}"`);
		expect(snippets.visitor).toContain(
			'<div data-ss-ecommerce="product_grid" data-category="phones" data-brand="acme" data-grade="" data-featured="" data-deal="" data-sort="newest" data-query="" data-limit="24"></div>',
		);
		expect(snippets.visitor).toContain('<div data-ss-ecommerce="product_page" data-product="blue-kettle"></div>');
		expect(snippets.visitor).toContain('<div data-ss-ecommerce="cart"></div>');
		expect(snippets.visitor).not.toContain('catalog_admin');
	});

	it('fills in a known browser token', () => {
		const filled = createSnippets({ base: BASE, widgets: manifest.widgets, permissions, browserToken: 'bt_123' });
		expect(filled.visitor).toContain('data-token="bt_123"');
	});

	it('shows the JS API and the add-to-cart event', () => {
		expect(snippets.api).toContain(`window.${WIDGET_GLOBAL}`);
		for (const call of ['identify(signIn)', 'addToCart({', 'cart.count()', 'cart.onChange('])
			expect(snippets.api).toContain(call);
		expect(snippets.addToCartEvent).toContain(`'${ADD_TO_CART_EVENT}'`);
		expect(snippets.addToCartEvent).toContain('cancelable: true');
	});

	it('places the admin widgets without a token and asks for tickets with the permissions', () => {
		expect(snippets.admin).toContain(`<script src="${BASE}/widget.js"></script>`);
		for (const key of ['catalog_admin', 'orders_admin', 'promotions_admin', 'customers_admin'])
			expect(snippets.admin).toContain(`<div data-ss-ecommerce="${key}"></div>`);
		expect(snippets.admin).toContain(`window.${WIDGET_GLOBAL}.admin({`);
		expect(snippets.ticketNode).toContain(`fetch('${BASE}/v1/tickets'`);
		expect(snippets.ticketNode).toContain(JSON.stringify(permissions));
		expect(snippets.ticketNode).toContain('process.env.SS_SERVER_TOKEN');
		expect(snippets.ticketCurl).toContain(`curl -X POST '${BASE}/v1/tickets'`);
		expect(JSON.parse(/** @type {string} */ (/-d '(.*)'$/m.exec(snippets.ticketCurl)?.[1])).permissions).toEqual(permissions);
	});

	it('proxies what the site serves with the server token', () => {
		for (const entry of SITE_ROUTES.filter((route) => route.name !== 'sitemap')) {
			const code = /** @type {string} */ (snippets.site[entry.name]);
			expect(code).toBe(proxyRoute(BASE, entry));
			expect(code).toContain(`fetch('${BASE}${entry.route}'`);
			expect(code).toContain(entry.file);
			expect(code).toContain('SS_SERVER_TOKEN');
		}
		expect(SITE_ROUTES.map((entry) => entry.name)).toEqual(['sitemap', 'feedXml', 'feedCsv', 'llms', 'llmsFull']);
		expect(snippets.site.llmsFull).toContain(`'${BASE}/v1/llms-full.txt'`);
		expect(snippets.customerOrders).toContain(`${BASE}/v1/customers/`);
	});

	it('serves the sitemap index and its files from one address (E16)', () => {
		const code = /** @type {string} */ (snippets.site.sitemap);
		expect(code).toBe(sitemapRoute(BASE));
		expect(code).toContain('app/sitemap.xml/route.js');
		expect(code).toContain("searchParams.get('file')");
		expect(code).toContain('`/v1/seo/sitemaps/${encodeURIComponent(file)}`');
		expect(code).toContain("'/v1/seo/sitemap.xml'");
		expect(code).toContain(`fetch(\`${BASE}\${path}\``);
		expect(code).toContain('SS_SERVER_TOKEN');
	});

	it('gives a product page that answers moved with a 308 (E13)', () => {
		expect(snippets.productMeta).toContain(`${BASE}/v1/seo/products/`);
		expect(snippets.productMeta).toContain('application/ld+json');
		expect(snippets.productMeta).toContain("import { notFound, permanentRedirect } from 'next/navigation';");
		expect(snippets.productMeta).toContain('if (seo.moved) permanentRedirect(seo.moved.url);');
		expect(snippets.productMeta).toContain('robots: seo.robots');
		expect(snippets.productMeta).toContain('SS_SERVER_TOKEN');
	});

	it('gives a listing page with its head from /v1/seo/listing (E15)', () => {
		expect(snippets.listingPage).toContain(`${BASE}/v1/seo/listing?`);
		expect(snippets.listingPage).toContain('robots: head.robots');
		expect(snippets.listingPage).toContain('if (head.moved) permanentRedirect(head.moved.url);');
		expect(snippets.listingPage).toContain('data-ss-ecommerce="product_grid" data-category={slug}');
		expect(snippets.listingPage).toContain('head.faqs.map(');
		expect(snippets.listingPage).toContain('SS_SERVER_TOKEN');
	});

	it('gives policy pages in text or cleaned HTML (E3)', () => {
		expect(snippets.policies).toContain(`'${BASE}/v1/policies'`);
		expect(snippets.policies).toContain("found.format === 'html'");
		expect(snippets.policies).toContain('warranty');
	});

	it('gives the courier connection and the CORS rule as JSON', () => {
		expect(Object.keys(JSON.parse(snippets.courier))).toEqual([
			'bookUrl',
			'trackUrl',
			'apiKey',
			'headers',
			'bodyTemplate',
			'trackingPath',
			'statusPath',
		]);
		const [rule] = JSON.parse(snippets.cors);
		expect(rule.AllowedMethods).toContain('PUT');
		expect(rule.AllowedOrigins).toHaveLength(2);
	});

	it('works without widgets', () => {
		const bare = createSnippets({ base: BASE, widgets: [], permissions: [] });
		expect(bare.visitor).not.toContain('data-ss-ecommerce');
		expect(bare.admin).toContain('getTicket');
		expect(Object.keys(WIDGET_ATTRIBUTES)).toEqual(['product_grid', 'product_page']);
	});
});

describe('renderDocs', () => {
	const html = renderDocs({ base: BASE });
	const snippets = createSnippets({ base: BASE, widgets: manifest.widgets, permissions });

	it('is a whole page with the guide and the snippets pointing at the base', () => {
		expect(html.startsWith('<!doctype html>')).toBe(true);
		expect(html).toContain(`<title>${guide.title}</title>`);
		expect(html).toContain(escape(`<script src="${BASE}/widget.js" data-token="YOUR_BROWSER_TOKEN" async></script>`));
		expect(html).toContain(escape(`'${BASE}/v1/tickets'`));
		expect(html).toContain('SS_SERVER_TOKEN');
		expect(html).toContain(escape(guide.localhost));
		expect(html).toContain(escape(guide.growthEvents));
		for (const name of Object.values(GROWTH_EVENTS)) expect(html).toContain(name);
		expect(html).toContain('<h2 id="business">business.json</h2>');
	});

	it('names every feature, widget, permission, template and status role', () => {
		for (const feature of manifest.features) {
			expect(html).toContain(`id="feature-${feature.key}"`);
			expect(html).toContain(escape(feature.name));
		}
		for (const widget of manifest.widgets) expect(html).toContain(escape(`data-ss-ecommerce="${widget.key}"`));
		for (const key of permissions) expect(html).toContain(`<code>${key}</code>`);
		for (const key of Object.keys(guide.templates)) expect(html).toContain(`<code>${key}</code>`);
		for (const status of DEFAULT_FLOW.statuses) expect(html).toContain(`<code>${status.key}</code>`);
		expect(html).toContain('<code>data-product</code>');
		expect(html).toContain('<code>data-limit</code>');
		expect(html).toContain('/v1/chat/me/orders');
		expect(html).toContain('/v1/customers/');
		for (const entry of SITE_ROUTES) expect(html).toContain(`GET ${entry.route}`);
		expect(html).toContain('Needs: Catalog.');
	});

	it('shows the site snippets: sitemap files, product and listing pages, llms-full.txt', () => {
		expect(html).toContain(escape(sitemapRoute(BASE)));
		expect(html).toContain(escape(snippets.productMeta));
		expect(html).toContain('<h3><code>GET /v1/seo/listing</code></h3>');
		expect(html).toContain(escape(guide.listing));
		expect(html).toContain(escape(snippets.listingPage));
		expect(html).toContain(escape(/** @type {string} */ (snippets.site.llmsFull)));
		expect(html).toContain(escape(guide.siteRoutes.llmsFull));
	});

	it('documents every catalog and SEO addition (E1–E17) with its routes and their features', () => {
		expect(html).toContain('<h2 id="catalog-seo">Catalog and SEO</h2>');
		expect(html).toContain(escape(guide.catalogSeo.intro));
		const names = new Map(manifest.features.map((feature) => [feature.key, feature.name]));
		for (const section of SECTIONS) {
			const body = /** @type {string} */ (new RegExp(`<section id="${section.id}">.*?</section>`, 's').exec(html)?.[0]);
			expect(body, section.id).toContain(`<h3>${escape(section.title)}</h3>`);
			for (const part of section.paragraphs) if (typeof part === 'string') expect(body).toContain(escape(part));
			for (const [route, feature] of section.routes) {
				expect(names.has(feature), `${route}: ${feature}`).toBe(true);
				expect(body).toContain(
					`<code>${escape(route)}</code> (${escape(names.get(feature) ?? '')}, <code>${feature}</code>)`,
				);
			}
		}
		expect(SECTIONS).toHaveLength(17);
	});

	it('gives the exact Atlas Search index and where to create it (E14)', () => {
		const atlas = /** @type {string} */ (/<section id="atlas-search">.*?<\/section>/s.exec(html)?.[0]);
		expect(atlas).toContain(`<pre><code>${escape(JSON.stringify(SEARCH_INDEX_DEFINITION, null, 2))}</code></pre>`);
		expect(atlas).toContain('ss_ecommerce_products');
		expect(atlas).toContain('searchIndex');
		expect(atlas).toContain('Search index missing');
	});

	it('names only routes that exist, each with a feature it runs under', () => {
		const product = createProductInstance({
			config: {
				mongodbUri: '',
				connectSecret: 'connect-secret-0123456789-abcdefghij',
				encryptionKey: 'encryption-key-0123456789-abcdefghij',
			},
			store: createMemoryStore({ now: Date.now }),
			nodeEnv: 'test',
		});
		const defined = createRoutes(product).map((route) => ({
			method: route.method,
			path: route.path,
			features: [route.feature ?? []].flat(),
		}));
		// kit routes (the list settings) are only in openapi.json
		const kit = operations(openapi.paths).map(([method, path]) => ({
			method,
			path: path.replace(/\{(\w+)\}/g, ':$1'),
			features: /** @type {string[] | null} */ (null),
		}));
		/** @param {string} pattern @param {string} path */
		const matches = (pattern, path) => {
			const want = pattern.split('/');
			const got = path.split('/');
			return want.length === got.length && want.every((part, at) => part.startsWith(':') || part === got[at]);
		};
		for (const section of SECTIONS)
			for (const [route, feature] of section.routes) {
				const [method, target] = route.split(' ');
				const path = String(target).split('?')[0] ?? '';
				const own = defined.filter((entry) => entry.method === method && entry.path === path);
				if (own.length > 0)
					expect(
						own.some((entry) => entry.features.includes(feature)),
						route,
					).toBe(true);
				else
					expect(
						kit.some((entry) => entry.method === method && matches(entry.path, path)),
						route,
					).toBe(true);
			}
	});

	it('explains the kit routes for the merchant’s server: settings and lists, acting user, visitor calls, counts, activity, Format', () => {
		for (const section of KIT_GUIDE) {
			expect(html).toContain(`<h2 id="${section.id}">${escape(section.title)}</h2>`);
			for (const paragraph of section.paragraphs) expect(html).toContain(escape(paragraph));
		}
		expect(html).toContain(escape(guide.kit));
		for (const route of [
			'/v1/lists/{list}',
			'/v1/orders/counts',
			'/v1/admin/products/count',
			'/v1/customers/counts',
			'/v1/activity',
		])
			expect(html).toContain(route);
	});

	it('lists the API reference from openapi.json, with one feature or a list', () => {
		const paths = {
			'/v1/shop/products': { get: { 'x-ss-auth': 'browser', 'x-ss-feature': 'catalog', summary: 'List <products>' } },
			'/v1/admin/customers': {
				get: { 'x-ss-auth': 'ticket', 'x-ss-feature': ['checkout', 'reviews'], 'x-ss-permission': 'customers.manage' },
			},
			'/v1/tickets': { post: { 'x-ss-auth': 'server' } },
			'/v1/odd': { get: {} },
		};
		const page = renderDocs({ base: BASE, paths });
		expect(page).toContain('<code>GET /v1/shop/products</code> List &#60;products&#62;');
		expect(page).toContain('ticket (customers.manage)');
		expect(page).toContain('checkout or reviews');
		expect(page).toContain('<td>always</td>');
		const catalog = /** @type {string} */ (/<section id="feature-catalog">.*?<\/section>/s.exec(page)?.[0]);
		expect(catalog).toContain('/v1/shop/products');
		expect(catalog).not.toContain('/v1/tickets');
		const reviews = /** @type {string} */ (/<section id="feature-reviews">.*?<\/section>/s.exec(page)?.[0]);
		expect(reviews).toContain('/v1/admin/customers');
	});

	it('escapes every value', () => {
		const page = renderDocs({ base: 'https://x.example/"><script>alert(1)</script>' });
		expect(page).not.toContain('<script>alert(1)</script>');
		expect(page).toContain('&#34;&#62;&#60;script&#62;alert(1)&#60;/script&#62;');
		expect(escape(`<a href="x">'&'</a>`)).toBe('&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;');
	});

	it('reads operations and their features', () => {
		expect(operations(undefined)).toEqual([]);
		expect(operations({ '/a': { post: { summary: 's' } } })).toEqual([['POST', '/a', { summary: 's' }]]);
		expect(featuresOf({})).toEqual([]);
		expect(featuresOf({ 'x-ss-feature': 'seo' })).toEqual(['seo']);
		expect(featuresOf({ 'x-ss-feature': ['seo', 'feeds'] })).toEqual(['seo', 'feeds']);
	});
});
