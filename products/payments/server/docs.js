/**
 * The public docs at `/docs` (PLAN 0.4.10, 0.8.7): the kit's page (`renderDocsPage`: title, intro, the localhost note,
 * the kit's routes for your server, business.json and the API reference from `openapi.json`) around Payments' own
 * sections: the payment API, confirming a payment for its exact amount, payment events through Notifications and the
 * webhook signature check, each gateway's setup with the addresses its adapter says to register (P12), currencies,
 * manual payment methods, links,
 * refunds, subscriptions, one section per feature (`docsFeatureSections`), and the widget and ticket snippets.
 * @module
 */
import { docsBlock, docsFeatureSections, docsOperations, docsParagraph, renderDocsPage } from '@ss/app-kit';
import guide from '../docs/guide.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { escapeHtml } from '@ss/contracts/text';
import { GATEWAYS, GATEWAY_CURRENCIES, GATEWAY_FEATURES } from '../core/gateways.js';
import { createSnippets, gatewayAddresses } from '../core/snippets.js';
import { manifest } from '../adapters/product.js';

/** The documented operations (the same for every request). */
const ROWS = docsOperations(openapi);

/**
 * The docs page.
 * @param {{ base: string, addresses: Readonly<Record<string, ReadonlyArray<'notice' | 'return'>>> }} input the
 *   product's address (snippets point at it) and what each gateway's adapter says to register in its console (P12)
 * @returns {string}
 */
export const renderDocs = ({ base, addresses }) => {
	const snippets = createSnippets({
		base,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
	});
	const urls = new Map(gatewayAddresses(base, undefined, addresses).map((entry) => [entry.gateway, entry.urls]));
	const names = new Map(manifest.features.map((feature) => [feature.key, feature.name]));
	const currencies = Object.entries(GATEWAY_CURRENCIES)
		.map(([gateway, list]) => `${gateway}: ${list === null ? 'any' : list.join(', ')}`)
		.join('\n');
	/** A section: its title, then its paragraph and code blocks. @param {string} title @param {string} text @param {string[]} code */
	const section = (title, text, ...code) => [`<h2>${title}</h2>`, docsParagraph(text), ...code.map(docsBlock)];
	/** Each gateway by its dashboard name, its guide and the addresses its adapter declares (P12). */
	const gateways = GATEWAYS.flatMap((gateway) => [
		`<h3>${escapeHtml(names.get(GATEWAY_FEATURES[gateway]) ?? gateway)}</h3>`,
		docsParagraph(String(/** @type {Record<string, unknown>} */ (guide)[gateway] ?? '')),
		// its own addresses, or those of the gateways that run on it (custom gateways, generic:<key>)
		...[...urls.entries()]
			.filter(([id]) => id === gateway || id.startsWith(`${gateway}:`))
			.map(([, list]) => docsBlock(list.join('\n'))),
	]);
	const body = [
		...section('Create a payment', guide.payments, snippets.create),
		...section('Confirm a payment', guide.confirm, snippets.verify),
		...section('Payment events and webhooks', guide.events, snippets.webhook),
		...section('Gateways', guide.gateways),
		...gateways,
		'<h3>Manual payment methods</h3>',
		docsParagraph(guide.bank),
		docsBlock(snippets.methods),
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
