/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.5), on the kit's docs page (`renderDocsPage`: the title, intro and
 * localhost note, the kit's routes for your server, the website settings note and the API reference from `openapi.json`) with
 * Notifications' own sections: the send API and template keys, retries and fallback, timing, languages, providers (with
 * a worked example for a gateway with an HTTP API), unsubscribe keywords, browser and staff push (with the service
 * worker), the webhook signature check and other products' events, the delivery log, one section per feature
 * (`docsFeatureSections`: its routes, widgets and what the website builds), the widget snippets and the ticket server
 * snippet (Node.js fetch and cURL). Plain HTML; every value is escaped.
 * @module
 */
import { docsBlock, docsFeatureSections, docsOperations, docsParagraph, renderDocsPage } from '@ss/app-kit';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { createSnippets } from '../core/snippets.js';
import { SERVICE_WORKER_PATH, SERVICE_WORKER_SOURCE } from '../core/widgets.js';
import { SIGNATURE_HEADER, WEBHOOK_EVENTS } from '../core/webhooks.js';
import { manifest } from '../adapters/product.js';

/** Every documented operation (the feature sections list each feature's routes). */
const ROWS = docsOperations(openapi);

/**
 * The docs page.
 * @param {{ base: string }} input the product's address (snippets point at it)
 * @returns {string}
 */
export const renderDocs = ({ base }) => {
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
	const body = `<h2>Send a message</h2>
${docsParagraph(guide.send)}
${docsBlock(sendSnippet)}
${docsBlock(sendCurl)}
<h2>Templates and template keys</h2>
${docsParagraph(guide.templates)}
<h2>Default templates of products</h2>
${docsParagraph(guide.defaults)}
<h2>Retries and fallback</h2>
${docsParagraph(guide.retries)}
<h2>Quiet hours, send limits and delayed send</h2>
${docsParagraph(guide.timing)}
<h2>Unsubscribe topics</h2>
${docsParagraph(guide.topics)}
<h2>Languages</h2>
${docsParagraph(guide.languages)}
<h2>Providers</h2>
${docsParagraph(guide.providers)}
<h2>Unsubscribe keywords</h2>
${docsParagraph(guide.keywords)}
${docsBlock(inbound)}
<h2>Browser and staff push</h2>
${docsParagraph(guide.push)}
${docsBlock(`${SERVICE_WORKER_PATH}\n\n${SERVICE_WORKER_SOURCE}`)}
${docsBlock(pushSnippet)}
<h2>Outgoing webhooks</h2>
${docsParagraph(guide.webhooks)}
${docsParagraph(`Events: ${WEBHOOK_EVENTS.join(', ')}. Header: ${SIGNATURE_HEADER}.`)}
${docsBlock(webhookSnippet)}
${docsParagraph(guide.events)}
<h2>Delivery log</h2>
${docsParagraph(guide.log)}
<h2>Features</h2>
${docsFeatureSections({ manifest, rows: ROWS, guide })}
<h2>Install the widgets</h2>
${docsParagraph(guide.install)}
${docsBlock(visitorSnippet)}
<h2>Admin widgets and tickets</h2>
${docsParagraph(guide.admin)}
${docsBlock(adminSnippet)}
${docsParagraph(guide.tickets)}
${docsBlock(nodeSnippet)}
${docsBlock(curlSnippet)}`;
	return renderDocsPage({ guide, openapi, body });
};
