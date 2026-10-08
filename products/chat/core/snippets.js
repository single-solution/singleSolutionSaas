/**
 * The code snippets the public docs and the dashboard's Developers tab show: the widget script and its JS API
 * (`identify`, `setPage`, `onUnread`), admin widgets with their ticket function, the ticket request (Node.js and cURL),
 * the tool signature check on the merchant's server and the booking endpoint's two requests. Plain text; no I/O.
 * @module
 */
import { TOOL_SIGNATURE_HEADER } from './tools.js';
import { WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from './widgets.js';

/**
 * @param {{ base: string, widgets: ReadonlyArray<{ key: string, kind: string }>, permissions: string[], browserToken?: string }} input
 *   `base`: Chat's address
 */
export const createSnippets = ({ base, widgets, permissions, browserToken = 'YOUR_BROWSER_TOKEN' }) => {
	const admins = widgets.filter((widget) => widget.kind === 'admin').map((w) => `<div ${WIDGET_ATTRIBUTE}="${w.key}"></div>`);
	const visitor = [
		`<script src="${base}/widget.js" data-token="${browserToken}" async></script>`,
		'<script>',
		'  // after the script loaded (window.SSChat exists):',
		'  // a visitor signed in with Accounts chats as themselves (call identify(null) on sign-out)',
		`  window.SSAccounts.getSignIn().then((signIn) => window.${WIDGET_GLOBAL}.identify(signIn));`,
		'  // what the visitor is viewing, for the nudge and the opener (product, category, deals, cart or other)',
		`  window.${WIDGET_GLOBAL}.setPage({ kind: 'product', productId: 'p_123', productName: 'Blue kettle' });`,
		'  // your own menu badge: replies the visitor has not seen',
		`  window.${WIDGET_GLOBAL}.onUnread((count) => { /* … */ });`,
		'</script>',
	].join('\n');
	const admin = [
		`<script src="${base}/widget.js"></script>`,
		...admins,
		'<script>',
		`  window.${WIDGET_GLOBAL}.admin({`,
		'    // your own server route (below): it checks the signed-in user and their role, then asks for a ticket',
		"    getTicket: () => fetch('/api/ss-chat-ticket', { method: 'POST' }).then((response) => response.json()),",
		'  });',
		`  window.${WIDGET_GLOBAL}.onUnread((count) => { /* the unread count of the inbox, for your own menu */ });`,
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
		`  -d '${JSON.stringify(ticketBody)}'`,
	].join('\n');
	const toolCheck = [
		'// your tool or booking endpoint: check that the call comes from Chat (Node.js)',
		"import { createHmac, timingSafeEqual } from 'node:crypto';",
		'',
		'export const fromChat = (rawBody, header, secret) => {',
		`  // header = request.headers['${TOOL_SIGNATURE_HEADER}'] = 't=<unix seconds>,v1=<hex>'`,
		"  const parts = Object.fromEntries(String(header).split(',').map((part) => part.split('=')));",
		'  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;',
		"  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');",
		'  return expected.length === String(parts.v1).length && timingSafeEqual(Buffer.from(expected), Buffer.from(String(parts.v1)));',
		'};',
	].join('\n');
	return { visitor, admin, ticketNode, ticketCurl, toolCheck };
};
