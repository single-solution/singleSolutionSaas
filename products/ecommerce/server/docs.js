/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.8): the widgets with their data attributes, the JS API, the
 * add-to-cart event and the browser events for Growth (PLAN 0.8.9), the Accounts sign-in checkout needs, paying
 * through Payments and the success page, the order flow and its roles, the Notifications templates, couriers (tracking
 * links and the courier API adapter), the storage CORS rule, what the merchant's site serves from the API (sitemap,
 * product meta, feeds, llms.txt, policies), the Chat lookups, the Accounts Orders lookup, data rights, per-feature
 * guides with their routes and widgets, the admin widgets and the ticket snippet (Node.js and cURL), the kit's routes
 * for your server (settings and lists, the acting user, visitor calls, counts, activity, Format; PLAN 0.8.10), the
 * business.json template, the localhost note and the API reference from `openapi.json`. Plain HTML; every value is
 * escaped.
 * @module
 */
import { KIT_GUIDE } from '@ss/app-kit';
import { BUSINESS_JSON_TEMPLATE } from '@ss/contracts';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { DEFAULT_FLOW } from '../core/flow.js';
import { SITE_ROUTES, WIDGET_ATTRIBUTES, createSnippets } from '../core/snippets.js';
import { ADD_TO_CART_EVENT, WIDGET_ATTRIBUTE } from '../core/widgets.js';
import { manifest } from '../adapters/product.js';

/** @param {unknown} value */
export const escape = (value) => String(value).replace(/[&<>"']/g, (ch) => `&#${/** @type {string} */ (ch).charCodeAt(0)};`);

/** @param {string} code */
const block = (code) => `<pre><code>${escape(code)}</code></pre>`;

/** @param {string} text */
const para = (text) => `<p>${escape(text)}</p>`;

/** @param {string[]} items already escaped */
const list = (items) => (items.length > 0 ? `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>` : '');

/** @typedef {{ 'x-ss-auth'?: string, 'x-ss-feature'?: string | string[], 'x-ss-permission'?: string, summary?: string }} Operation */
/** @typedef {ReadonlyArray<readonly [string, string, Operation]>} Rows */

/**
 * Every documented operation: `[method, path, operation]`.
 * @param {unknown} paths `openapi.paths`
 * @returns {Rows}
 */
export const operations = (paths) =>
	Object.entries(/** @type {Record<string, Record<string, Operation>>} */ (paths ?? {})).flatMap(([path, methods]) =>
		Object.entries(methods).map(([method, operation]) => /** @type {const} */ ([method.toUpperCase(), path, operation])),
	);

/**
 * The features of an operation (`x-ss-feature` is one key or a list of which any is enough).
 * @param {Operation} operation
 * @returns {string[]}
 */
export const featuresOf = (operation) => [operation['x-ss-feature'] ?? []].flat();

/** @param {Rows} rows */
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
 * @param {{ base: string, paths?: unknown }} input Ecommerce's address (snippets point at it); `paths` replaces the
 *   operations of `openapi.json` (tests)
 * @returns {string}
 */
export const renderDocs = ({ base, paths = openapi.paths }) => {
	const features = /** @type {Record<string, string[]>} */ (guide.features);
	const widgetHelp = /** @type {Record<string, string>} */ (guide.widgets);
	const roles = /** @type {Record<string, string>} */ (guide.roles);
	const siteHelp = /** @type {Record<string, string>} */ (guide.siteRoutes);
	const permissions = manifest.permissions.map((permission) => permission.key);
	const snippets = createSnippets({ base, widgets: manifest.widgets, permissions });
	const rows = operations(paths);
	const nameOf = new Map(manifest.features.map((feature) => [feature.key, feature.name]));

	const widgetRows = manifest.widgets.map((widget) => {
		const attributes = (WIDGET_ATTRIBUTES[widget.key] ?? []).map(
			(attribute) => `<code>${escape(attribute.name)}</code>: ${escape(attribute.help)}`,
		);
		return `<li><code>${escape(`${WIDGET_ATTRIBUTE}="${widget.key}"`)}</code> (${escape(widget.kind)}, ${escape(
			[widget.feature]
				.flat()
				.map((key) => nameOf.get(key) ?? key)
				.join(' or '),
		)}): ${escape(widgetHelp[widget.key] ?? '')}${list(attributes)}</li>`;
	});
	const featureSections = manifest.features.map((feature) => {
		const widgets = manifest.widgets.filter((widget) => [widget.feature].flat().includes(feature.key));
		const needs = feature.dependsOn.map((key) => nameOf.get(key) ?? key);
		return [
			`<section id="feature-${escape(feature.key)}"><h3>${escape(feature.name)} <code>${escape(feature.key)}</code></h3>`,
			para(feature.description),
			...(features[feature.key] ?? []).map(para),
			needs.length > 0 ? para(`Needs: ${needs.join(', ')}.`) : '',
			list(
				widgets.map(
					(widget) => `${escape(widget.kind)} widget <code>${escape(`${WIDGET_ATTRIBUTE}="${widget.key}"`)}</code>`,
				),
			),
			routeTable(rows.filter(([, , operation]) => featuresOf(operation).includes(feature.key))),
			'</section>',
		].join('');
	});
	const flowStatuses = list(
		DEFAULT_FLOW.statuses.map(
			(status) =>
				`<code>${escape(status.key)}</code> ${escape(status.label)} (role <code>${escape(status.role)}</code>): ${escape(
					DEFAULT_FLOW.moves
						.filter((move) => move.from === status.key)
						.map((move) => move.to)
						.join(', ') || 'final',
				)}`,
		),
	);
	const roleList = list(Object.entries(roles).map(([role, help]) => `<code>${escape(role)}</code>: ${escape(help)}`));
	const templates = list(
		Object.entries(/** @type {Record<string, string[]>} */ (guide.templates)).map(
			([key, values]) => `<code>${escape(key)}</code>: ${values.map((value) => `<code>{${escape(value)}}</code>`).join(', ')}`,
		),
	);
	const site = SITE_ROUTES.map(
		(entry) =>
			`<h3><code>${escape(`GET ${entry.route}`)}</code></h3>${para(siteHelp[entry.name] ?? '')}${block(
				/** @type {string} */ (snippets.site[entry.name]),
			)}`,
	).join('\n');
	const permissionList = list(
		manifest.permissions.map(
			(permission) =>
				`<code>${escape(permission.key)}</code>: ${escape(permission.name)} (${escape(nameOf.get(permission.feature) ?? permission.feature)})`,
		),
	);

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
td code { overflow-wrap: anywhere; }
</style>
</head>
<body>
<h1>${escape(guide.title)}</h1>
${para(guide.intro)}
<p><strong>Local testing.</strong> ${escape(guide.localhost)}</p>
<h2 id="install">Install the widgets</h2>
${para(guide.install)}
${block(snippets.visitor)}
${para(guide.attributes)}
${list(widgetRows)}
<h2 id="js-api">The JS API</h2>
${para(guide.jsApi)}
${block(snippets.api)}
<h3>The <code>${escape(ADD_TO_CART_EVENT)}</code> event</h3>
${para(guide.addToCart)}
${block(snippets.addToCartEvent)}
<h3>Events for Growth</h3>
${para(guide.growthEvents)}
<h2 id="sign-in">Shoppers sign in with Accounts</h2>
${para(guide.signIn)}
<h2 id="payments">Checkout and payments</h2>
${para(guide.payments)}
${para(guide.success)}
<h2 id="order-flow">Order statuses and roles</h2>
${para(guide.orderFlow)}
${flowStatuses}
${roleList}
<h2 id="messages">Order messages and alerts</h2>
${para(guide.messages)}
${templates}
<h2 id="couriers">Couriers</h2>
${para(guide.couriers)}
${para(guide.courierApi)}
${block(snippets.courier)}
<h2 id="storage">Storage and CORS</h2>
${para(guide.storage)}
${block(snippets.cors)}
<h2 id="site">Your site serves</h2>
${para(guide.site)}
${site}
<h3><code>GET /v1/seo/products/:ref</code></h3>
${para(guide.productMeta)}
${block(snippets.productMeta)}
<h3><code>GET /v1/policies</code></h3>
${para(guide.policies)}
${block(snippets.policies)}
<h2 id="chat">Chat lookups</h2>
${para(guide.chat)}
${list(guide.chatRoutes.map((route) => `<code>${escape(route)}</code>`))}
<h2 id="customers">Orders in Accounts</h2>
${para(guide.customers)}
${block(snippets.customerOrders)}
<h2 id="data-rights">Data rights and the activity log</h2>
${para(guide.dataRights)}
<h2 id="features">Features</h2>
${featureSections.join('\n')}
<h2 id="admin">Admin widgets and tickets</h2>
${para(guide.admin)}
${block(snippets.admin)}
${para(guide.tickets)}
${permissionList}
${block(snippets.ticketNode)}
${block(snippets.ticketCurl)}
${KIT_GUIDE.map((section) => `<h2 id="${escape(section.id)}">${escape(section.title)}</h2>\n${section.paragraphs.map(para).join('\n')}`).join('\n')}
${para(guide.kit)}
<h2 id="business">business.json</h2>
${para(guide.business)}
${block(JSON.stringify(BUSINESS_JSON_TEMPLATE, null, 2))}
<h2 id="api">API reference</h2>
${para(guide.api)}
${routeTable(rows)}
</body>
</html>
`;
};
