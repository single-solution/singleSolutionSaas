/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.7): the kit's page (`renderDocsPage`: title, intro, the localhost note,
 * the kit's routes for your server, business.json and the API reference from `openapi.json`) around Payments' own
 * sections: the payment API, confirming a payment for its exact amount, payment events through Notifications and the
 * webhook signature check, each gateway's setup with the addresses to register, currencies, bank transfer, links,
 * refunds, subscriptions, one section per feature (`docsFeatureSections`), and the widget and ticket snippets.
 * @module
 */
import { docsBlock, docsFeatureSections, docsOperations, docsParagraph, renderDocsPage } from '@ss/app-kit';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { GATEWAY_CURRENCIES } from '../core/gateways.js';
import { callbackUrls, createSnippets } from '../core/snippets.js';
import { manifest } from '../adapters/product.js';

/** The documented operations (the same for every request). */
const ROWS = docsOperations(openapi);

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
	});
	const urls = callbackUrls(base);
	const currencies = Object.entries(GATEWAY_CURRENCIES)
		.map(([gateway, list]) => `${gateway}: ${list === null ? 'any' : list.join(', ')}`)
		.join('\n');
	/** A section: its title, then its paragraph and code blocks. @param {string} title @param {string} text @param {string[]} code */
	const section = (title, text, ...code) => [`<h2>${title}</h2>`, docsParagraph(text), ...code.map(docsBlock)];
	/** A gateway's setup and the address to register. @param {string} name @param {string} text @param {string} url */
	const gateway = (name, text, url) => [`<h3>${name}</h3>`, docsParagraph(text), docsBlock(url)];
	const body = [
		...section('Create a payment', guide.payments, snippets.create),
		...section('Confirm a payment', guide.confirm, snippets.verify),
		...section('Payment events and webhooks', guide.events, snippets.webhook),
		...section('Gateways', guide.gateways),
		...gateway('Stripe', guide.stripe, urls.stripe),
		...gateway('PayPal', guide.paypal, urls.paypal),
		...gateway('PayFast (South Africa)', guide.payfast, urls.payfast),
		...gateway('PayFast (Pakistan)', guide.payfast_pk, urls.payfast_pk),
		...gateway('JazzCash (Pakistan)', guide.jazzcash, `${urls.jazzcash}/<paymentId>`),
		...gateway('Easypaisa (Pakistan)', guide.easypaisa, `${urls.easypaisa}/<paymentId>`),
		...gateway('Rapid Gateway (Pakistan)', guide.rapid, urls.rapid),
		...gateway('Generic gateway adapter', guide.generic, urls.generic),
		'<h3>Bank transfer (manual)</h3>',
		docsParagraph(guide.bank),
		docsBlock(snippets.bank),
		...section('Currencies', guide.currencies, currencies),
		...section('Payment links and the pay button', guide.links, snippets.link),
		...section('Refunds', guide.refunds, snippets.refund),
		...section('Subscriptions', guide.subscriptions, snippets.subscription),
		'<h2>Features</h2>',
		docsFeatureSections({ manifest, rows: ROWS, guide }),
		...section('Install the pay button', guide.install, snippets.visitor),
		...section('Admin widgets and tickets', guide.admin, snippets.admin),
		docsParagraph(guide.tickets),
		docsBlock(snippets.ticketNode),
		docsBlock(snippets.ticketCurl),
	].join('\n');
	return renderDocsPage({ guide, openapi, body });
};
