/**
 * The code snippets the public docs and the dashboard's Developers tab show (PLAN 0.4.10): the widget script with the
 * visitor widgets and their data attributes, the JS API (`identify`, `addToCart`, `cart.count`, `cart.onChange`) and
 * the add-to-cart event, the admin widgets with their ticket function, the ticket request (Node.js and cURL), what the
 * merchant's site serves from the API as Next.js route handlers and pages fetching with the server token
 * (`SS_SERVER_TOKEN`): the sitemap index and its files, the media route (stable image addresses, SEO audit G1),
 * feeds, llms.txt and llms-full.txt, the home page (the business and website, E49), the product page (meta,
 * structured data and the 308 of a `moved` answer, PLAN 0.8.10 E13), a listing page with `/v1/seo/listing` (E15) and
 * the policy pages; the Accounts Orders lookup, the courier connection and the storage CORS rule. Plain text; no I/O.
 * @module
 */
import { widgetScriptTag } from '@ss/contracts/text';
import { ADD_TO_CART_EVENT, WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from './widgets.js';

/**
 * The data attributes each visitor widget reads (all optional except `data-product`).
 * @type {Readonly<Record<string, ReadonlyArray<{ name: string, example: string, help: string }>>>}
 */
export const WIDGET_ATTRIBUTES = Object.freeze({
	product_grid: Object.freeze([
		{ name: 'data-category', example: 'accessories', help: 'only this category (its id or slug) and its subcategories' },
		{ name: 'data-brand', example: 'acme', help: 'only these brands (ids or slugs, comma-separated)' },
		{ name: 'data-grade', example: '', help: 'only these grades (keys, comma-separated)' },
		{ name: 'data-featured', example: '', help: '1: only featured products' },
		{ name: 'data-deal', example: '', help: "only this deal's products (its id or slug)" },
		{
			name: 'data-sort',
			example: 'newest',
			help: 'the first sort: newest, price_asc, price_desc, top, rating, name, updated or sold_asc',
		},
		{ name: 'data-query', example: '', help: 'start with this search text' },
		{ name: 'data-limit', example: '24', help: 'products per page' },
	]),
	product_page: Object.freeze([
		{ name: 'data-product', example: 'blue-kettle', help: "the product's id or slug (required)" },
		{
			name: 'data-heading',
			example: 'h1',
			help: "the heading of the product's name: h1 (the page's h1, the default), or h2 or h3 when your page has its own h1",
		},
	]),
});

/**
 * What the merchant's own site serves from the API: the path on the merchant's site, the Ecommerce route, the feature
 * and the content type of the answer.
 */
export const SITE_ROUTES = Object.freeze([
	// the sitemap has its own handler (the index's files come from /v1/seo/sitemaps/:file): `sitemapRoute`
	{
		name: 'sitemap',
		file: 'app/sitemap.xml/route.js',
		route: '/v1/seo/sitemap.xml',
		feature: 'catalog',
		type: 'application/xml',
	},
	// the media route has its own handler (it serves the file of each stable image address): `mediaRoute`
	{ name: 'media', file: 'app/media/[...key]/route.js', route: '/v1/media', feature: 'catalog', type: 'image/*' },
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
	{
		name: 'llmsFull',
		file: 'app/llms-full.txt/route.js',
		route: '/v1/llms-full.txt',
		feature: 'llms_txt',
		type: 'text/plain',
	},
]);

/**
 * A Next.js route handler on the merchant's site that serves one Ecommerce answer from the merchant's own domain.
 * @param {string} base Ecommerce's address
 * @param {{ file: string, route: string, type: string }} site
 */
export const proxyRoute = (base, { file, route, type }) =>
	[
		`// ${file} (Next.js App Router): served from your own domain, fetched with the server token`,
		'export async function GET() {',
		`  const response = await fetch('${base}${route}', {`,
		'    headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		"    next: { revalidate: 3600, tags: ['ss-ecommerce'] }, // cache it for an hour",
		'  });',
		'  return new Response(await response.text(), {',
		'    status: response.status,',
		`    headers: { 'content-type': response.headers.get('content-type') ?? '${type}; charset=utf-8' },`,
		'  });',
		'}',
	].join('\n');

/**
 * The sitemap's route handler on the merchant's site (E16): the sitemap, or above `SITEMAP_FILE_SIZE` addresses a sitemap
 * index whose files are this same address with `?file=<name>`, each fetched from `/v1/seo/sitemaps/:file`.
 * @param {string} base Ecommerce's address
 */
export const sitemapRoute = (base) =>
	[
		'// app/sitemap.xml/route.js (Next.js App Router): the sitemap, or the sitemap index and its files, from your own domain',
		'export async function GET(request) {',
		'  // a large catalog answers an index of files at this address: ?file=categories, ?file=products-1 …',
		"  const file = new URL(request.url).searchParams.get('file');",
		"  const path = file ? `/v1/seo/sitemaps/${encodeURIComponent(file)}` : '/v1/seo/sitemap.xml';",
		`  const response = await fetch(\`${base}\${path}\`, {`,
		'    headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		"    next: { revalidate: 3600, tags: ['ss-ecommerce'] }, // cache it for an hour",
		'  });',
		'  return new Response(await response.text(), {',
		'    status: response.status,',
		"    headers: { 'content-type': response.headers.get('content-type') ?? 'application/xml; charset=utf-8' },",
		'  });',
		'}',
	].join('\n');

/**
 * The media route on the merchant's site (G1): the stable image addresses search engines, sitemaps and feeds get while
 * the `catalog` setting `mediaBaseUrl` is empty (`<mediaPath>/<signature>/<key>`, /media by default); it asks
 * `GET /v1/media` for a short-lived link to the file and serves the file with a long cache (an address never changes
 * for the same file).
 * @param {string} base Ecommerce's address
 */
export const mediaRoute = (base) =>
	[
		'// app/media/[...key]/route.js (Next.js App Router): your images at addresses that never change, for search engines',
		'// and shopping catalogs (the catalog setting mediaPath, /media by default)',
		'export async function GET(request, { params }) {',
		"  const [signature = '', ...parts] = (await params).key;",
		"  const query = new URLSearchParams({ key: parts.join('/'), signature });",
		`  const answer = await fetch(\`${base}/v1/media?\${query}\`, {`,
		'    headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		"    cache: 'no-store', // a fresh link each time",
		'  });',
		"  if (!answer.ok) return new Response('Not found', { status: 404 });",
		'  const file = await fetch((await answer.json()).url);',
		"  if (!file.ok) return new Response('Not found', { status: 404 });",
		'  return new Response(file.body, {',
		'    headers: {',
		"      'content-type': file.headers.get('content-type') ?? 'application/octet-stream',",
		"      'cache-control': 'public, max-age=31536000, immutable', // browsers and your CDN keep it",
		'    },',
		'  });',
		'}',
	].join('\n');

/**
 * The webhook route on the merchant's site that clears its cached Ecommerce answers (SEO audit G10): every snippet
 * fetches with the tag `ss-ecommerce`, and this route, the URL of an outgoing webhook in Notifications (with Events on),
 * clears it when the catalog or the settings change, for an event whose SS-Signature checks out only.
 */
const CACHE_ROUTE = [
	'// app/api/ss-ecommerce-events/route.js (Next.js App Router): clears your cached Ecommerce answers when the catalog',
	'// or the settings change (Events on; this address is an outgoing webhook URL in Notifications)',
	"import { createHmac, timingSafeEqual } from 'node:crypto';",
	"import { revalidateTag } from 'next/cache';",
	'',
	'export async function POST(request) {',
	'  const body = await request.text();',
	'  // SS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>"> with your Notifications signing secret',
	"  const parts = Object.fromEntries((request.headers.get('ss-signature') ?? '').split(',').map((part) => part.split('=')));",
	"  const expected = createHmac('sha256', process.env.SS_WEBHOOK_SECRET).update(`${parts.t}.${body}`).digest('hex');",
	'  const recent = Math.abs(Date.now() / 1000 - Number(parts.t)) <= 300;',
	"  const signed = /^[0-9a-f]{64}$/.test(parts.v1 ?? '');",
	'  if (!recent || !signed || !timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected)))',
	"    return new Response('Bad signature', { status: 401 });",
	'  const { type } = JSON.parse(body);',
	"  if (type === 'ecommerce.catalog.changed' || type === 'ecommerce.settings.changed') revalidateTag('ss-ecommerce');",
	'  return new Response(null, { status: 204 });',
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
		widgetScriptTag({ src: `${base}/widget.js`, token: browserToken }),
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
		widgetScriptTag({ src: `${base}/widget.js`, loading: 'blocking' }),
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
	const homePage = [
		'// app/page.js (Next.js App Router): your home page head, with your business and website for search engines',
		'const siteOf = async () => {',
		`  const response = await fetch('${base}/v1/seo/site', {`,
		'    headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		"    next: { revalidate: 300, tags: ['ss-ecommerce'] },",
		'  });',
		'  return response.ok ? response.json() : null;',
		'};',
		'',
		'export async function generateMetadata() {',
		'  const site = await siteOf();',
		'  if (!site) return {};',
		'  return {',
		'    title: site.title,',
		'    description: site.description,',
		'    alternates: { canonical: site.canonical },',
		'    // shared links: og and twitter carry the title, text and image to show',
		'    openGraph: {',
		'      type: site.og.type,',
		'      url: site.og.url,',
		'      siteName: site.og.siteName,',
		'      images: site.og.image ? [{ url: site.og.image, alt: site.og.imageAlt }] : undefined,',
		'    },',
		'    twitter: { card: site.twitter.card },',
		'  };',
		'}',
		'',
		'export default async function HomePage() {',
		'  const site = await siteOf();',
		'  return (',
		'    <>',
		'      {/* jsonLd is already a string that is safe inside a script tag */}',
		'      {site ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: site.jsonLd }} /> : null}',
		'      {/* the rest of your home page */}',
		'    </>',
		'  );',
		'}',
	].join('\n');
	const productMeta = [
		'// app/products/[slug]/page.js (Next.js App Router): meta tags, structured data and moved addresses from Ecommerce',
		"import { notFound, permanentRedirect } from 'next/navigation';",
		'',
		'const seoOf = async (slug) => {',
		"  // html=1: the page core as plain HTML, printed into the widget's place (search engines read it before any script)",
		`  const response = await fetch(\`${base}/v1/seo/products/\${encodeURIComponent(slug)}?html=1\`, {`,
		'    headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		"    next: { revalidate: 300, tags: ['ss-ecommerce'] },",
		'  });',
		'  return response.ok ? response.json() : null;',
		'};',
		'',
		'export async function generateMetadata({ params }) {',
		'  const seo = await seoOf((await params).slug);',
		'  if (!seo) return {};',
		'  // an earlier slug, or an archived product sent to its replacement or category: a 308 to its address now',
		'  if (seo.moved) permanentRedirect(seo.moved.url);',
		'  return {',
		'    title: seo.title,',
		'    description: seo.description,',
		'    alternates: { canonical: seo.canonical },',
		'    robots: seo.robots,',
		'    // shared links: og and twitter carry the title, text, image and price to show',
		'    openGraph: {',
		'      url: seo.og.url,',
		'      siteName: seo.og.siteName,',
		'      images: seo.og.image ? [{ url: seo.og.image, alt: seo.og.imageAlt }] : undefined,',
		'    },',
		'    twitter: { card: seo.twitter.card },',
		"    other: seo.og.price ? { 'product:price:amount': seo.og.price.amount, 'product:price:currency': seo.og.price.currency } : {},",
		'  };',
		'}',
		'',
		'export default async function ProductPage({ params }) {',
		'  const { slug } = await params;',
		'  const seo = await seoOf(slug);',
		'  if (!seo) notFound();',
		'  if (seo.moved) permanentRedirect(seo.moved.url);',
		'  // found by another path (another letter case, its id): one address per product',
		'  if (new URL(seo.url).pathname !== `/products/${encodeURIComponent(slug)}`) permanentRedirect(seo.url);',
		'  return (',
		'    <>',
		'      {/* jsonLd is already a string that is safe inside a script tag */}',
		'      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: seo.jsonLd }} />',
		'      {/* the page core first; the widget takes the place over once its script runs */}',
		`      <div ${WIDGET_ATTRIBUTE}="product_page" data-product={slug} dangerouslySetInnerHTML={{ __html: seo.html }} />`,
		'    </>',
		'  );',
		'}',
	].join('\n');
	const listingPage = [
		'// app/categories/[slug]/page.js (Next.js App Router): a category or landing page with its head from Ecommerce',
		"import { notFound, permanentRedirect } from 'next/navigation';",
		'',
		'const listingOf = async (slug, filters) => {',
		"  // your page's own query: brand, grade, page and any other filter (attr.<slug>, minPrice …)",
		"  // html=1: the grid's core as plain HTML (the products as links and the page links), printed into the grid's place",
		"  const query = new URLSearchParams({ ...filters, category: slug, html: '1' });",
		`  const response = await fetch(\`${base}/v1/seo/listing?\${query}\`, {`,
		'    headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		"    next: { revalidate: 300, tags: ['ss-ecommerce'] },",
		'  });',
		'  return response.ok ? response.json() : null;',
		'};',
		'',
		'export async function generateMetadata({ params, searchParams }) {',
		'  const head = await listingOf((await params).slug, await searchParams);',
		'  if (!head) return {};',
		'  if (head.moved) permanentRedirect(head.moved.url); // an earlier category slug',
		'  return {',
		'    title: head.title,',
		'    description: head.description,',
		'    alternates: { canonical: head.canonical },',
		'    robots: head.robots, // index only for the category (and its pages) and an indexable landing page',
		'    openGraph: {',
		'      type: head.og.type,',
		'      url: head.og.url ?? undefined,',
		'      siteName: head.og.siteName,',
		'      images: head.og.image ? [{ url: head.og.image, alt: head.og.imageAlt }] : undefined,',
		'    },',
		'    twitter: { card: head.twitter.card },',
		'  };',
		'}',
		'',
		'export default async function ListingPage({ params, searchParams }) {',
		'  const { slug } = await params;',
		'  const filters = await searchParams;',
		'  const head = await listingOf(slug, filters);',
		'  // field values by slug (attr.<slug>=…), for the grid of a landing page by a field',
		'  const attributes = new URLSearchParams(',
		"    Object.entries(filters).flatMap(([name, value]) => (name.startsWith('attr.') ? [[name.slice(5), String(value)]] : [])),",
		'  ).toString();',
		'  if (!head) notFound();',
		'  if (head.moved) permanentRedirect(head.moved.url);',
		'  // an empty filter result or a page past the end: a 404 at this address',
		'  if (head.status === 404) notFound();',
		'  return (',
		'    <>',
		'      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: head.jsonLd }} />',
		'      <h1>{head.h1}</h1>',
		'      {head.intro ? <p>{head.intro}</p> : null}',
		`      <div ${WIDGET_ATTRIBUTE}="product_grid" data-category={slug} data-brand={filters.brand ?? ''} data-grade={filters.grade ?? ''} data-attributes={attributes} dangerouslySetInnerHTML={{ __html: head.html }} />`,
		'      {head.faqs.map((faq) => (',
		'        <details key={faq.question}>',
		'          <summary>{faq.question}</summary>',
		'          <p>{faq.answer}</p>',
		'        </details>',
		'      ))}',
		'    </>',
		'  );',
		'}',
	].join('\n');
	const policies = [
		'// app/policies/[name]/page.js (Next.js App Router): a page for each policy of your list (Settings → Policies)',
		'export default async function PolicyPage({ params }) {',
		'  const { name } = await params; // a policy key: shipping, returns, warranty, privacy, terms or one you added',
		`  const response = await fetch('${base}/v1/policies', {`,
		'    headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		"    next: { revalidate: 3600, tags: ['ss-ecommerce'] },",
		'  });',
		'  const found = response.ok ? await response.json() : { policies: [] };',
		'  const policy = found.policies.find((each) => each.key === name);',
		"  const text = policy?.text ?? '';",
		'  // HTML Ecommerce already cleaned to paragraphs, lists, headings, emphasis, quotes and links',
		'  return <article dangerouslySetInnerHTML={{ __html: text }} />;',
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
	const site = Object.fromEntries(
		SITE_ROUTES.map((entry) => [
			entry.name,
			entry.name === 'sitemap' ? sitemapRoute(base) : entry.name === 'media' ? mediaRoute(base) : proxyRoute(base, entry),
		]),
	);
	return Object.freeze({
		visitor,
		api,
		addToCartEvent,
		admin,
		ticketNode,
		ticketCurl,
		homePage,
		productMeta,
		cacheRoute: CACHE_ROUTE,
		listingPage,
		policies,
		customerOrders,
		courier,
		cors,
		site,
	});
};
