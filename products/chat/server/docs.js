/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.3), on the kit's docs toolkit (`renderDocsPage`, which adds the title,
 * the intro and localhost note, the kit's sections for the merchant's server with Chat's lists and counts after them,
 * the website settings note and the API reference from `openapi.json`). Chat's own sections: the widget snippet, the visitor API
 * with guests and signed-in visitors, AI, knowledge, webhook tools and their signature check, the booking endpoint's
 * two requests, handoff, flows, the Notifications messages and their values (`schemas/messages.json`), attachments and
 * the bucket's CORS rule, data rights and the activity log, the shop tools with the Ecommerce routes they call, product
 * cards and their add-to-cart event, the context panel's shop info, one section per feature (`docsFeatureSections`),
 * admin widgets with the ticket server snippet (Node.js fetch and cURL) and the import feature. Plain HTML; every value
 * is escaped.
 * @module
 */
import { docsBlock, docsFeatureSections, docsList, docsOperations, docsParagraph, renderDocsPage } from '@ss/app-kit';
import { escapeHtml } from '@ss/contracts/text';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import declaration from '../schemas/messages.json' with { type: 'json' };
import { CONTEXT_ENDPOINT, SHOP_ANSWERS, SHOP_ENDPOINTS, STORE_CONTEXT_ENDPOINT } from '../core/shop.js';
import { createSnippets } from '../core/snippets.js';
import { manifest } from '../adapters/product.js';

/** Every documented operation, read once. */
const rows = docsOperations(openapi);

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
	const messages = declaration.messages.map(
		(message) =>
			`<code>${escapeHtml(message.key)}</code>: ${message.values.map((value) => `<code>{${escapeHtml(value)}}</code>`).join(', ')}`,
	);
	const shop = [
		...SHOP_ENDPOINTS.map(
			(row) => `<code>${escapeHtml(row.tool)}</code> (${escapeHtml(row.feature)}): <code>${escapeHtml(row.request)}</code>`,
		),
		`store context (${escapeHtml(STORE_CONTEXT_ENDPOINT.feature)}): <code>${escapeHtml(STORE_CONTEXT_ENDPOINT.request)}</code>`,
		`context panel (${escapeHtml(CONTEXT_ENDPOINT.feature)}): <code>${escapeHtml(CONTEXT_ENDPOINT.request)}</code>`,
	];
	const answers = Object.entries(SHOP_ANSWERS).map(([name, fields]) => `${escapeHtml(name)}: ${escapeHtml(fields)}`);
	const body = `<h2>Install the widget</h2>
${docsParagraph(guide.install)}
${docsBlock(snippets.visitor)}
<h2>Your own chat screens (visitor API)</h2>
${docsParagraph(guide.visitorApi)}
<h2>Guests and signed-in visitors</h2>
${docsParagraph(guide.guests)}
${docsParagraph(guide.signedIn)}
<h2>AI</h2>
${docsParagraph(guide.ai)}
${docsParagraph(guide.knowledge)}
<h2>Webhook tools and booking</h2>
${docsParagraph(guide.tools)}
${docsBlock(snippets.toolCheck)}
${docsParagraph(guide.booking)}
<h2>Handoff and flows</h2>
${docsParagraph(guide.handoff)}
${docsParagraph(guide.flows)}
<h2>Staff alerts, transcripts and cost alerts</h2>
${docsParagraph(guide.alerts)}
${docsList(messages)}
<h2>Attachments</h2>
${docsParagraph(guide.attachments)}
<h2>Data rights and the activity log</h2>
${docsParagraph(guide.dataRights)}
${docsParagraph(guide.activity)}
<h2>Shop tools (with Ecommerce)</h2>
${docsParagraph(guide.shop)}
${docsList(shop)}
${docsList(answers)}
${docsParagraph(guide.cards)}
${docsParagraph(guide.contextPanel)}
<h2>Features</h2>
${docsFeatureSections({ manifest, rows, guide })}
<h2>Admin widgets and tickets</h2>
${docsParagraph(guide.admin)}
${docsBlock(snippets.admin)}
${docsParagraph(guide.tickets)}
${docsBlock(snippets.ticketNode)}
${docsBlock(snippets.ticketCurl)}
<h2 id="import">Import</h2>
${docsParagraph(guide.import)}`;
	return renderDocsPage({ guide, openapi, body });
};
