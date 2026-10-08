/**
 * The code snippets the public docs and the dashboard's Developers tab show (PLAN 0.4.10): the widget script with the
 * visitor widgets and their data attributes, the JS API (`identify`, `addToCart`, `cart.count`, `cart.onChange`) and
 * the add-to-cart event, the admin widgets with their ticket function, the ticket request (Node.js and cURL), what the
 * merchant's site serves from the API (sitemap, product meta and structured data, feeds, llms.txt, policies) as Next.js
 * route handlers proxying with the server token, the Accounts Orders lookup, the courier connection and the storage
 * CORS rule. Plain text; no I/O.
 * @module
 */
import { ADD_TO_CART_EVENT, WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from './widgets.js';

/**
 * The data attributes each visitor widget reads (all optional except `data-product`).
 * @type {Readonly<Record<string, ReadonlyArray<{ name: string, example: string, help: string }>>>}
 */
export const WIDGET_ATTRIBUTES = Object.freeze({
	product_grid: Object.freeze([
		{ name: 'data-category', example: 'phones', help: 'only this category (its id or slug) and its subcategories' },
		{ name: 'data-brand', example: 'acme', help: 'only this brand (its id or slug)' },
		{ name: 'data-query', example: '', help: 'start with this search text' },
		{ name: 'data-limit', example: '24', help: 'products per page' },
	]),
	product_page: Object.freeze([{ name: 'data-product', example: 'blue-kettle', help: "the product's id or slug (required)" }]),
});

/**
 * What the merchant's own site serves from the API: the path on the merchant's site, the Ecommerce route, the feature
 * and the content type of the answer.
 */
export const SITE_ROUTES = Object.freeze([
	{ name: 'sitemap', file: 'app/sitemap.xml/route.js', route: '/v1/seo/sitemap.xml', feature: 'seo', type: 'application/xml' },
	{
		name: 'feedXml',
		file: 'app/feeds/products.xml/route.js',
		route: '/v1/feeds/products.xml',
		feature: 'feeds',
		type: 'application/xml',
	},
	{
		name: 'feedCsv',
		file: 'app/feeds/products.csv/route.js',
		route: '/v1/feeds/products.csv',
		feature: 'feeds',
		type: 'text/csv',
	},
	{ name: 'llms', file: 'app/llms.txt/route.js', route: '/v1/llms.txt', feature: 'llms_txt', type: 'text/plain' },
]);

/**
 * A Next.js route handler on the merchant's site that serves one Ecommerce answer from the merchant's own domain.
 * @param {string} base Ecommerce's address
 * @param {{ file: string, route: string, type: string }} site
 */
export const proxyRoute = (base, { file, route, type }) =>
	[
		`// ${file} (Next.js App Router): served from your own domain, fetched with the server token`,
		'export async function GET(request) {',
		'  const { search } = new URL(request.url); // ?page=2 of a split sitemap',
		`  const response = await fetch(\`${base}${route}\${search}\`, {`,
		'    headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		'    next: { revalidate: 3600 }, // cache it for an hour',
		'  });',
		'  return new Response(await response.text(), {',
		'    status: response.status,',
		`    headers: { 'content-type': response.headers.get('content-type') ?? '${type}; charset=utf-8' },`,
		'  });',
		'}',
	].join('\n');

/**
 * @param {{ base: string, widgets: ReadonlyArray<{ key: string, kind: string }>, permissions: string[], browserToken?: string }} input
 *   `base`: Ecommerce's address; `browserToken`: the website's browser token (a placeholder when not known)
 */
export const createSnippets = ({ base, widgets, permissions, browserToken = 'YOUR_BROWSER_TOKEN' }) => {
	/** @param {'visitor' | 'admin'} kind */
	const keys = (kind) => widgets.filter((widget) => widget.kind === kind).map((widget) => widget.key);
	/** @param {string} key */
	const place = (key) => {
		const attributes = (WIDGET_ATTRIBUTES[key] ?? []).map((a) => ` ${a.name}="${a.example}"`).join('');
		return `<div ${WIDGET_ATTRIBUTE}="${key}"${attributes}></div>`;
	};
	const visitor = [
		`<script src="${base}/widget.js" data-token="${browserToken}" async></script>`,
		'',
		'<!-- place each widget where it belongs on your pages -->',
		...keys('visitor').map(place),
	].join('\n');
	const api = [
		'<script>',
		"  window.addEventListener('load', () => {",
		`    const shop = window.${WIDGET_GLOBAL};`,
		'    // the shopper signed in with Accounts (needed to order, review, keep a wishlist and set alerts); null on sign-out',
		'    window.SSAccounts.getSignIn().then((signIn) => shop.identify(signIn));',
		'    // your own Add to cart button (variantId and quantity are optional)',
		"    document.querySelector('#add').addEventListener('click', () =>",
		"      shop.addToCart({ productId: 'prd_…', variantId: 'var_…', quantity: 1 }),",
		'    );',
		"    // your header's cart badge",
		"    const badge = document.querySelector('#cart-count');",
		'    badge.textContent = String(shop.cart.count());',
		'    shop.cart.onChange(() => (badge.textContent = String(shop.cart.count())));',
		'  });',
		'</script>',
	].join('\n');
	const addToCartEvent = [
		"// any script on the page (Chat's product cards do this): add to the Ecommerce cart",
		`const event = new CustomEvent('${ADD_TO_CART_EVENT}', {`,
		"  detail: { productId: 'prd_…', variantId: 'var_…', quantity: 1 },",
		'  cancelable: true,',
		'});',
		'window.dispatchEvent(event);',
		"// no Ecommerce widget on this page handled it: open the product's page instead",
		"if (!event.defaultPrevented) window.location.href = '/products/blue-kettle';",
	].join('\n');
	const admin = [
		`<script src="${base}/widget.js"></script>`,
		...keys('admin').map(place),
		'<script>',
		`  window.${WIDGET_GLOBAL}.admin({`,
		'    // your own server route (below): it checks the signed-in user and their role, then asks for a ticket',
		"    getTicket: () => fetch('/api/ss-ecommerce-ticket', { method: 'POST' }).then((response) => response.json()),",
		'  });',
		'</script>',
	].join('\n');
	const ticketBody = {
		user: { id: 'usr_1', name: 'Sam Staff', email: 'sam@example.com' },
		permissions,
		origin: 'https://admin.example.com',
	};
	const ticketNode = [
		"// your server, after checking the user's sign-in and role (Node.js 18+, also inside a Next.js route handler)",
		`const response = await fetch('${base}/v1/tickets', {`,
		"  method: 'POST',",
		"  headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}`, 'content-type': 'application/json' },",
		'  body: JSON.stringify({',
		'    user: { id: user.id, name: user.name, email: user.email },',
		`    permissions: ${JSON.stringify(permissions)}, // only what this user may do`,
		"    origin: 'https://admin.example.com', // the address of your admin page",
		'  }),',
		'});',
		'const { ticket, expiresAt } = await response.json(); // answer this to getTicket()',
	].join('\n');
	const ticketCurl = [
		`curl -X POST '${base}/v1/tickets' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN" \\',
		"  -H 'Content-Type: application/json' \\",
		`  -d '${JSON.stringify(ticketBody)}'`,
	].join('\n');
	const productMeta = [
		'// app/products/[slug]/page.js (Next.js App Router): meta tags and structured data from Ecommerce',
		'const seoOf = async (slug) => {',
		`  const response = await fetch(\`${base}/v1/seo/products/\${encodeURIComponent(slug)}\`, {`,
		'    headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		'    next: { revalidate: 300 },',
		'  });',
		'  return response.ok ? response.json() : null;',
		'};',
		'',
		'export async function generateMetadata({ params }) {',
		'  const seo = await seoOf((await params).slug);',
		'  if (!seo) return {};',
		'  return {',
		'    title: seo.title,',
		'    description: seo.description,',
		'    alternates: { canonical: seo.canonical },',
		'    openGraph: seo.image ? { images: [seo.image] } : undefined,',
		'  };',
		'}',
		'',
		'export default async function ProductPage({ params }) {',
		'  const { slug } = await params;',
		'  const seo = await seoOf(slug);',
		'  return (',
		'    <>',
		'      {/* jsonLd is already a string that is safe inside a script tag */}',
		'      {seo ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: seo.jsonLd }} /> : null}',
		`      <div ${WIDGET_ATTRIBUTE}="product_page" data-product={slug} />`,
		'    </>',
		'  );',
		'}',
	].join('\n');
	const policies = [
		'// app/policies/[name]/page.js (Next.js App Router): your shipping, returns, privacy and terms pages',
		'export default async function PolicyPage({ params }) {',
		'  const { name } = await params; // shipping, returns, privacy or terms',
		`  const response = await fetch('${base}/v1/policies', {`,
		'    headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		'    next: { revalidate: 3600 },',
		'  });',
		'  const found = response.ok ? await response.json() : {};',
		"  return <article style={{ whiteSpace: 'pre-wrap' }}>{found[name] ?? ''}</article>;",
		'}',
	].join('\n');
	const customerOrders = [
		'// your server: the last orders of an Accounts user (Accounts shows them in its Orders tab)',
		`const response = await fetch(\`${base}/v1/customers/\${encodeURIComponent(userId)}/orders?limit=5\`, {`,
		'  headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		'});',
		'const { items, loyaltyPoints } = await response.json();',
		'// items: [{ id, number, status, statusLabel, total, totalText, currency, createdAt }]',
	].join('\n');
	const courier = JSON.stringify(
		{
			bookUrl: 'https://api.courier.example/v1/shipments',
			trackUrl: 'https://api.courier.example/v1/shipments/{tracking}',
			apiKey: 'your courier API key',
			headers: '{"X-Api-Key":"{apiKey}"}',
			bodyTemplate:
				'{"reference":"{number}","name":"{name}","phone":"{phone}","address":"{line1}","city":"{city}","items":"{items}","cod":"{cod}"}',
			trackingPath: 'data.trackingNumber',
			statusPath: 'data.status',
		},
		null,
		2,
	);
	const cors = JSON.stringify(
		[
			{
				AllowedOrigins: ['https://shop.example.com', 'https://admin.example.com'],
				AllowedMethods: ['PUT', 'GET'],
				AllowedHeaders: ['content-type'],
				MaxAgeSeconds: 3600,
			},
		],
		null,
		2,
	);
	/** @type {Record<string, string>} */
	const site = Object.fromEntries(SITE_ROUTES.map((entry) => [entry.name, proxyRoute(base, entry)]));
	return Object.freeze({
		visitor,
		api,
		addToCartEvent,
		admin,
		ticketNode,
		ticketCurl,
		productMeta,
		policies,
		customerOrders,
		courier,
		cors,
		site,
	});
};
