/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.9): the kit's page (`renderDocsPage`: the intro, the localhost note, the
 * kit's routes for your server, the business.json template and the API reference from `openapi.json`) around Growth's
 * own sections: the page script, consent and Google Consent Mode, privacy and storage, the shop events, searches, 404s
 * and Web Vitals, robots.txt and verification, IndexNow, the SEO checklist, redirects, the notice bar, the features
 * (`docsFeatureSections`: words, routes and widgets; a feature with none shows no table or list) and the widget and
 * ticket snippets. Plain HTML; every value is escaped.
 * @module
 */
import { docsBlock as block, docsFeatureSections, docsOperations, docsParagraph as para, renderDocsPage } from '@ss/app-kit';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { createSnippets } from '../core/snippets.js';
import { manifest } from '../adapters/product.js';

/**
 * The docs page.
 * @param {{ base: string }} input the product's address (snippets point at it)
 * @returns {string}
 */
export const renderDocs = ({ base }) => {
	const snippets = createSnippets({
		base,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
		loading: /** @type {'async' | 'blocking'} */ (manifest.widgetScriptLoading),
	});
	return renderDocsPage({
		guide,
		openapi,
		body: `<h2>The page script</h2>
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
<h2>Redirects</h2>
${para(guide.redirects)}
${block(snippets.redirects)}
<h2>Notice bar</h2>
${para(guide.notice)}
${block(snippets.notice)}
<h2>Features</h2>
${docsFeatureSections({ manifest, rows: docsOperations(openapi), guide })}
<h2>Admin widgets and tickets</h2>
${para(guide.admin)}
${block(snippets.admin)}
${para(guide.tickets)}
${block(snippets.ticketNode)}
${block(snippets.ticketCurl)}`,
	});
};
