/**
 * The public docs at `/docs` (PLAN 0.4.10): the kit's page (`renderDocsPage`: the intro, the localhost note, the kit's
 * routes for your server, the business.json template and the API reference from `openapi.json`) around this product's
 * own sections: the per-feature guides with their routes, widgets and what the website builds
 * (`docsFeatureSections`), the widget snippets and the ticket server snippet (Node.js fetch and cURL). Plain HTML;
 * every value is escaped.
 * @module
 */
import { docsBlock, docsFeatureSections, docsOperations, docsParagraph, renderDocsPage } from '@ss/app-kit';
import { widgetScriptTag } from '@ss/contracts/text';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { WIDGET_ATTRIBUTE, WIDGET_GLOBAL } from '../core/widgets.js';
import { manifest } from '../adapters/product.js';

/**
 * The docs page.
 * @param {{ base: string }} input the product's address (snippets point at it)
 * @returns {string}
 */
export const renderDocs = ({ base }) => {
	/** @param {'visitor' | 'admin'} kind */
	const places = (kind) =>
		manifest.widgets
			.filter((widget) => widget.kind === kind)
			.map((widget) => `<div ${WIDGET_ATTRIBUTE}="${widget.key}"></div>`);
	const visitorSnippet = [widgetScriptTag({ src: `${base}/widget.js`, token: 'YOUR_BROWSER_TOKEN' }), ...places('visitor')].join(
		'\n',
	);
	const adminSnippet = [
		widgetScriptTag({ src: `${base}/widget.js`, loading: 'blocking' }),
		...places('admin'),
		'<script>',
		`  window.${WIDGET_GLOBAL}.admin({`,
		'    // your own server route (below): it checks the signed-in user, then asks for a ticket',
		"    getTicket: () => fetch('/api/ss-ticket', { method: 'POST' }).then((response) => response.json()),",
		'  });',
		'</script>',
	].join('\n');
	const permissions = manifest.permissions.map((permission) => permission.key);
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
	return renderDocsPage({
		guide,
		openapi,
		body: [
			'<h2>Features</h2>',
			docsFeatureSections({ manifest, rows: docsOperations(openapi), guide }),
			'<h2>Install the widgets</h2>',
			docsParagraph(guide.install),
			docsBlock(visitorSnippet),
			'<h2>Admin widgets and tickets</h2>',
			docsParagraph(guide.admin),
			docsBlock(adminSnippet),
			docsParagraph(guide.tickets),
			docsBlock(nodeSnippet),
			docsBlock(curlSnippet),
		].join('\n'),
	});
};
