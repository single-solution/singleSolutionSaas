/**
 * The code snippets the public docs and the dashboard's Developers tab show: the page script, the consent and page
 * APIs, the shop events, the admin widgets with their ticket function, the ticket request, robots.txt and the
 * verification tags served from the merchant's site, IndexNow, the SEO checklist and the analytics API. Plain text; no
 * I/O.
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
		'</script>',
	].join('\n');
	const events = [
		'// Ecommerce’s widgets send these by themselves; your own code may send them too.',
		'// Money is in minor units (cents, paisa …) with an ISO 4217 currency.',
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
		'# your site serves the key at https://<your domain>/<key>.txt (GET /v1/indexnow/key.txt gives it)',
		`curl -X POST '${base}/v1/indexnow' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN" \\',
		"  -H 'Content-Type: application/json' \\",
		`  -d '${JSON.stringify({ urls: ['https://shop.example.com/products/new-phone'] })}'`,
	].join('\n');
	const seo = [
		`curl -X POST '${base}/v1/seo/checks' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN" \\',
		"  -H 'Content-Type: application/json' \\",
		`  -d '${JSON.stringify({ paths: ['/', '/shop'] })}'`,
	].join('\n');
	const analytics = [
		`curl '${base}/v1/analytics?from=2026-10-01&to=2026-10-31' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN"',
		'',
		'# raw events, newest first (kept for the retention you set)',
		`curl '${base}/v1/events?type=purchase&limit=50' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN"',
		'',
		'# how many raw events, in all and per type ({ count, capped }; { total, groups })',
		`curl '${base}/v1/events/count?type=purchase' -H "Authorization: Bearer $SS_SERVER_TOKEN"`,
		`curl '${base}/v1/events/counts?by=type' -H "Authorization: Bearer $SS_SERVER_TOKEN"`,
	].join('\n');
	return { pageScript, consent, page, events, admin, ticketNode, ticketCurl, robots, indexNow, seo, analytics };
};
