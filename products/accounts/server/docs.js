/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.6): sign-in methods and the Notifications templates they use, social
 * sign-in return addresses, sign-ins and their offline verification (public keys, Node.js and jose snippets), the
 * visitor API, roles and permissions, sign-up rules and security, data rights, activity-log copies, the Orders tab,
 * per-feature routes and widgets, the widget snippets, the ticket server snippet (Node.js fetch and cURL), the kit's
 * routes for your server (settings, acting user, visitor calls, counts, activity, Format; PLAN 0.8.10), the
 * business.json template, the localhost note and the API reference from `openapi.json`. Plain HTML; every value is
 * escaped.
 * @module
 */
import { KIT_GUIDE } from '@ss/app-kit';
import { BUSINESS_JSON_TEMPLATE } from '@ss/contracts';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
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
 * @param {{ base: string }} input Accounts' address (snippets point at it)
 * @returns {string}
 */
export const renderDocs = ({ base }) => {
	const features = /** @type {Record<string, string[]>} */ (/** @type {unknown} */ (guide.features));
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
			...(features[feature.key] ?? []).map(para),
			`<ul>${widgets.map((widget) => `<li>${escape(widget.kind)} widget <code>${escape(`${WIDGET_ATTRIBUTE}="${widget.key}"`)}</code></li>`).join('')}</ul>`,
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
<h2>Sign-in methods</h2>
${para(guide.methods)}
<ul>${templates}</ul>
<h2>Google, Apple and Facebook</h2>
${para(guide.social)}
${block(snippets.returnAddresses)}
<h2>Sign-ins and offline verification</h2>
${para(guide.signIns)}
${block(snippets.keysUrl)}
${block(snippets.verify)}
${block(snippets.verifyJose)}
<h2>Your own screens (visitor API)</h2>
${para(guide.visitorApi)}
${block(snippets.signedInCall)}
<h2>Roles and permissions</h2>
${para(guide.roles)}
<h2>Sign-up rules and security</h2>
${para(guide.rules)}
<h2>Data rights</h2>
${para(guide.dataRights)}
<h2>Activity log copy</h2>
${para(guide.activity)}
<h2>Orders tab</h2>
${para(guide.orders)}
<h2>Features</h2>
${featureSections.join('\n')}
<h2>Install the widgets</h2>
${para(guide.install)}
${block(snippets.visitor)}
<h2>Admin widgets and tickets</h2>
${para(guide.admin)}
${block(snippets.admin)}
${para(guide.tickets)}
${block(snippets.ticketNode)}
${block(snippets.ticketCurl)}
${KIT_GUIDE.map((section) => `<h2 id="${escape(section.id)}">${escape(section.title)}</h2>\n${section.paragraphs.map(para).join('\n')}`).join('\n')}
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
