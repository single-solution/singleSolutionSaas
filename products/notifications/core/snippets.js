/**
 * The code snippets the public docs and the dashboard's Developers tab show: the widget script, admin widgets with
 * their ticket function, the ticket request (Node.js and cURL), the send API, the push-permission event, the webhook
 * signature check and the reply addresses. Plain text; no I/O.
 * @module
 */
import { WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from './widgets.js';

/**
 * @param {{ base: string, widgets: ReadonlyArray<{ key: string, kind: string }>, permissions: string[] }} input `base`:
 *   the product's address
 */
export const createSnippets = ({ base, widgets, permissions }) => {
	/** @param {'visitor' | 'admin'} kind */
	const places = (kind) =>
		widgets.filter((widget) => widget.kind === kind).map((widget) => `<div ${WIDGET_ATTRIBUTE}="${widget.key}"></div>`);
	const visitorSnippet = [
		`<script src="${base}/widget.js" data-token="YOUR_BROWSER_TOKEN" async></script>`,
		...places('visitor'),
	].join('\n');
	const adminSnippet = [
		`<script src="${base}/widget.js"></script>`,
		...places('admin'),
		'<script>',
		`  window.${WIDGET_GLOBAL}.admin({`,
		'    // your own server route (below): it checks the signed-in user, then asks for a ticket',
		"    getTicket: () => fetch('/api/ss-ticket', { method: 'POST' }).then((response) => response.json()),",
		'  });',
		'</script>',
	].join('\n');
	const ticketBody = {
		user: { id: 'u_1', name: 'Sam Staff', email: 'sam@example.com' },
		permissions,
		origin: 'https://admin.example.com',
	};
	const nodeSnippet = [
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
	const curlSnippet = [
		`curl -X POST '${base}/v1/tickets' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN" \\',
		"  -H 'Content-Type: application/json' \\",
		`  -d '${JSON.stringify(ticketBody)}'`,
	].join('\n');
	const sendSnippet = [
		'// your server (Node.js 18+, also inside a Next.js route handler); other products send the same way',
		`const response = await fetch('${base}/v1/messages/whatsapp', {`,
		"  method: 'POST',",
		'  headers: {',
		'    authorization: `Bearer ${process.env.SS_SERVER_TOKEN}`,',
		"    'content-type': 'application/json',",
		"    'idempotency-key': crypto.randomUUID(),",
		'  },',
		'  body: JSON.stringify({',
		"    template: 'order_ready',",
		"    to: { phone: '+15551234567', email: 'sam@example.com', language: 'en', timeZone: 'America/New_York' },",
		"    values: { name: 'Sam', order: '1042' },",
		"    // sendAt: '2026-12-01T09:00:00Z', // Delayed send",
		'  }),',
		'});',
		'const message = await response.json(); // { id, status, attempts, … }',
	].join('\n');
	const sendCurl = [
		`curl -X POST '${base}/v1/messages/email' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN" \\',
		"  -H 'Content-Type: application/json' \\",
		`  -d '${JSON.stringify({ template: 'order_ready', to: { email: 'sam@example.com' }, values: { name: 'Sam' } })}'`,
	].join('\n');
	const pushSnippet = [
		...places('visitor'),
		'<script>',
		`  window.addEventListener('ss-notifications:subscribed', (event) => {`,
		'    // send event.detail.subscriberId to your server and keep it with your user',
		'  });',
		'</script>',
	].join('\n');
	const webhookSnippet = [
		"import { createHmac, timingSafeEqual } from 'node:crypto';",
		'',
		'// body: the raw request body (text); header: the SS-Signature header',
		'export const verify = (body, header, secret) => {',
		"  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=')));",
		'  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;',
		"  const expected = createHmac('sha256', secret).update(`${parts.t}.${body}`).digest('hex');",
		'  return parts.v1?.length === expected.length && timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));',
		'};',
	].join('\n');
	const inbound = [`${base}/v1/inbound/<websiteId>/sms`, `${base}/v1/inbound/<websiteId>/whatsapp`].join('\n');
	return {
		visitor: visitorSnippet,
		admin: adminSnippet,
		ticketNode: nodeSnippet,
		ticketCurl: curlSnippet,
		send: sendSnippet,
		sendCurl,
		push: pushSnippet,
		webhook: webhookSnippet,
		inbound,
	};
};
