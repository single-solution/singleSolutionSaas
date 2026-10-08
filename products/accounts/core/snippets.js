/**
 * The code snippets the public docs and the dashboard's Developers tab show: the widget script and its JS API, admin
 * widgets with their ticket function, the ticket request (Node.js and cURL), offline sign-in verification on the
 * merchant's server, the public keys address and the social sign-in return addresses. Plain text; no I/O.
 * @module
 */
import { SIGN_IN_HEADER, WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from './widgets.js';

/**
 * @param {{ base: string, widgets: ReadonlyArray<{ key: string, kind: string }>, permissions: string[], websiteId?: string }} input
 *   `base`: Accounts' address; `websiteId`: filled in where known (else `<websiteId>`)
 */
export const createSnippets = ({ base, widgets, permissions, websiteId = '<websiteId>' }) => {
	/** @param {'visitor' | 'admin'} kind */
	const places = (kind) =>
		widgets.filter((widget) => widget.kind === kind).map((widget) => `<div ${WIDGET_ATTRIBUTE}="${widget.key}"></div>`);
	const visitor = [
		`<script src="${base}/widget.js" data-token="YOUR_BROWSER_TOKEN" async></script>`,
		...places('visitor'),
		'<script>',
		"  window.addEventListener('ss-accounts:signed-in', async (event) => {",
		'    // event.detail.user is the signed-in user; send a fresh sign-in to your own server with each request:',
		`    const signIn = await window.${WIDGET_GLOBAL}.getSignIn(); // null when signed out`,
		"    await fetch('/api/me', { headers: { authorization: `Bearer ${signIn}` } });",
		'  });',
		"  window.addEventListener('ss-accounts:signed-out', () => { /* … */ });",
		'</script>',
	].join('\n');
	const admin = [
		`<script src="${base}/widget.js"></script>`,
		...places('admin'),
		'<script>',
		`  window.${WIDGET_GLOBAL}.admin({`,
		'    // your own server route (below): it checks the signed-in user and their role, then asks for a ticket',
		"    getTicket: () => fetch('/api/ss-ticket', { method: 'POST' }).then((response) => response.json()),",
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
	const keysUrl = `${base}/v1/websites/${websiteId}/keys`;
	const verify = [
		'// your server: check a sign-in offline with the public keys (cache them; no call per check)',
		"import { createPublicKey, verify } from 'node:crypto';",
		'',
		`const { issuer, keys } = await (await fetch('${keysUrl}')).json();`,
		'',
		'export const checkSignIn = (token) => {',
		"  const [header, payload, signature] = String(token).split('.');",
		"  const head = JSON.parse(Buffer.from(header, 'base64url'));",
		'  const jwk = keys.find((key) => key.kid === head.kid);',
		"  if (head.alg !== 'EdDSA' || !jwk) return null;",
		"  const key = createPublicKey({ key: jwk, format: 'jwk' });",
		"  if (!verify(null, Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, 'base64url'))) return null;",
		"  const claims = JSON.parse(Buffer.from(payload, 'base64url'));",
		`  if (claims.iss !== issuer || claims.aud !== '${websiteId}' || claims.exp * 1000 < Date.now()) return null;`,
		'  return claims; // { sub, email, phone, name, role, permissions, … }',
		'};',
	].join('\n');
	const verifyJose = [
		"// or with the jose library: import { createRemoteJWKSet, jwtVerify } from 'jose';",
		`const jwks = createRemoteJWKSet(new URL('${keysUrl}'));`,
		`const { payload } = await jwtVerify(token, jwks, { issuer: '${base}', audience: '${websiteId}' });`,
	].join('\n');
	const signedInCall = [
		'// the visitor API of a signed-in user: the browser token plus the sign-in',
		`await fetch('${base}/v1/me', {`,
		'  headers: {',
		"    authorization: 'Bearer YOUR_BROWSER_TOKEN',",
		`    '${SIGN_IN_HEADER}': await window.${WIDGET_GLOBAL}.getSignIn(),`,
		'  },',
		'});',
	].join('\n');
	const returnAddresses = ['google', 'apple', 'facebook'].map((provider) => `${base}/oauth/${provider}/callback`).join('\n');
	return { visitor, admin, ticketNode, ticketCurl, verify, verifyJose, keysUrl, signedInCall, returnAddresses };
};
