/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.7): the payment API, confirming a payment for its exact amount,
 * payment events through Notifications and the webhook signature check, each gateway's setup with the addresses to
 * register, currencies, manual payment methods, links, refunds, subscriptions, per-feature routes, widgets and what the website
 * builds, the widget and ticket snippets, the kit's routes for your server (settings, acting user, visitor calls,
 * counts, activity, Format; PLAN 0.8.10), the business.json template, the localhost note and the API reference from `openapi.json`: every call
 * with its auth, feature, parameters, request fields and answer fields (`renderApiReference`, from `schemas/api.json`
 * and the kit's own descriptions). Plain HTML; every value is escaped.
 * @module
 */
import { KIT_GUIDE, apiAnchor, renderApiReference } from '@ss/app-kit';
import { BUSINESS_JSON_TEMPLATE } from '@ss/contracts';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { GATEWAYS, GATEWAY_CURRENCIES, GATEWAY_FEATURES } from '../core/gateways.js';
import { createSnippets, gatewayAddresses } from '../core/snippets.js';
import { WIDGET_ATTRIBUTE } from '../core/widgets.js';
import { manifest } from '../adapters/product.js';

/** The API reference, rendered on the first docs request (it is the same for every request). @type {string | null} */
let reference = null;

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
				`<tr><td><a href="#${escape(apiAnchor(method, path))}"><code>${escape(`${method} ${path}`)}</code></a>${operation.summary ? ` ${escape(operation.summary)}` : ''}</td><td>${escape(
					`${operation['x-ss-auth'] ?? ''}${operation['x-ss-permission'] ? ` (${operation['x-ss-permission']})` : ''}`,
				)}</td><td>${escape(featuresOf(operation).join(', ') || 'always')}</td></tr>`,
		)
		.join('')}</tbody></table>`;

/**
 * The docs page.
 * @param {{ base: string, addresses: Readonly<Record<string, ReadonlyArray<'notice' | 'return'>>> }} input the
 *   product's address (snippets point at it) and what each gateway's adapter says to register in its console (P12)
 * @returns {string}
 */
export const renderDocs = ({ base, addresses }) => {
	const build = /** @type {Record<string, string>} */ (guide.build);
	const snippets = createSnippets({
		base,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
	});
	const urls = new Map(gatewayAddresses(base, undefined, addresses).map((entry) => [entry.gateway, entry.urls]));
	const names = new Map(manifest.features.map((feature) => [feature.key, feature.name]));
	// each gateway by its dashboard name, with its guide and the addresses its adapter declares
	const gatewaySections = GATEWAYS.map((gateway) =>
		[
			`<h3>${escape(names.get(GATEWAY_FEATURES[gateway]) ?? gateway)}</h3>`,
			para(
				/** @type {Record<string, unknown>} */ (guide)[gateway] === undefined
					? ''
					: String(/** @type {Record<string, unknown>} */ (guide)[gateway]),
			),
			...(urls.has(gateway) ? [block(/** @type {string[]} */ (urls.get(gateway)).join('\n'))] : []),
		].join('\n'),
	).join('\n');
	const rows = operations();
	const featureSections = manifest.features.map((feature) => {
		const widgets = manifest.widgets.filter((widget) => [widget.feature].flat().includes(feature.key));
		const routes = rows.filter(([, , operation]) => featuresOf(operation).includes(feature.key));
		return [
			`<section id="feature-${escape(feature.key)}"><h3>${escape(feature.name)}</h3>`,
			para(feature.description),
			...(build[feature.key] ? [`<p><strong>What your website builds.</strong> ${escape(build[feature.key])}</p>`] : []),
			widgets.length > 0
				? `<ul>${widgets.map((widget) => `<li>${escape(widget.kind)} widget <code>${escape(`${WIDGET_ATTRIBUTE}="${widget.key}"`)}</code></li>`).join('')}</ul>`
				: '',
			routes.length > 0 ? routeTable(routes) : '',
			'</section>',
		].join('');
	});
	const currencies = Object.entries(GATEWAY_CURRENCIES)
		.map(([gateway, list]) => `${gateway}: ${list === null ? 'any' : list.join(', ')}`)
		.join('\n');
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
.ss-api-op { margin-top: 32px; } .ss-api-op h3 code, .ss-api-schema h4 { overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>${escape(guide.title)}</h1>
${para(guide.intro)}
<p><strong>Local testing.</strong> ${escape(guide.localhost)}</p>
<h2>Create a payment</h2>
${para(guide.payments)}
${block(snippets.create)}
<h2>Confirm a payment</h2>
${para(guide.confirm)}
${block(snippets.verify)}
<h2>Payment events and webhooks</h2>
${para(guide.events)}
${block(snippets.webhook)}
<h2>Gateways</h2>
${para(guide.gateways)}
${gatewaySections}
<h3>Manual payment methods</h3>
${para(guide.bank)}
${block(snippets.methods)}
<h2>Currencies</h2>
${para(guide.currencies)}
${block(currencies)}
<h2>Payment links and the pay button</h2>
${para(guide.links)}
${block(snippets.link)}
<h2>Refunds</h2>
${para(guide.refunds)}
${block(snippets.refund)}
<h2>Subscriptions</h2>
${para(guide.subscriptions)}
${block(snippets.subscription)}
<h2>Features</h2>
${featureSections.join('\n')}
<h2>Install the pay button</h2>
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
${(reference ??= renderApiReference(openapi))}
</body>
</html>
`;
};
