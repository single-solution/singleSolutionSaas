/**
 * The code snippets the public docs and the dashboard's Developers tab show: the widget script and the pay button, the
 * admin widgets with their ticket function, the ticket request, the payment API (create, verify, refund), payment links,
 * subscriptions, the webhook signature check and the addresses merchants register with each gateway. Plain text; no
 * I/O.
 * @module
 */
import { WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from './widgets.js';

/**
 * The addresses a merchant registers with each gateway for one website (`<websiteId>` when not known).
 * @param {string} base the product's address
 * @param {string} [websiteId]
 */
export const callbackUrls = (base, websiteId = '<websiteId>') => ({
	stripe: `${base}/v1/gateways/stripe/${websiteId}`,
	paypal: `${base}/v1/gateways/paypal/${websiteId}`,
	payfast: `${base}/v1/gateways/payfast/${websiteId}`,
	jazzcash: `${base}/return/jazzcash/${websiteId}`,
	easypaisa: `${base}/return/easypaisa/${websiteId}`,
	generic: `${base}/v1/gateways/generic/${websiteId}`,
});

/**
 * @param {{ base: string, widgets: ReadonlyArray<{ key: string, kind: string }>, permissions: string[] }} input `base`:
 *   the product's address
 */
export const createSnippets = ({ base, widgets, permissions }) => {
	/** @param {'visitor' | 'admin'} kind */
	const places = (kind) =>
		widgets.filter((widget) => widget.kind === kind).map((widget) => `<div ${WIDGET_ATTRIBUTE}="${widget.key}"></div>`);
	const visitor = [
		`<script src="${base}/widget.js" data-token="YOUR_BROWSER_TOKEN" async></script>`,
		'<!-- a payment link: the payer picks the gateway (and the amount when the link has none) -->',
		`<div ${WIDGET_ATTRIBUTE}="pay_button" data-link="link_…"></div>`,
		'<!-- a payment your server created: the payer pays it -->',
		`<div ${WIDGET_ATTRIBUTE}="pay_button" data-payment="pay_…"></div>`,
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
	const create = [
		'// your server (Node.js 18+); Ecommerce does the same with the Payments token pasted into it',
		`const response = await fetch('${base}/v1/payments', {`,
		"  method: 'POST',",
		'  headers: {',
		'    authorization: `Bearer ${process.env.SS_SERVER_TOKEN}`,',
		"    'content-type': 'application/json',",
		"    'idempotency-key': `order-${order.id}`,",
		'  },',
		'  body: JSON.stringify({',
		'    amount: 250000, // minor units: 2,500.00',
		"    currency: 'PKR',",
		"    description: 'Order 1042',",
		"    reference: 'order-1042',",
		"    customer: { email: 'sam@example.com' },",
		"    returnUrl: 'https://shop.example.com/orders/1042',",
		"    // gateway: 'jazzcash', // or let the payer pick",
		'  }),',
		'});',
		'const payment = await response.json();',
		'// send the payer to payment.checkoutUrl',
	].join('\n');
	const verify = [
		'// before you mark the order paid: ask Payments, never trust what the browser brings back',
		`const response = await fetch(\`${base}/v1/payments/\${paymentId}/verify\`, {`,
		"  method: 'POST',",
		"  headers: { authorization: `Bearer ${process.env.SS_SERVER_TOKEN}`, 'content-type': 'application/json' },",
		"  body: JSON.stringify({ amount: 250000, currency: 'PKR' }),",
		'});',
		'const { verified } = await response.json(); // true only when it was paid for exactly that amount',
	].join('\n');
	const refund = [
		`curl -X POST '${base}/v1/payments/pay_…/refunds' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN" \\',
		"  -H 'Content-Type: application/json' -H 'Idempotency-Key: refund-1042-1' \\",
		`  -d '${JSON.stringify({ amount: 50000, reason: 'One item returned' })}'`,
	].join('\n');
	const link = [
		`curl -X POST '${base}/v1/links' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN" \\',
		"  -H 'Content-Type: application/json' \\",
		`  -d '${JSON.stringify({ title: 'Donation', currency: 'USD', amount: null, minAmount: 500 })}'`,
	].join('\n');
	const subscription = [
		`curl -X POST '${base}/v1/subscriptions' \\`,
		'  -H "Authorization: Bearer $SS_SERVER_TOKEN" \\',
		"  -H 'Content-Type: application/json' \\",
		`  -d '${JSON.stringify({ gateway: 'stripe', plan: 'price_…', customer: { email: 'sam@example.com' }, returnUrl: 'https://shop.example.com/account' })}'`,
	].join('\n');
	const webhook = [
		"import { createHmac, timingSafeEqual } from 'node:crypto';",
		'',
		'// body: the raw request body (text); header: the SS-Signature header Notifications adds',
		'export const verify = (body, header, secret) => {',
		"  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=')));",
		'  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;',
		"  const expected = createHmac('sha256', secret).update(`${parts.t}.${body}`).digest('hex');",
		'  return parts.v1?.length === expected.length && timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));',
		'};',
	].join('\n');
	return { visitor, admin, ticketNode, ticketCurl, create, verify, refund, link, subscription, webhook };
};
