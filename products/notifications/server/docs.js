/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.5): the send API and template keys, retries and fallback, timing,
 * languages, providers (with the gateway example for Connectivity.pk), unsubscribe keywords, browser and staff push
 * (with the service worker), the webhook signature check, per-feature routes and widgets, the widget snippets, the
 * ticket server snippet (Node.js fetch and cURL), the business.json template, the localhost note and the API
 * reference from `openapi.json`. Plain HTML; every value is escaped.
 * @module
 */
import { BUSINESS_JSON_TEMPLATE } from '@ss/contracts';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { createSnippets } from '../core/snippets.js';
import { SERVICE_WORKER_PATH, SERVICE_WORKER_SOURCE, WIDGET_ATTRIBUTE } from '../core/widgets.js';
import { SIGNATURE_HEADER, WEBHOOK_EVENTS } from '../core/webhooks.js';
import { manifest } from '../adapters/product.js';

/** @param {unknown} value */
const escape = (value) => String(value).replace(/[&<>"']/g, (ch) => `&#${/** @type {string} */ (ch).charCodeAt(0)};`);

/** @param {string} code */
const block = (code) => `<pre><code>${escape(code)}</code></pre>`;

/** @param {string} text */
const para = (text) => `<p>${escape(text)}</p>`;

/** @typedef {{ 'x-ss-auth'?: string, 'x-ss-feature'?: string, 'x-ss-permission'?: string, summary?: string }} Operation */

/** Every documented operation: `[method, path, operation]`. */
const operations = () =>
	Object.entries(/** @type {Record<string, Record<string, Operation>>} */ (/** @type {unknown} */ (openapi.paths))).flatMap(
		([path, methods]) =>
			Object.entries(methods).map(([method, operation]) => /** @type {const} */ ([method.toUpperCase(), path, operation])),
	);

/** @param {ReturnType<typeof operations>} rows */
const routeTable = (rows) =>
	`<table><thead><tr><th>Route</th><th>Auth</th><th>Feature</th></tr></thead><tbody>${rows
		.map(
			([method, path, operation]) =>
				`<tr><td><code>${escape(`${method} ${path}`)}</code>${operation.summary ? ` ${escape(operation.summary)}` : ''}</td><td>${escape(
					`${operation['x-ss-auth'] ?? ''}${operation['x-ss-permission'] ? ` (${operation['x-ss-permission']})` : ''}`,
				)}</td><td>${escape(operation['x-ss-feature'] ?? 'always')}</td></tr>`,
		)
		.join('')}</tbody></table>`;

/**
 * The docs page.
 * @param {{ base: string }} input the product's address (snippets point at it)
 * @returns {string}
 */
export const renderDocs = ({ base }) => {
	const features = /** @type {Record<string, string[]>} */ (/** @type {unknown} */ (guide.features));
	const {
		visitor: visitorSnippet,
		admin: adminSnippet,
		ticketNode: nodeSnippet,
		ticketCurl: curlSnippet,
		send: sendSnippet,
		sendCurl,
		push: pushSnippet,
		webhook: webhookSnippet,
		inbound,
	} = createSnippets({
		base,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
	});
	const rows = operations();
	const featureSections = manifest.features.map((feature) => {
		const widgets = manifest.widgets.filter((widget) => widget.feature === feature.key);
		return [
			`<section id="feature-${escape(feature.key)}"><h3>${escape(feature.name)}</h3>`,
			para(feature.description),
			...(features[feature.key] ?? []).map(para),
			`<ul>${widgets.map((widget) => `<li>${escape(widget.kind)} widget <code>${escape(`${WIDGET_ATTRIBUTE}="${widget.key}"`)}</code></li>`).join('')}</ul>`,
			routeTable(rows.filter(([, , operation]) => operation['x-ss-feature'] === feature.key)),
			'</section>',
		].join('');
	});
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
<h2>Send a message</h2>
${para(guide.send)}
${block(sendSnippet)}
${block(sendCurl)}
<h2>Templates and template keys</h2>
${para(guide.templates)}
<h2>Retries and fallback</h2>
${para(guide.retries)}
<h2>Quiet hours, send limits and delayed send</h2>
${para(guide.timing)}
<h2>Languages</h2>
${para(guide.languages)}
<h2>Providers</h2>
${para(guide.providers)}
<h2>Unsubscribe keywords</h2>
${para(guide.keywords)}
${block(inbound)}
<h2>Browser and staff push</h2>
${para(guide.push)}
${block(`${SERVICE_WORKER_PATH}\n\n${SERVICE_WORKER_SOURCE}`)}
${block(pushSnippet)}
<h2>Outgoing webhooks</h2>
${para(guide.webhooks)}
${para(`Events: ${WEBHOOK_EVENTS.join(', ')}. Header: ${SIGNATURE_HEADER}.`)}
${block(webhookSnippet)}
<h2>Features</h2>
${featureSections.join('\n')}
<h2>Install the widgets</h2>
${para(guide.install)}
${block(visitorSnippet)}
<h2>Admin widgets and tickets</h2>
${para(guide.admin)}
${block(adminSnippet)}
${para(guide.tickets)}
${block(nodeSnippet)}
${block(curlSnippet)}
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
