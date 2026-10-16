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
 * feature, parameters, request fields and answer fields, which every route the page names links to. The page, the
 * feature sections and the small HTML pieces are the kit's (`renderDocsPage`, `docsFeatureSections`); this file keeps
 * Ecommerce's own sections. Plain HTML; every value is escaped.
 * @module
 */
import { apiAnchor, docsBlock, docsFeatureSections, docsList, docsOperations, docsParagraph, renderDocsPage } from '@ss/app-kit';
import { escapeHtml } from '@ss/contracts/text';
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

/** The documented operations (the same for every request). */
const KNOWN = docsOperations(openapi);

/**
 * The operation of `openapi.json` a guide route names (`POST /v1/orders/:id/move`, `GET /v1/reports/sales?by=grade` …):
 * its `[method, path]`, the one with the most fixed parts when several match, else null.
 * @param {string} route
 * @param {ReadonlyArray<import('@ss/app-kit').DocsRow>} rows
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
 * @param {{ base: string, openapi?: unknown }} input Ecommerce's address (snippets point at it); `openapi` replaces
 *   `openapi.json` (tests)
 * @returns {string}
 */
export const renderDocs = ({ base, openapi: document = openapi }) => {
	const widgetHelp = /** @type {Record<string, string>} */ (guide.widgets);
	const roles = /** @type {Record<string, string>} */ (guide.roles);
	const siteHelp = /** @type {Record<string, string>} */ (guide.siteRoutes);
	const permissions = manifest.permissions.map((permission) => permission.key);
	const snippets = createSnippets({ base, widgets: manifest.widgets, permissions });
	const rows = docsOperations(document);
	const nameOf = new Map(manifest.features.map((feature) => [feature.key, feature.name]));
	/** Code blocks a guide section names. @type {Record<string, string>} */
	const codes = { searchIndex: JSON.stringify(SEARCH_INDEX_DEFINITION, null, 2) };

	const widgetRows = manifest.widgets.map((widget) => {
		const attributes = (WIDGET_ATTRIBUTES[widget.key] ?? []).map(
			(attribute) => `<code>${escapeHtml(attribute.name)}</code>: ${escapeHtml(attribute.help)}`,
		);
		return `<li><code>${escapeHtml(`${WIDGET_ATTRIBUTE}="${widget.key}"`)}</code> (${escapeHtml(widget.kind)}, ${escapeHtml(
			[widget.feature]
				.flat()
				.map((key) => nameOf.get(key) ?? key)
				.join(' or '),
		)}): ${escapeHtml(widgetHelp[widget.key] ?? '')}${docsList(attributes)}</li>`;
	});
	const flowStatuses = docsList(
		DEFAULT_FLOW.statuses.map(
			(status) =>
				`<code>${escapeHtml(status.key)}</code> ${escapeHtml(status.label)} (role <code>${escapeHtml(status.role)}</code>): ${escapeHtml(
					DEFAULT_FLOW.moves
						.filter((move) => move.from === status.key)
						.map((move) => move.to)
						.join(', ') || 'final',
				)}`,
		),
	);
	const roleList = docsList(
		Object.entries(roles).map(([role, help]) => `<code>${escapeHtml(role)}</code>: ${escapeHtml(help)}`),
	);
	/**
	 * Template values with what each one holds.
	 * @param {ReadonlyArray<string>} keys @param {Record<string, string>} help
	 */
	const valueList = (keys, help) =>
		docsList(keys.map((key) => `<code>{${escapeHtml(key)}}</code>: ${escapeHtml(help[key] ?? '')}`));
	const messageHelp = /** @type {Record<string, string>} */ (guide.messageValues);
	const orderTemplates = docsList(
		[
			[ORDER_TEMPLATES.placed, guide.orderTemplates.placed],
			[ORDER_TEMPLATES.status, guide.orderTemplates.status],
			[`${ORDER_TEMPLATES.status}.<status key>`, guide.orderTemplates.perStatus],
		].map(([key, help]) => `<code>${escapeHtml(key)}</code>: ${escapeHtml(help)}`),
	);
	const otherTemplates = docsList(
		Object.entries(/** @type {Record<string, string[]>} */ (guide.templates)).map(
			([key, values]) =>
				`<code>${escapeHtml(key)}</code>: ${[...values, BUSINESS_VALUE].map((value) => `<code>{${escapeHtml(value)}}</code>`).join(', ')}`,
		),
	);
	const staffHelp = /** @type {Record<string, string>} */ (guide.staffValues);
	const staffEvents = docsList(
		Object.entries(STAFF_ALERT_EVENTS).map(
			([event, extra]) =>
				`<code>ecommerce.staff_${escapeHtml(event)}</code> (<code>${escapeHtml(event)}</code>): ${escapeHtml(
					/** @type {Record<string, string>} */ (guide.staffEvents)[event] ?? '',
				)}${extra.length > 0 ? ` Also ${extra.map((key) => `<code>{${escapeHtml(key)}}</code>`).join(', ')}.` : ''}`,
		),
	);
	const eventTypes = docsList(
		Object.entries(/** @type {Record<string, string>} */ (guide.eventTypes)).map(
			([type, help]) => `<code>${escapeHtml(`${manifest.id}.${type}`)}</code>: ${escapeHtml(help)}`,
		),
	);
	const site = SITE_ROUTES.map(
		(entry) =>
			`<h3><code>${escapeHtml(`GET ${entry.route}`)}</code></h3>${docsParagraph(siteHelp[entry.name] ?? '')}${docsBlock(
				/** @type {string} */ (snippets.site[entry.name]),
			)}`,
	).join('\n');
	/**
	 * A guide group's sections, each route linked to its place in the API reference.
	 * @param {GuideGroup} group
	 */
	const groupSections = (group) =>
		group.sections.map((section) =>
			[
				`<section id="${escapeHtml(section.id)}"><h3>${escapeHtml(section.title)}</h3>`,
				...section.paragraphs.map((part) =>
					typeof part === 'string' ? docsParagraph(part) : docsBlock(codes[part.code] ?? ''),
				),
				docsList(
					section.routes.map(([route, feature]) => {
						const found = operationOf(route, KNOWN);
						const code = `<code>${escapeHtml(route)}</code>`;
						return `${found ? `<a href="#${escapeHtml(apiAnchor(...found))}">${code}</a>` : code} (${escapeHtml(nameOf.get(feature) ?? feature)}, <code>${escapeHtml(feature)}</code>)`;
					}),
				),
				'</section>',
			].join(''),
		);
	const catalogSeo = /** @type {GuideGroup} */ (guide.catalogSeo);
	const shop = /** @type {GuideGroup} */ (guide.orders);
	const imports = /** @type {GuideGroup} */ (guide.import);
	const permissionList = docsList(
		manifest.permissions.map(
			(permission) =>
				`<code>${escapeHtml(permission.key)}</code>: ${escapeHtml(permission.name)} (${escapeHtml(nameOf.get(permission.feature) ?? permission.feature)})`,
		),
	);

	return renderDocsPage({
		guide,
		openapi: document,
		body: `<h2 id="install">Install the widgets</h2>
${docsParagraph(guide.install)}
${docsBlock(snippets.visitor)}
${docsParagraph(guide.attributes)}
${docsList(widgetRows)}
<h2 id="js-api">The JS API</h2>
${docsParagraph(guide.jsApi)}
${docsBlock(snippets.api)}
<h3>The <code>${escapeHtml(ADD_TO_CART_EVENT)}</code> event</h3>
${docsParagraph(guide.addToCart)}
${docsBlock(snippets.addToCartEvent)}
<h3>Events for Growth</h3>
${docsParagraph(guide.growthEvents)}
<h2 id="sign-in">Guests, order keys and the Accounts sign-in</h2>
${docsParagraph(guide.signIn)}
<h2 id="payments">Checkout and payments</h2>
${docsParagraph(guide.payments)}
${docsParagraph(guide.success)}
<h2 id="order-flow">Order statuses and roles</h2>
${docsParagraph(guide.orderFlow)}
${flowStatuses}
${docsParagraph(guide.orderRoles)}
${roleList}
<h2 id="messages">Order messages and alerts</h2>
${docsParagraph(guide.messages)}
${orderTemplates}
${docsParagraph(guide.orderValuesIntro)}
${valueList([...ORDER_MESSAGE_VALUES, BUSINESS_VALUE], messageHelp)}
${docsParagraph(guide.otherTemplates)}
${otherTemplates}
<h2 id="staff-alerts">Staff alerts</h2>
${docsParagraph(guide.staffAlerts)}
${staffEvents}
${docsParagraph(guide.staffValuesIntro)}
${valueList([...STAFF_ALERT_VALUES, ...new Set(Object.values(STAFF_ALERT_EVENTS).flat()), STAFF_ALERT_LINK, STAFF_ALERT_PHONE], staffHelp)}
<h2 id="events">Events and webhooks</h2>
${docsParagraph(guide.events)}
${eventTypes}
<h2 id="couriers">Couriers</h2>
${docsParagraph(guide.couriers)}
${docsParagraph(guide.courierApi)}
${docsBlock(snippets.courier)}
<h2 id="storage">Storage and CORS</h2>
${docsParagraph(guide.storage)}
${docsBlock(snippets.cors)}
<h2 id="site">Your site serves</h2>
${docsParagraph(guide.site)}
${site}
<h3><code>GET /v1/seo/site</code></h3>
${docsParagraph(guide.homePage)}
${docsBlock(snippets.homePage)}
<h3><code>GET /v1/seo/products/:ref</code></h3>
${docsParagraph(guide.productMeta)}
${docsBlock(snippets.productMeta)}
<h3><code>GET /v1/seo/listing</code></h3>
${docsParagraph(guide.listing)}
${docsBlock(snippets.listingPage)}
<h3>Clearing your cache</h3>
${docsParagraph(guide.cacheRoute)}
${docsBlock(snippets.cacheRoute)}
<h3><code>GET /v1/policies</code></h3>
${docsParagraph(guide.policies)}
${docsBlock(snippets.policies)}
<h2 id="catalog-seo">Catalog and SEO</h2>
${docsParagraph(catalogSeo.intro)}
${groupSections(catalogSeo).join('\n')}
<h2 id="orders-guide">Checkout, orders and promotions</h2>
${docsParagraph(shop.intro)}
${groupSections(shop).join('\n')}
<h2 id="import">Import</h2>
${docsParagraph(imports.intro)}
${groupSections(imports).join('\n')}
<h2 id="chat">Chat lookups</h2>
${docsParagraph(guide.chat)}
${docsList(guide.chatRoutes.map((route) => `<code>${escapeHtml(route)}</code>`))}
<h2 id="customers">Orders in Accounts</h2>
${docsParagraph(guide.customers)}
${docsBlock(snippets.customerOrders)}
<h2 id="data-rights">Data rights and the activity log</h2>
${docsParagraph(guide.dataRights)}
<h2 id="features">Features</h2>
${docsFeatureSections({ manifest, rows, guide })}
<h2 id="admin">Admin widgets and tickets</h2>
${docsParagraph(guide.admin)}
${docsBlock(snippets.admin)}
${docsParagraph(guide.tickets)}
${permissionList}
${docsBlock(snippets.ticketNode)}
${docsBlock(snippets.ticketCurl)}`,
	});
};
