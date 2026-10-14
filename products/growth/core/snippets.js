/**
 * The code snippets the public docs and the dashboard's Developers tab show: the page script, the consent and page
 * APIs, the shop events, the admin widgets with their ticket function, the ticket request, robots.txt and the
 * verification tags served from the merchant's site, IndexNow, the SEO checklist, the redirects (edge middleware) and
 * the analytics API. Plain text; no I/O.
 * @module
 */
import { PAGE_MARKER, WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from './widgets.js';

/**
 * @param {{ base: string, widgets: ReadonlyArray<{ key: string, kind: string }>, permissions: string[] }} input `base`:
 *   the product's address
 */
export const createSnippets = ({ base, widgets, permissions }) => {
	/** @param {'visitor' | 'admin'} kind */
	const places = (kind) =>
		widgets.filter((widget) => widget.kind === kind).map((widget) => `<div ${WIDGET_ATTRIBUTE}="${widget.key}"></div>`);
	const pageScript = [
		'<!-- in the <head> of every page, before the other products’ scripts (so it hears their shop events) -->',
		`<script src="${base}/widget.js" data-token="YOUR_BROWSER_TOKEN"></script>`,
		'<!-- optional: where the notice bar goes (else it is placed at the top of the page) -->',
		`<div ${WIDGET_ATTRIBUTE}="notice_bar"></div>`,
	].join('\n');
	const consent = [
		'<!-- reopen the consent banner, for example from your footer -->',
		`<button type="button" onclick="${WIDGET_GLOBAL}.consent.open()">Cookie settings</button>`,
		'<script>',
		'  // with your own consent tool instead of the banner: pass the visitor’s choice on',
		`  ${WIDGET_GLOBAL}.consent.set({ analytics: true, marketing: false });`,
		`  ${WIDGET_GLOBAL}.consent.get(); // { analytics, marketing, at } or null`,
		'</script>',
	].join('\n');
	const page = [
		'<!-- a page that does not exist (your 404 page) -->',
		`<meta name="${PAGE_MARKER}" content="not_found">`,
		'<script>',
		`  ${WIDGET_GLOBAL}.notFound(); // or call it from your code`,
		'  // a site search your page runs itself (search result pages with ?q= are found by themselves)',
		`  ${WIDGET_GLOBAL}.search('blue shoes', { results: 0 });`,
		"  // or as a browser event: window.dispatchEvent(new CustomEvent('ss:search', { detail: { term: 'blue shoes', results: 0 } }))",
		'</script>',
		'<!-- a contact: the pixels get Contact (Meta, TikTok) and generate_lead (Google Analytics) -->',
		`<a href="https://wa.me/15550000000" onclick="${WIDGET_GLOBAL}.contact({ method: 'whatsapp' })">WhatsApp us</a>`,
	].join('\n');
	const events = [
		'// Ecommerce’s widgets send these by themselves; your own code may send them too.',
		'// Money is in minor units (cents, pence …) with an ISO 4217 currency.',
		"window.dispatchEvent(new CustomEvent('ss:view_item', { detail: {",
		"  currency: 'USD', value: 1250, items: [{ id: 'sku-1', name: 'Phone case', price: 1250, quantity: 1 }] } }));",
		"window.dispatchEvent(new CustomEvent('ss:add_to_cart', { detail: {",
		"  currency: 'USD', value: 2500, items: [{ id: 'sku-1', price: 1250, quantity: 2 }] } }));",
		"window.dispatchEvent(new CustomEvent('ss:begin_checkout', { detail: {",
		"  currency: 'USD', value: 2500, items: [{ id: 'sku-1', price: 1250, quantity: 2 }] } }));",
		"window.dispatchEvent(new CustomEvent('ss:purchase', { detail: {",
		"  orderId: '1042', currency: 'USD', value: 2500, items: [{ id: 'sku-1', price: 1250, quantity: 2 }] } }));",
	].join('\n');
	const admin = [
		`<script src="${base}/widget.js"></script>`,
		...places('admin'),
		'<script>',
		`  window.${WIDGET_GLOBAL}.admin({`,
		'    // your own server route (below): it checks the signed-in user, then asks for a ticket',
		"    getTicket: () => fetch('/api/ss-ticket', { method: 'POST' }).then((response) => response.json()),",
		'  });',
		'</script>',
	].join('\n');
	const ticketNode = [
		"// your server, after checking the user's sign-in and role (Node.js 18+, also inside a Next.js route handler)",
		`const response = await fetch('${base}/v1/tickets', {`,
		"  method: 'POST',",
		"  headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}`, 'content-type': 'application/json' },",
		'  body: JSON.stringify({',
		'    user: { id: user.id, name: user.name, email: user.email },',
		`    permissions: ${JSON.stringify(permissions)},`,
		"    origin: 'https://admin.example.com', // the address of your admin page",
		'  }),',
		'});',
		'const { ticket, expiresAt } = await response.json(); // answer this to getTicket()',
	].join('\n');
	const ticketCurl = [
		`curl -X POST '${base}/v1/tickets' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN" \\',
		"  -H 'Content-Type: application/json' \\",
		`  -d '${JSON.stringify({ user: { id: 'u_1', name: 'Sam Staff', email: 'sam@example.com' }, permissions, origin: 'https://admin.example.com' })}'`,
	].join('\n');
	const robots = [
		'// app/robots.txt/route.js on your site (Next.js): serve Growth’s robots.txt',
		'export const revalidate = 3600;',
		'export async function GET() {',
		`  const response = await fetch('${base}/v1/robots.txt', {`,
		'    headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		'  });',
		"  return new Response(await response.text(), { headers: { 'content-type': 'text/plain' } });",
		'}',
		'',
		'// your page head: the verification tags ({ tags: [{ name, content }], html })',
		`const { tags } = await fetch('${base}/v1/verification', {`,
		'  headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}` },',
		'}).then((response) => response.json());',
		'// render <meta name={tag.name} content={tag.content} /> for each tag',
	].join('\n');
	const indexNow = [
		'# your site serves the key at https://<your domain>/<key>.txt, or at your key file address',
		'# (Settings, for example /indexnow-key.txt); GET /v1/indexnow/key.txt gives it',
		`curl -X POST '${base}/v1/indexnow' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN" \\',
		"  -H 'Content-Type: application/json' \\",
		`  -d '${JSON.stringify({ urls: ['https://shop.example.com/products/new-phone'] })}'`,
	].join('\n');
	const notice = [
		'// your own notice bar: the notice while it shows, else null ({ text, linkText, linkUrl, dismissible })',
		`const notice = await fetch('${base}/v1/notice?path=' + encodeURIComponent(location.pathname), {`,
		"  headers: { authorization: 'Bearer YOUR_BROWSER_TOKEN' },",
		'}).then((response) => response.json());',
	].join('\n');
	const seo = [
		'# a full run: the pages of the checklist settings and sample pages from your sitemap (kept as the last report)',
		`curl -X POST '${base}/v1/seo/checks' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN" \\',
		"  -H 'Content-Type: application/json' -d '{}'",
		'',
		'# the last full run, without reading your site',
		`curl '${base}/v1/seo/report' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN"',
		'',
		'# some pages only (and the home page)',
		`curl -X POST '${base}/v1/seo/checks' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN" \\',
		"  -H 'Content-Type: application/json' \\",
		`  -d '${JSON.stringify({ paths: ['/shop', '/about'] })}'`,
	].join('\n');
	const analytics = [
		`curl '${base}/v1/analytics?from=2026-10-01&to=2026-10-31&top=25' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN"',
		'',
		'# raw events, newest first (kept for the retention you set); one session with ?session=<id> (sessions detail)',
		`curl '${base}/v1/events?type=purchase&limit=50' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN"',
		'',
		'# how many raw events, in all and per type ({ count, capped }; { total, groups })',
		`curl '${base}/v1/events/count?type=purchase' -H "Authorization: Bearer $SS_SERVER_TOKEN"`,
		`curl '${base}/v1/events/counts?by=type' -H "Authorization: Bearer $SS_SERVER_TOKEN"`,
	].join('\n');
	const redirects = [
		'// Redirects in edge middleware or a server hook (any framework): the list is kept in memory and read again at',
		'// most every 5 minutes with If-None-Match (304 while nothing changed, so it costs almost nothing).',
		"let kept = { etag: '', rules: [], readAt: 0 };",
		'async function redirectRules() {',
		'  if (Date.now() - kept.readAt < 300_000) return kept.rules;',
		'  kept.readAt = Date.now(); // on a failure the last list stays in use',
		'  try {',
		`    const response = await fetch('${base}/v1/redirects/all', {`,
		"      headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}`, ...(kept.etag ? { 'if-none-match': kept.etag } : {}) },",
		'    });',
		"    if (response.status === 200) kept = { etag: response.headers.get('etag') ?? '', rules: (await response.json()).rules, readAt: Date.now() };",
		'  } catch {}',
		'  return kept.rules;',
		'}',
		'',
		'// where a request goes: { status, location } (410: no location), or null when no rule answers it',
		'export async function redirectFor(url) {',
		'  // the path as rules keep it: one slash at a time, percent-escapes in upper case, no trailing slash except for /',
		"  let path = url.pathname.replace(/\\/{2,}/g, '/').replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());",
		"  if (path.length > 1) path = path.replace(/\\/$/, '');",
		'  const rules = await redirectRules();',
		"  const under = (from) => from === '/' || path === from || path.startsWith(`${from}/`);",
		"  const rule = rules.find((r) => r.match === 'exact' && r.from === path) ??",
		"    rules.filter((r) => r.match === 'prefix' && under(r.from)).sort((a, b) => b.from.length - a.from.length)[0];",
		'  if (!rule) return null;',
		'  if (rule.code === 410) return { status: 410 };',
		"  // a prefix rule keeps the rest of the path; the visitor's query string follows the target's own",
		"  const rest = rule.match === 'prefix' ? (rule.from === '/' ? (path === '/' ? '' : path) : path.slice(rule.from.length)) : '';",
		'  const target = new URL(rule.to, url);',
		"  if (rest) target.pathname = (target.pathname === '/' ? '' : target.pathname.replace(/\\/$/, '')) + rest;",
		"  target.search = [target.search.slice(1), url.search.slice(1)].filter(Boolean).join('&');",
		"  return { status: rule.code, location: rule.to.startsWith('/') ? `${target.pathname}${target.search}${target.hash}` : target.href };",
		'}',
		'',
		'// in the middleware: const found = await redirectFor(new URL(request.url));',
		'// if (found?.location) return Response.redirect(new URL(found.location, request.url), found.status);',
		"// if (found) return new Response('Gone', { status: 410 });",
		'',
		'// or ask for one address (one read on our side each time), for example only before answering a 404:',
		`// fetch('${base}/v1/redirects/match?path=' + encodeURIComponent(url.pathname + url.search), { headers })`,
		'// → 200 { code, location } or 204 (no rule)',
	].join('\n');
	return {
		pageScript,
		consent,
		page,
		events,
		admin,
		ticketNode,
		ticketCurl,
		robots,
		indexNow,
		seo,
		analytics,
		notice,
		redirects,
	};
};
