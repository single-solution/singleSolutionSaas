/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.8): the widgets with their data attributes, the JS API, the
 * add-to-cart event and the browser events for Growth (PLAN 0.8.9), guests, order keys and the Accounts sign-in,
 * paying through Payments (or by a transfer staff record) and the success page, the order flow and its roles, the
 * order messages with the values the code sends (`server/order-messages.js`, `server/service.js`), couriers (tracking
 * links and the courier API adapter), the storage CORS rule, what the merchant's site serves from the API (the sitemap
 * index and its files, feeds, llms.txt and llms-full.txt, the product page with its 308 for moved addresses, listing
 * pages, policies), Catalog and SEO (PLAN 0.8.10 E1–E17) and Checkout, orders and promotions (E18–E36, E51–E79), each
 * addition with its routes and their features (and the Atlas Search index definition), the events of `GET /v1/events`,
 * staff alerts with their values (`server/staff-alerts.js`), the import, the Chat lookups, the Accounts Orders lookup,
 * data rights, per-feature guides with their routes, widgets and what the website builds (the guide's `build`, also
 * in the website's Setup sheet), the admin widgets and the ticket snippet (Node.js and cURL), the kit's routes for
 * your server (settings and lists, the acting user, visitor calls, counts, activity, Format; PLAN 0.8.10), the
 * business.json template, the localhost note and the API reference from `openapi.json`: every call with its auth,
 * feature, parameters, request fields and answer fields (`renderApiReference`, from `schemas/api.json` and the kit's
 * own descriptions), which every route the page names links to. Plain HTML; every value is escaped.
 * @module
 */
import { KIT_GUIDE, apiAnchor, renderApiReference } from '@ss/app-kit';
import { BUSINESS_JSON_TEMPLATE } from '@ss/contracts';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { DEFAULT_FLOW } from '../core/flow.js';
import { SEARCH_INDEX_DEFINITION } from '../core/search.js';
import { SITE_ROUTES, WIDGET_ATTRIBUTES, createSnippets } from '../core/snippets.js';
import { ADD_TO_CART_EVENT, WIDGET_ATTRIBUTE } from '../core/widgets.js';
import { manifest } from '../adapters/product.js';
import { ORDER_MESSAGE_VALUES, ORDER_TEMPLATES } from './order-messages.js';
import { BUSINESS_VALUE } from './service.js';
import { STAFF_ALERT_EVENTS, STAFF_ALERT_LINK, STAFF_ALERT_PHONE, STAFF_ALERT_VALUES } from './staff-alerts.js';

/** The API reference, rendered on the first docs request (it is the same for every request). @type {string | null} */
let reference = null;

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
				`<tr><td><a href="#${escape(apiAnchor(method, path))}"><code>${escape(`${method} ${path}`)}</code></a>${operation.summary ? ` ${escape(operation.summary)}` : ''}</td><td>${escape(
					`${operation['x-ss-auth'] ?? ''}${operation['x-ss-permission'] ? ` (${operation['x-ss-permission']})` : ''}`,
				)}</td><td>${escape(featuresOf(operation).length > 0 ? featuresOf(operation).join(' or ') : 'always')}</td></tr>`,
		)
		.join('')}</tbody></table>`;

/**
 * The operation of `openapi.json` a guide route names (`POST /v1/orders/:id/move`, `GET /v1/reports/sales?by=grade` …):
 * its `[method, path]`, the one with the most fixed parts when several match, else null.
 * @param {string} route
 * @param {Rows} rows
 * @returns {readonly [string, string] | null}
 */
export const operationOf = (route, rows) => {
	const [method = '', target = ''] = route.split(' ');
	const parts = target.replace(/\?.*$/, '').split('/');
	/** @type {{ at: readonly [string, string], fixed: number } | null} */
	let best = null;
	for (const [opMethod, path] of rows) {
		const own = path.split('/');
		if (opMethod !== method || own.length !== parts.length) continue;
		let fixed = 0;
		const fits = own.every((part, at) => {
			if (part.startsWith('{')) return true;
			fixed += 1;
			return part === parts[at];
		});
		if (fits && (!best || fixed > best.fixed)) best = { at: [opMethod, path], fixed };
	}
	return best?.at ?? null;
};

/**
 * A section of a guide group (Catalog and SEO, PLAN 0.8.10 E1–E17; Checkout, orders and promotions, E18–E36 and
 * E51–E79; Import): paragraphs (or a named code block in their flow) and the routes it uses, each with the feature it
 * needs.
 * @typedef {{ id: string, title: string, paragraphs: Array<string | { code: string }>, routes: Array<[string, string]> }} GuideSection
 */
/** @typedef {{ intro: string, sections: GuideSection[] }} GuideGroup */

/**
 * The docs page.
 * @param {{ base: string, paths?: unknown }} input Ecommerce's address (snippets point at it); `paths` replaces the
 *   operations of `openapi.json` (tests)
 * @returns {string}
 */
export const renderDocs = ({ base, paths = openapi.paths }) => {
	const features = /** @type {Record<string, string[]>} */ (guide.features);
	const build = /** @type {Record<string, string>} */ (guide.build);
	const widgetHelp = /** @type {Record<string, string>} */ (guide.widgets);
	const roles = /** @type {Record<string, string>} */ (guide.roles);
	const siteHelp = /** @type {Record<string, string>} */ (guide.siteRoutes);
	const permissions = manifest.permissions.map((permission) => permission.key);
	const snippets = createSnippets({ base, widgets: manifest.widgets, permissions });
	const rows = operations(paths);
	const nameOf = new Map(manifest.features.map((feature) => [feature.key, feature.name]));
	/** Code blocks a guide section names. @type {Record<string, string>} */
	const codes = { searchIndex: JSON.stringify(SEARCH_INDEX_DEFINITION, null, 2) };

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
			build[feature.key] ? `<p><strong>What your website builds.</strong> ${escape(build[feature.key])}</p>` : '',
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
	/**
	 * Template values with what each one holds.
	 * @param {ReadonlyArray<string>} keys @param {Record<string, string>} help
	 */
	const valueList = (keys, help) => list(keys.map((key) => `<code>{${escape(key)}}</code>: ${escape(help[key] ?? '')}`));
	const messageHelp = /** @type {Record<string, string>} */ (guide.messageValues);
	const orderTemplates = list(
		[
			[ORDER_TEMPLATES.placed, guide.orderTemplates.placed],
			[ORDER_TEMPLATES.status, guide.orderTemplates.status],
			[`${ORDER_TEMPLATES.status}.<status key>`, guide.orderTemplates.perStatus],
		].map(([key, help]) => `<code>${escape(key)}</code>: ${escape(help)}`),
	);
	const otherTemplates = list(
		Object.entries(/** @type {Record<string, string[]>} */ (guide.templates)).map(
			([key, values]) =>
				`<code>${escape(key)}</code>: ${[...values, BUSINESS_VALUE].map((value) => `<code>{${escape(value)}}</code>`).join(', ')}`,
		),
	);
	const staffHelp = /** @type {Record<string, string>} */ (guide.staffValues);
	const staffEvents = list(
		Object.entries(STAFF_ALERT_EVENTS).map(
			([event, extra]) =>
				`<code>ecommerce.staff_${escape(event)}</code> (<code>${escape(event)}</code>): ${escape(
					/** @type {Record<string, string>} */ (guide.staffEvents)[event] ?? '',
				)}${extra.length > 0 ? ` Also ${extra.map((key) => `<code>{${escape(key)}}</code>`).join(', ')}.` : ''}`,
		),
	);
	const eventTypes = list(
		Object.entries(/** @type {Record<string, string>} */ (guide.eventTypes)).map(
			([type, help]) => `<code>${escape(`${manifest.id}.${type}`)}</code>: ${escape(help)}`,
		),
	);
	const site = SITE_ROUTES.map(
		(entry) =>
			`<h3><code>${escape(`GET ${entry.route}`)}</code></h3>${para(siteHelp[entry.name] ?? '')}${block(
				/** @type {string} */ (snippets.site[entry.name]),
			)}`,
	).join('\n');
	const known = operations(openapi.paths);
	/**
	 * A guide group's sections, each route linked to its place in the API reference.
	 * @param {GuideGroup} group
	 */
	const groupSections = (group) =>
		group.sections.map((section) =>
			[
				`<section id="${escape(section.id)}"><h3>${escape(section.title)}</h3>`,
				...section.paragraphs.map((part) => (typeof part === 'string' ? para(part) : block(codes[part.code] ?? ''))),
				list(
					section.routes.map(([route, feature]) => {
						const found = operationOf(route, known);
						const code = `<code>${escape(route)}</code>`;
						return `${found ? `<a href="#${escape(apiAnchor(...found))}">${code}</a>` : code} (${escape(nameOf.get(feature) ?? feature)}, <code>${escape(feature)}</code>)`;
					}),
				),
				'</section>',
			].join(''),
		);
	const catalogSeo = /** @type {GuideGroup} */ (guide.catalogSeo);
	const shop = /** @type {GuideGroup} */ (guide.orders);
	const imports = /** @type {GuideGroup} */ (guide.import);
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
.ss-api-op { margin-top: 32px; } .ss-api-op h3 code, .ss-api-schema h4 { overflow-wrap: anywhere; }
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
<h2 id="sign-in">Guests, order keys and the Accounts sign-in</h2>
${para(guide.signIn)}
<h2 id="payments">Checkout and payments</h2>
${para(guide.payments)}
${para(guide.success)}
<h2 id="order-flow">Order statuses and roles</h2>
${para(guide.orderFlow)}
${flowStatuses}
${para(guide.orderRoles)}
${roleList}
<h2 id="messages">Order messages and alerts</h2>
${para(guide.messages)}
${orderTemplates}
${para(guide.orderValuesIntro)}
${valueList([...ORDER_MESSAGE_VALUES, BUSINESS_VALUE], messageHelp)}
${para(guide.otherTemplates)}
${otherTemplates}
<h2 id="staff-alerts">Staff alerts</h2>
${para(guide.staffAlerts)}
${staffEvents}
${para(guide.staffValuesIntro)}
${valueList([...STAFF_ALERT_VALUES, ...new Set(Object.values(STAFF_ALERT_EVENTS).flat()), STAFF_ALERT_LINK, STAFF_ALERT_PHONE], staffHelp)}
<h2 id="events">Events and webhooks</h2>
${para(guide.events)}
${eventTypes}
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
<h3><code>GET /v1/seo/site</code></h3>
${para(guide.homePage)}
${block(snippets.homePage)}
<h3><code>GET /v1/seo/products/:ref</code></h3>
${para(guide.productMeta)}
${block(snippets.productMeta)}
<h3><code>GET /v1/seo/listing</code></h3>
${para(guide.listing)}
${block(snippets.listingPage)}
<h3><code>GET /v1/policies</code></h3>
${para(guide.policies)}
${block(snippets.policies)}
<h2 id="catalog-seo">Catalog and SEO</h2>
${para(catalogSeo.intro)}
${groupSections(catalogSeo).join('\n')}
<h2 id="orders-guide">Checkout, orders and promotions</h2>
${para(shop.intro)}
${groupSections(shop).join('\n')}
<h2 id="import">Import</h2>
${para(imports.intro)}
${groupSections(imports).join('\n')}
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
${(reference ??= renderApiReference(openapi))}
</body>
</html>
`;
};
