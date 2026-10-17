/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.6): the kit's page (`renderDocsPage`: title, intro, the localhost note,
 * the kit's routes for your server, the website settings note and the API reference from `openapi.json`) around Accounts' own
 * sections: sign-in methods and the Notifications templates they use (`schemas/messages.json`), social sign-in return
 * addresses, sign-ins and their offline verification (public keys, Node.js and jose snippets), the visitor API, roles
 * and permissions, sign-up rules and security, data rights, activity-log copies, the Orders tab, staff and sign-in from
 * your server, imported passwords and two-step, the features (`docsFeatureSections`: words, routes and widgets, a
 * feature with none shows no table or list, and what the website builds), the widget snippets and the ticket server
 * snippet (Node.js fetch and cURL). Plain HTML; every value is escaped.
 * @module
 */
import { docsBlock, docsFeatureSections, docsList, docsOperations, docsParagraph, renderDocsPage } from '@ss/app-kit';
import { escapeHtml } from '@ss/contracts/text';
import guide from '../docs/guide.json' with { type: 'json' };
import messages from '../schemas/messages.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { createSnippets } from '../core/snippets.js';
import { manifest } from '../adapters/product.js';

/** The operations of the API reference (the same for every request). */
const ROWS = docsOperations(openapi);

/**
 * The docs page.
 * @param {{ base: string }} input Accounts' address (snippets point at it)
 * @returns {string}
 */
export const renderDocs = ({ base }) => {
	const snippets = createSnippets({
		base,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
	});
	const templates = messages.messages.map(
		(message) =>
			`<code>${escapeHtml(message.key)}</code>: ${message.values.map((value) => `<code>{${escapeHtml(value)}}</code>`).join(', ')}`,
	);
	const body = `<h2>Sign-in methods</h2>
${docsParagraph(guide.methods)}
${docsList(templates)}
<h2>Google, Apple and Facebook</h2>
${docsParagraph(guide.social)}
${docsBlock(snippets.returnAddresses)}
<h2>Sign-ins and offline verification</h2>
${docsParagraph(guide.signIns)}
${docsBlock(snippets.keysUrl)}
${docsBlock(snippets.verify)}
${docsBlock(snippets.verifyJose)}
<h2>Your own screens (visitor API)</h2>
${docsParagraph(guide.visitorApi)}
${docsBlock(snippets.signedInCall)}
<h2>Roles and permissions</h2>
${docsParagraph(guide.roles)}
<h2>Sign-up rules and security</h2>
${docsParagraph(guide.rules)}
<h2>Data rights</h2>
${docsParagraph(guide.dataRights)}
<h2>Activity log copy</h2>
${docsParagraph(guide.activity)}
<h2>Orders tab</h2>
${docsParagraph(guide.orders)}
<h2>Staff and customers from your server</h2>
${docsParagraph(guide.staff)}
<h2>Sign-in from your server</h2>
${docsParagraph(guide.serverSignIn)}
<h2>Passwords and two-step from another system</h2>
${docsParagraph(guide.imported)}
<h2>Features</h2>
${docsFeatureSections({ manifest, rows: ROWS, guide })}
<h2>Install the widgets</h2>
${docsParagraph(guide.install)}
${docsBlock(snippets.visitor)}
<h2>Admin widgets and tickets</h2>
${docsParagraph(guide.admin)}
${docsBlock(snippets.admin)}
${docsParagraph(guide.tickets)}
${docsBlock(snippets.ticketNode)}
${docsBlock(snippets.ticketCurl)}`;
	return renderDocsPage({ guide, openapi, body });
};
