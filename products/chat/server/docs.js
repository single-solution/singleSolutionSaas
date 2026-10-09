/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.3): the visitor API with guests and signed-in visitors, AI, knowledge,
 * webhook tools and their signature check, the booking endpoint's two requests, handoff, flows, the Notifications
 * templates, attachments and the bucket's CORS rule, data rights and the activity log, the shop tools with the
 * Ecommerce routes they call, product cards and their add-to-cart event, the context panel's shop info, per-feature
 * routes and widgets, the widget snippets, the ticket server snippet (Node.js
 * fetch and cURL), the business.json template, the localhost note and the API reference from `openapi.json`. Plain
 * HTML; every value is escaped.
 * @module
 */
import { BUSINESS_JSON_TEMPLATE } from '@ss/contracts';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { CONTEXT_ENDPOINT, SHOP_ANSWERS, SHOP_ENDPOINTS } from '../core/shop.js';
import { createSnippets } from '../core/snippets.js';
import { MESSAGE_TEMPLATES, WIDGET_ATTRIBUTE } from '../core/widgets.js';
import { manifest } from '../adapters/product.js';

/** @param {unknown} value */
const escape = (value) => String(value).replace(/[&<>"']/g, (ch) => `&#${/** @type {string} */ (ch).charCodeAt(0)};`);

/** @param {string} code */
const block = (code) => `<pre><code>${escape(code)}</code></pre>`;

/** @param {string} text */
const para = (text) => `<p>${escape(text)}</p>`;

/** @typedef {{ 'x-ss-auth'?: string, 'x-ss-feature'?: string | string[], 'x-ss-permission'?: string, summary?: string }} Operation */

/** Every documented operation: `[method, path, operation]`. */
const operations = () =>
	Object.entries(/** @type {Record<string, Record<string, Operation>>} */ (/** @type {unknown} */ (openapi.paths))).flatMap(
		([path, methods]) =>
			Object.entries(methods).map(([method, operation]) => /** @type {const} */ ([method.toUpperCase(), path, operation])),
	);

/** @param {Operation} operation */
const featuresOf = (operation) => [operation['x-ss-feature'] ?? []].flat();

/** @param {ReturnType<typeof operations>} rows */
const routeTable = (rows) =>
	`<table><thead><tr><th>Route</th><th>Auth</th><th>Feature</th></tr></thead><tbody>${rows
		.map(
			([method, path, operation]) =>
				`<tr><td><code>${escape(`${method} ${path}`)}</code>${operation.summary ? ` ${escape(operation.summary)}` : ''}</td><td>${escape(
					`${operation['x-ss-auth'] ?? ''}${operation['x-ss-permission'] ? ` (${operation['x-ss-permission']})` : ''}`,
				)}</td><td>${escape(featuresOf(operation).length > 0 ? featuresOf(operation).join(' or ') : 'always')}</td></tr>`,
		)
		.join('')}</tbody></table>`;

/**
 * The docs page.
 * @param {{ base: string }} input Chat's address (snippets point at it)
 * @returns {string}
 */
export const renderDocs = ({ base }) => {
	const snippets = createSnippets({
		base,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
	});
	const rows = operations();
	const featureSections = manifest.features.map((feature) => {
		const widgets = manifest.widgets.filter((widget) => [widget.feature].flat().includes(feature.key));
		return [
			`<section id="feature-${escape(feature.key)}"><h3>${escape(feature.name)}</h3>`,
			para(feature.description),
			widgets.length > 0
				? `<ul>${widgets.map((widget) => `<li>${escape(widget.kind)} widget <code>${escape(`${WIDGET_ATTRIBUTE}="${widget.key}"`)}</code></li>`).join('')}</ul>`
				: '',
			routeTable(rows.filter(([, , operation]) => featuresOf(operation).includes(feature.key))),
			'</section>',
		].join('');
	});
	const templates = Object.entries(MESSAGE_TEMPLATES)
		.map(
			([key, values]) =>
				`<li><code>${escape(key)}</code>: ${values.map((value) => `<code>{${escape(value)}}</code>`).join(', ')}</li>`,
		)
		.join('');
	const shop = [
		...SHOP_ENDPOINTS.map(
			(row) => `<li><code>${escape(row.tool)}</code> (${escape(row.feature)}): <code>${escape(row.request)}</code></li>`,
		),
		`<li>context panel (${escape(CONTEXT_ENDPOINT.feature)}): <code>${escape(CONTEXT_ENDPOINT.request)}</code></li>`,
	].join('');
	const answers = Object.entries(SHOP_ANSWERS)
		.map(([name, fields]) => `<li>${escape(name)}: ${escape(fields)}</li>`)
		.join('');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(guide.title)}</title>
<style>
body { font: 16px/1.6 system-ui, sans-serif; max-width: 860px; margin: 0 auto; padding: 24px 16px; color: CanvasText; background: Canvas; }
pre { overflow-x: auto; padding: 12px; border: 1px solid GrayText; border-radius: 8px; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid GrayText; }
</style>
</head>
<body>
<h1>${escape(guide.title)}</h1>
${para(guide.intro)}
<p><strong>Local testing.</strong> ${escape(guide.localhost)}</p>
<h2>Install the widget</h2>
${para(guide.install)}
${block(snippets.visitor)}
<h2>Your own chat screens (visitor API)</h2>
${para(guide.visitorApi)}
<h2>Guests and signed-in visitors</h2>
${para(guide.guests)}
${para(guide.signedIn)}
<h2>AI</h2>
${para(guide.ai)}
${para(guide.knowledge)}
<h2>Webhook tools and booking</h2>
${para(guide.tools)}
${block(snippets.toolCheck)}
${para(guide.booking)}
<h2>Handoff and flows</h2>
${para(guide.handoff)}
${para(guide.flows)}
<h2>Staff alerts, transcripts and cost alerts</h2>
${para(guide.alerts)}
<ul>${templates}</ul>
<h2>Attachments</h2>
${para(guide.attachments)}
<h2>Data rights and the activity log</h2>
${para(guide.dataRights)}
${para(guide.activity)}
<h2>Shop tools (with Ecommerce)</h2>
${para(guide.shop)}
<ul>${shop}</ul>
<ul>${answers}</ul>
${para(guide.cards)}
${para(guide.contextPanel)}
<h2>Features</h2>
${featureSections.join('\n')}
<h2>Admin widgets and tickets</h2>
${para(guide.admin)}
${block(snippets.admin)}
${para(guide.tickets)}
${block(snippets.ticketNode)}
${block(snippets.ticketCurl)}
<h2>business.json</h2>
${para(guide.business)}
${block(JSON.stringify(BUSINESS_JSON_TEMPLATE, null, 2))}
<h2>API reference</h2>
${para(guide.api)}
${routeTable(rows)}
</body>
</html>
`;
};
