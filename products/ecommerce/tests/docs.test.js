import { readFile } from 'node:fs/promises';
import { KIT_GUIDE, apiAnchor } from '@ss/app-kit';
import { createMemoryStore } from '@ss/app-kit/testing';
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import manifest from '../manifest.json' with { type: 'json' };
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { createProductInstance } from '../adapters/product.js';
import staffAlertSettings from '../schemas/staff_alerts.settings.json' with { type: 'json' };
import { escape, featuresOf, operationOf, operations, renderDocs } from '../server/docs.js';
import { ORDER_MESSAGE_VALUES, ORDER_TEMPLATES } from '../server/order-messages.js';
import { createRoutes } from '../server/routes.js';
import { BUSINESS_VALUE } from '../server/service.js';
import { STAFF_ALERT_EVENTS, STAFF_ALERT_LINK, STAFF_ALERT_PHONE, STAFF_ALERT_VALUES } from '../server/staff-alerts.js';
import { DEFAULT_FLOW } from '../core/flow.js';
import { GROWTH_EVENTS } from '../core/growth-events.js';
import { SEARCH_INDEX_DEFINITION } from '../core/search.js';
import { SITE_ROUTES, WIDGET_ATTRIBUTES, createSnippets, mediaRoute, proxyRoute, sitemapRoute } from '../core/snippets.js';
import { ADD_TO_CART_EVENT, WIDGET_GLOBAL } from '../core/widgets.js';
import { stockEventOf } from '../core/catalog-query.js';
import { EVENT_TYPES } from '../core/events.js';
import { STATUS_ROLES } from '../core/model.js';
import { ALL, ORIGIN, readyShop } from './helpers.js';

const BASE = 'https://shop-api.example.com';
/** @typedef {Array<{ id: string, title: string, paragraphs: Array<string | { code: string }>, routes: Array<[string, string]> }>} Sections */
/** The guide's Catalog and SEO sections, with their routes as `[route, feature]`. */
const SECTIONS = /** @type {Sections} */ (guide.catalogSeo.sections);
/** Every guide group's sections: Catalog and SEO; Checkout, orders and promotions; Import. */
const ALL_SECTIONS = /** @type {Sections} */ ([...guide.catalogSeo.sections, ...guide.orders.sections, ...guide.import.sections]);
/** The documented operations, as the API reference lists them. */
const KNOWN = operations(openapi.paths);
const permissions = manifest.permissions.map((permission) => permission.key);

describe('createSnippets', () => {
	const snippets = createSnippets({ base: BASE, widgets: manifest.widgets, permissions });

	it('places the script and every visitor widget with its data attributes', () => {
		expect(snippets.visitor).toContain(`<script src="${BASE}/widget.js" data-token="YOUR_BROWSER_TOKEN" async></script>`);
		for (const widget of manifest.widgets.filter((w) => w.kind === 'visitor'))
			expect(snippets.visitor).toContain(`data-ss-ecommerce="${widget.key}"`);
		expect(snippets.visitor).toContain(
			'<div data-ss-ecommerce="product_grid" data-category="accessories" data-brand="acme" data-grade="" data-featured="" data-deal="" data-sort="newest" data-query="" data-limit="24"></div>',
		);
		expect(snippets.visitor).toContain(
			'<div data-ss-ecommerce="product_page" data-product="blue-kettle" data-heading="h1"></div>',
		);
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
		for (const entry of SITE_ROUTES.filter((route) => route.name !== 'sitemap' && route.name !== 'media')) {
			const code = /** @type {string} */ (snippets.site[entry.name]);
			expect(code).toBe(proxyRoute(BASE, entry));
			expect(code).toContain(`fetch('${BASE}${entry.route}'`);
			expect(code).toContain(entry.file);
			expect(code).toContain('SS_SERVER_TOKEN');
		}
		expect(SITE_ROUTES.map((entry) => entry.name)).toEqual(['sitemap', 'media', 'feedXml', 'feedCsv', 'llms', 'llmsFull']);
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

	it('serves images at addresses that never change through the media route (G1)', () => {
		const code = /** @type {string} */ (snippets.site.media);
		expect(code).toBe(mediaRoute(BASE));
		expect(code).toContain('app/media/[...key]/route.js');
		expect(code).toContain(`fetch(\`${BASE}/v1/media?\${query}\``);
		expect(code).toContain('SS_SERVER_TOKEN');
		expect(code).toContain("'cache-control': 'public, max-age=31536000, immutable'");
	});

	it('gives a product page that answers moved with a 308 (E13)', () => {
		expect(snippets.productMeta).toContain(`${BASE}/v1/seo/products/`);
		expect(snippets.productMeta).toContain('application/ld+json');
		expect(snippets.productMeta).toContain("import { notFound, permanentRedirect } from 'next/navigation';");
		expect(snippets.productMeta).toContain('if (seo.moved) permanentRedirect(seo.moved.url);');
		// one address per product: another path that finds it is sent to its own (G9)
		expect(snippets.productMeta).toContain(
			'if (new URL(seo.url).pathname !== `/products/${encodeURIComponent(slug)}`) permanentRedirect(seo.url);',
		);
		expect(snippets.productMeta).toContain('robots: seo.robots');
		expect(snippets.productMeta).toContain('SS_SERVER_TOKEN');
	});

	it('gives a listing page with its head from /v1/seo/listing (E15)', () => {
		expect(snippets.listingPage).toContain(`${BASE}/v1/seo/listing?`);
		expect(snippets.listingPage).toContain('robots: head.robots');
		expect(snippets.listingPage).toContain('if (head.moved) permanentRedirect(head.moved.url);');
		expect(snippets.listingPage).toContain('if (head.status === 404) notFound();');
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
		for (const key of Object.values(ORDER_TEMPLATES)) expect(html).toContain(`<code>${key}</code>`);
		expect(html).toContain(`<code>${ORDER_TEMPLATES.status}.&#60;status key&#62;</code>`);
		for (const event of Object.keys(STAFF_ALERT_EVENTS)) expect(html).toContain(`<code>ecommerce.staff_${event}</code>`);
		for (const status of DEFAULT_FLOW.statuses) expect(html).toContain(`<code>${status.key}</code>`);
		for (const role of STATUS_ROLES) expect(html).toContain(`<code>${role}</code>: `);
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

	it('documents every addition (catalog and SEO, checkout, orders and promotions, import) with its routes and their features', () => {
		expect(html).toContain('<h2 id="catalog-seo">Catalog and SEO</h2>');
		expect(html).toContain('<h2 id="orders-guide">Checkout, orders and promotions</h2>');
		expect(html).toContain('<h2 id="import">Import</h2>');
		for (const intro of [guide.catalogSeo.intro, guide.orders.intro, guide.import.intro]) expect(html).toContain(escape(intro));
		const names = new Map(manifest.features.map((feature) => [feature.key, feature.name]));
		const ids = ALL_SECTIONS.map((section) => section.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const section of ALL_SECTIONS) {
			const body = /** @type {string} */ (new RegExp(`<section id="${section.id}">.*?</section>`, 's').exec(html)?.[0]);
			expect(body, section.id).toContain(`<h3>${escape(section.title)}</h3>`);
			for (const part of section.paragraphs) if (typeof part === 'string') expect(body).toContain(escape(part));
			for (const [route, feature] of section.routes) {
				expect(names.has(feature), `${route}: ${feature}`).toBe(true);
				const found = /** @type {readonly [string, string]} */ (operationOf(route, KNOWN));
				expect(found, route).not.toBeNull();
				expect(body).toContain(
					`<a href="#${apiAnchor(...found)}"><code>${escape(route)}</code></a> (${escape(names.get(feature) ?? '')}, <code>${feature}</code>)`,
				);
			}
		}
		expect(SECTIONS).toHaveLength(18);
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
		for (const section of ALL_SECTIONS)
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
		expect(page).toContain('<a href="#op-get-v1-shop-products"><code>GET /v1/shop/products</code></a> List &#60;products&#62;');
		expect(page).toContain('ticket (customers.manage)');
		expect(page).toContain('checkout or reviews');
		expect(page).toContain('<td>always</td>');
		const catalog = /** @type {string} */ (/<section id="feature-catalog">.*?<\/section>/s.exec(page)?.[0]);
		expect(catalog).toContain('/v1/shop/products');
		expect(catalog).not.toContain('/v1/tickets');
		const reviews = /** @type {string} */ (/<section id="feature-reviews">.*?<\/section>/s.exec(page)?.[0]);
		expect(reviews).toContain('/v1/admin/customers');
	});

	it('renders the API reference, and every route the page links to is in it', () => {
		const at = html.indexOf('<h2 id="api">API reference</h2>');
		expect(at).toBeGreaterThan(0);
		const apiPart = html.slice(at);
		for (const [method, path] of KNOWN)
			expect(apiPart, `${method} ${path}`).toContain(`<section class="ss-api-op" id="${apiAnchor(method, path)}">`);
		expect(apiPart).toContain(
			'<section class="ss-api-op" id="op-post-v1-orders-id-move"><h3><code>POST /v1/orders/{id}/move</code>',
		);
		expect(apiPart).toContain('<a href="#op-post-v1-shop-orders"><code>POST /v1/shop/orders</code></a>');
		const targets = new Set([...html.matchAll(/ id="(op-[^"]+)"/g)].map((match) => match[1]));
		const links = [...html.matchAll(/ href="#(op-[^"]+)"/g)].map((match) => /** @type {string} */ (match[1]));
		expect(links.length).toBeGreaterThan(KNOWN.length);
		for (const link of links) expect(targets.has(link), link).toBe(true);
		expect(renderDocs({ base: BASE })).toBe(html);
	});

	it('finds the operation a guide route names, the one with the most fixed parts first', () => {
		expect(operationOf('GET /v1/orders/packing-slips?ids=a,b', KNOWN)).toEqual(['GET', '/v1/orders/packing-slips']);
		expect(operationOf('GET /v1/orders/:id', KNOWN)).toEqual(['GET', '/v1/orders/{id}']);
		expect(operationOf('POST /v1/orders/counter', KNOWN)).toEqual(['POST', '/v1/orders/counter']);
		expect(operationOf('GET /v1/reports/sales?by=grade&format=csv', KNOWN)).toEqual(['GET', '/v1/reports/sales']);
		expect(operationOf('PATCH /v1/nothing/:id', KNOWN)).toBeNull();
		expect(operationOf('GET', KNOWN)).toBeNull();
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

describe('the messages, staff alerts and events the code sends', () => {
	const html = renderDocs({ base: BASE });
	/** The part of the page from one heading to the next. @param {string} from @param {string} to */
	const part = (from, to) => html.slice(html.indexOf(from), html.indexOf(to));
	const messagesPart = part('<h2 id="messages">', '<h2 id="staff-alerts">');
	const staffPart = part('<h2 id="staff-alerts">', '<h2 id="events">');
	const eventsPart = part('<h2 id="events">', '<h2 id="couriers">');
	/** The list item that documents a key. @param {string} section @param {string} key */
	const itemOf = (section, key) => {
		const at = section.indexOf(`<li><code>${escape(key)}</code>`);
		return at < 0 ? '' : section.slice(at, section.indexOf('</li>', at));
	};
	/** Whether a section lists a value with its help. @param {string} section @param {string} key */
	const listed = (section, key) => section.includes(`<li><code>{${escape(key)}}</code>: `);

	it('lists every value of the code’s constants, with what it holds, and the staff events of the setting', () => {
		const messageHelp = /** @type {Record<string, string>} */ (guide.messageValues);
		const staffHelp = /** @type {Record<string, string>} */ (guide.staffValues);
		for (const key of [...ORDER_MESSAGE_VALUES, BUSINESS_VALUE]) {
			expect(messageHelp[key], key).toBeTruthy();
			expect(listed(messagesPart, key), key).toBe(true);
		}
		expect(Object.keys(messageHelp).sort()).toEqual([...ORDER_MESSAGE_VALUES, BUSINESS_VALUE].sort());
		const staffKeys = [...STAFF_ALERT_VALUES, ...Object.values(STAFF_ALERT_EVENTS).flat(), STAFF_ALERT_LINK, STAFF_ALERT_PHONE];
		for (const key of staffKeys) {
			expect(staffHelp[key], key).toBeTruthy();
			expect(listed(staffPart, key), key).toBe(true);
		}
		expect(Object.keys(staffHelp).sort()).toEqual([...new Set(staffKeys)].sort());
		expect(Object.keys(STAFF_ALERT_EVENTS)).toEqual(staffAlertSettings.properties.events.items.enum);
		expect(Object.keys(guide.staffEvents)).toEqual(Object.keys(STAFF_ALERT_EVENTS));
		for (const [event, extra] of Object.entries(STAFF_ALERT_EVENTS))
			for (const key of extra) expect(itemOf(staffPart, `ecommerce.staff_${event}`)).toContain(`<code>{${key}}</code>`);
		for (const [template, values] of Object.entries(guide.templates))
			for (const key of [...values, BUSINESS_VALUE]) expect(itemOf(messagesPart, template)).toContain(`<code>{${key}}</code>`);
		for (const role of STATUS_ROLES) expect(Object.keys(guide.roles)).toContain(role);
	});

	it('lists the event types the code publishes, and the kit’s settings change', async () => {
		const source = await readFile(new URL('../server/order-events.js', import.meta.url), 'utf8');
		const published = [...source.matchAll(/publish\(s, '([a-z_.]+)'/g)].map((match) => match[1]);
		// the stock events are the ones stockEventOf names
		const stock = [stockEventOf(5, 0, 3), stockEventOf(5, 2, 3)];
		expect([...new Set([...published, ...stock])].sort()).toEqual([...EVENT_TYPES].sort());
		expect(Object.keys(guide.eventTypes)).toEqual([...EVENT_TYPES, 'settings.changed']);
		for (const type of Object.keys(guide.eventTypes)) expect(eventsPart).toContain(`<li><code>ecommerce.${type}</code>: `);
	});

	describe('through the API', () => {
		/** @type {Awaited<ReturnType<typeof readyShop>>} */
		let shop;
		let visits = 0;
		const ADDRESS = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' };

		/**
		 * A visitor call from its own address (the visitor rate limits stay out of the way).
		 * @param {string} method @param {string} path @param {{ body?: unknown, signIn?: string }} [init]
		 */
		const visit = (method, path, { body, signIn } = {}) => {
			visits += 1;
			return shop.call(method, path, {
				token: shop.browser,
				origin: ORIGIN,
				...(body === undefined ? {} : { body }),
				headers: {
					'x-forwarded-for': `10.77.${Math.floor(visits / 250)}.${visits % 250}`,
					'idempotency-key': createId('key'),
					...(signIn ? { 'ss-sign-in': signIn } : {}),
				},
			});
		};

		beforeAll(async () => {
			// stock without locations, so a restock is one number
			shop = await readyShop({ features: ALL.filter((key) => key !== 'multi_location') });
			await shop.setting('staff_alerts', 'recipients', ['team@shop.example.com']);
			await shop.setting('staff_alerts', 'events', Object.keys(STAFF_ALERT_EVENTS));
			await shop.setting('staff_alerts', 'adminUrl', 'https://admin.shop.example.com/orders/{id}');
			await shop.setting('checkout', 'orderUrl', `${ORIGIN}/orders/{number}`);
		});
		afterAll(async () => shop.product.close());

		it('sends only values the docs list, for every template it sends', async () => {
			const sara = await shop.signIn();
			const item = await shop.seedProduct({ price: 1000, stock: 50 });
			/** @param {string} payment */
			const place = async (payment) => {
				const placed = await visit('POST', '/v1/shop/orders', {
					signIn: sara,
					body: { lines: [{ productId: item.id }], payment, address: ADDRESS },
				});
				expect(placed.status, JSON.stringify(placed.json)).toBe(201);
				return placed.json.order;
			};
			/** @param {string} id @param {Record<string, unknown>} body */
			const move = async (id, body) => expect((await shop.api('POST', `/v1/orders/${id}/move`, body)).status).toBe(200);

			// placed, status, one template per status, paid on delivery, a claim
			const cod = await place('cod');
			await move(cod.id, { to: 'confirmed' });
			await shop.setting('checkout', 'statusTemplates', 'per_status');
			await move(cod.id, { to: 'delivered' });
			await shop.setting('checkout', 'statusTemplates', 'one');
			const claim = await visit('POST', '/v1/shop/returns', {
				signIn: sara,
				body: { orderId: cod.id, kind: 'return', lines: [{ lineId: cod.lines[0].id, quantity: 1 }], reason: 'Too small' },
			});
			expect(claim.status).toBe(201);
			// a payment staff record, which confirms the order
			const recorded = await place('cod');
			const paid = await shop.api('POST', `/v1/orders/${recorded.id}/payments`, {
				method: 'cash',
				amount: recorded.totals.total,
				confirm: true,
			});
			expect(paid.status).toBe(201);
			// a cancel with the staff's note
			await move((await place('cod')).id, { to: 'cancelled', note: 'Out of stock' });
			// a transfer proof
			await shop.setting('checkout', 'bankTransferVia', 'manual');
			const transfer = await place('bank_transfer');
			const upload = await visit('POST', `/v1/shop/orders/${transfer.id}/proof/upload`, {
				signIn: sara,
				body: { type: 'image/png', size: 1000 },
			});
			expect(upload.status).toBe(201);
			const proof = await visit('POST', `/v1/shop/orders/${transfer.id}/proof`, {
				signIn: sara,
				body: { key: upload.json.key, reference: 'TRX-1' },
			});
			expect(proof.status).toBe(200);
			await shop.setting('checkout', 'bankTransferVia', 'payments');
			// a back-in-stock alert
			const out = await shop.seedProduct({ price: 2000, stock: 0 });
			expect(
				(await visit('POST', '/v1/shop/alerts', { signIn: sara, body: { kind: 'back_in_stock', productId: out.id } })).status,
			).toBe(201);
			const restock = await shop.api('POST', `/v1/products/${out.id}/stock`, {
				changes: [{ variantId: /** @type {any} */ (out.variants[0]).id, set: 3 }],
			});
			expect(restock.status, JSON.stringify(restock.json)).toBe(200);
			// money that arrives at Payments after the shopper canceled: a refund due
			const late = await place('online');
			const paymentId = String((await shop.api('GET', `/v1/orders/${late.id}`)).json.payment.paymentId);
			expect((await visit('POST', `/v1/shop/orders/${late.id}/cancel`, { signIn: sara })).status).toBe(200);
			shop.payPayment(paymentId);
			shop.advance(31_000);
			expect((await shop.api('GET', `/v1/orders/${late.id}`)).json.payment.refundDue).toBeGreaterThan(0);
			// an order its time to confirm cancels
			await place('cod');
			shop.advance(25 * 3_600_000);
			await visit('POST', '/v1/shop/cart/quote', { body: { lines: [{ productId: item.id }] } });

			const sent = shop.messages();
			const templates = new Set(sent.map((message) => message.template));
			for (const template of [
				ORDER_TEMPLATES.placed,
				ORDER_TEMPLATES.status,
				`${ORDER_TEMPLATES.status}.delivered`,
				'ecommerce.return_status',
				'ecommerce.back_in_stock',
				...Object.keys(STAFF_ALERT_EVENTS).map((event) => `ecommerce.staff_${event}`),
			])
				expect(templates, template).toContain(template);

			for (const message of sent) {
				const keys = Object.keys(message.values);
				if (message.template.startsWith('ecommerce.order_')) {
					expect(keys.sort(), message.template).toEqual([...ORDER_MESSAGE_VALUES, BUSINESS_VALUE].sort());
					for (const key of keys) expect(listed(messagesPart, key), `${message.template} {${key}}`).toBe(true);
				} else if (message.template.startsWith('ecommerce.staff_')) {
					const event = /** @type {keyof typeof STAFF_ALERT_EVENTS} */ (message.template.slice('ecommerce.staff_'.length));
					const own = /** @type {ReadonlyArray<string>} */ (STAFF_ALERT_EVENTS[event]);
					expect(keys.sort(), message.template).toEqual([...STAFF_ALERT_VALUES, ...own, STAFF_ALERT_LINK].sort());
					for (const key of keys) {
						expect(listed(staffPart, key), `${message.template} {${key}}`).toBe(true);
						if (own.includes(key))
							expect(itemOf(staffPart, message.template), `${message.template} {${key}}`).toContain(
								`<code>{${key}}</code>`,
							);
					}
				} else
					for (const key of keys)
						expect(itemOf(messagesPart, message.template), `${message.template} {${key}}`).toContain(
							`<code>{${key}}</code>`,
						);
			}

			// the events: each type and data field is in the docs
			const events = await shop.api('GET', '/v1/events?limit=100');
			expect(events.status).toBe(200);
			const types = /** @type {Record<string, string>} */ (guide.eventTypes);
			for (const event of events.json.items) {
				const type = String(event.type).slice('ecommerce.'.length);
				expect(types[type], type).toBeTruthy();
				for (const key of Object.keys(event.data))
					expect(`${guide.events} ${types[type]}`, `${type} ${key}`).toMatch(new RegExp(`\\b${key}\\b`));
			}
		});
	});
});
