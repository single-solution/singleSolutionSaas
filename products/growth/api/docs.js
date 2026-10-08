/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.9): the page script, consent and Google Consent Mode, privacy and
 * storage, the shop events, searches, 404s and Web Vitals, robots.txt and verification, IndexNow, the SEO checklist,
 * the notice bar, per-feature routes and widgets, the widget and ticket snippets, the business.json template, the
 * localhost note and the API reference from `openapi.json`. Plain HTML; every value is escaped.
 * @module
 */
import { BUSINESS_JSON_TEMPLATE } from '@ss/contracts';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { createSnippets } from '../core/snippets.js';
import { WIDGET_ATTRIBUTE } from '../core/widgets.js';
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
				)}</td><td>${escape(featuresOf(operation).join(', ') || 'always')}</td></tr>`,
		)
		.join('')}</tbody></table>`;

/**
 * The docs page.
 * @param {{ base: string }} input the product's address (snippets point at it)
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
			...(feature.dependsOn.length > 0 ? [para(`Needs: ${feature.dependsOn.join(', ')}`)] : []),
			...(features[feature.key] ?? []).map(para),
			`<ul>${widgets.map((widget) => `<li>${escape(widget.kind)} widget <code>${escape(`${WIDGET_ATTRIBUTE}="${widget.key}"`)}</code></li>`).join('')}</ul>`,
			routeTable(rows.filter(([, , operation]) => featuresOf(operation).includes(feature.key))),
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
<h2>The page script</h2>
${para(guide.script)}
${block(snippets.pageScript)}
<h2>Consent and Google Consent Mode v2</h2>
${para(guide.consent)}
${block(snippets.consent)}
<h2>Privacy</h2>
${para(guide.privacy)}
<h2>Where the data goes</h2>
${para(guide.storage)}
${block(snippets.analytics)}
<h2>Shop events</h2>
${para(guide.events)}
${block(snippets.events)}
<h2>Searches, 404s and Web Vitals</h2>
${para(guide.page)}
${block(snippets.page)}
<h2>robots.txt and verification tags</h2>
${para(guide.seo)}
${block(snippets.robots)}
<h2>IndexNow</h2>
${para(guide.indexnow)}
${block(snippets.indexNow)}
<h2>SEO checklist</h2>
${para(guide.checklist)}
${block(snippets.seo)}
<h2>Notice bar</h2>
${para(guide.notice)}
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
