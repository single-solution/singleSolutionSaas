import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json' with { type: 'json' };
import guide from '../docs/guide.json' with { type: 'json' };
import { escape, featuresOf, operations, renderDocs } from '../server/docs.js';
import { DEFAULT_FLOW } from '../core/flow.js';
import { GROWTH_EVENTS } from '../core/growth-events.js';
import { SITE_ROUTES, WIDGET_ATTRIBUTES, createSnippets, proxyRoute } from '../core/snippets.js';
import { ADD_TO_CART_EVENT, WIDGET_GLOBAL } from '../core/widgets.js';

const BASE = 'https://shop-api.example.com';
const permissions = manifest.permissions.map((permission) => permission.key);

describe('createSnippets', () => {
	const snippets = createSnippets({ base: BASE, widgets: manifest.widgets, permissions });

	it('places the script and every visitor widget with its data attributes', () => {
		expect(snippets.visitor).toContain(`<script src="${BASE}/widget.js" data-token="YOUR_BROWSER_TOKEN" async></script>`);
		for (const widget of manifest.widgets.filter((w) => w.kind === 'visitor'))
			expect(snippets.visitor).toContain(`data-ss-ecommerce="${widget.key}"`);
		expect(snippets.visitor).toContain(
			'<div data-ss-ecommerce="product_grid" data-category="phones" data-brand="acme" data-query="" data-limit="24"></div>',
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
		for (const entry of SITE_ROUTES) {
			const code = /** @type {string} */ (snippets.site[entry.name]);
			expect(code).toBe(proxyRoute(BASE, entry));
			expect(code).toContain(`fetch(\`${BASE}${entry.route}\${search}\``);
			expect(code).toContain(entry.file);
			expect(code).toContain('SS_SERVER_TOKEN');
		}
		expect(snippets.productMeta).toContain(`${BASE}/v1/seo/products/`);
		expect(snippets.productMeta).toContain('application/ld+json');
		expect(snippets.policies).toContain(`'${BASE}/v1/policies'`);
		expect(snippets.customerOrders).toContain(`${BASE}/v1/customers/`);
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
