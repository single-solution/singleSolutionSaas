'use client';
/**
 * Payments' own parts of the shared dashboard tabs (PLAN 0.4.3): the Overview's gateways ready and what Bank transfer
 * still misses, each gateway's key form in Connections, and the payment API, gateway addresses and snippets in
 * Developers. The other tabs are the shared ones as they are.
 * @module
 */
import { Button, CodeBlock, Section, Stat } from '@ss/ui';
import { ConnectionsTab, DevelopersTab, OverviewTab, fill, useLoad } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { GATEWAY_CONNECTIONS, GATEWAY_FEATURES, GATEWAYS, bankTransfer } from '../../core/gateways.js';
import { callbackUrls, createSnippets } from '../../core/snippets.js';
import { ConnectionForm, FORMS } from './forms.js';
import { TEXTS } from './texts.js';

/** @typedef {import('@ss/ui/dashboard').Answer} Answer */
/** @typedef {import('@ss/ui/dashboard').TabProps} TabProps */

/**
 * Bank transfer as payers and the merchant's server see it (PLAN 0.8.10 P1, P2), from the website's settings; null
 * while they are not loaded or the feature is off.
 * @param {Answer | null} settings
 */
const bankOf = (settings) => {
	const feature = settings?.ok
		? settings.data.features.find((/** @type {{ key: string, on: boolean }} */ item) => item.key === 'bank_transfer' && item.on)
		: undefined;
	if (!feature) return null;
	return bankTransfer(
		Object.fromEntries(
			Object.entries(feature.values ?? {}).map(([name, entry]) => [name, /** @type {{ value: unknown }} */ (entry).value]),
		),
	);
};

/**
 * Why bank transfer is not offered yet, from what it misses (P2): the details to set, or, with Require bank details
 * off, the instructions.
 * @param {import('../../core/gateways.js').BankTransfer} bank
 */
const bankHelp = (bank) => {
	if (bank.missing.includes('instructions')) return TEXTS.overview.bankHelpInstructions;
	const [first = '', second] = bank.missing.map((name) => TEXTS.overview.bankMissing[/** @type {'accountHolder'} */ (name)]);
	return fill(TEXTS.overview.bankHelpDetails, { missing: second ? fill(TEXTS.overview.and, { first, second }) : first });
};

/**
 * Switched-on gateways whose keys are connected; bank transfer, whose details are settings, counts when it is ready
 * (payers are told how to pay: see {@link bankTransfer}).
 * @param {{ featuresOn: string[], checklist: { connections: Array<{ name: string, status: string }> } }} data
 * @param {Answer | null} settings the website's settings
 */
const gatewaysReady = (data, settings) =>
	GATEWAYS.filter((gateway) => {
		if (!data.featuresOn.includes(GATEWAY_FEATURES[gateway])) return false;
		if (gateway === 'bank_transfer') return bankOf(settings)?.ready === true;
		const name = GATEWAY_CONNECTIONS[gateway];
		return data.checklist.connections.some((item) => item.name === name && item.status === 'connected');
	}).length;

/**
 * Payments' part of the Overview (PLAN 0.6 "Overviews talk"): the gateways ready, and, while Bank transfer is on (the
 * website's settings are read only then), what it still misses before payers see it.
 * @type {import('@ss/ui/dashboard').UseOverviewMore}
 */
const usePaymentsOverview = (overview, { websiteId, open }) => {
	const bankOn = overview?.ok === true && overview.data.featuresOn.includes('bank_transfer');
	const settings = useLoad(bankOn ? `/v1/dashboard/websites/${websiteId}/settings` : null);
	if (!overview?.ok) return {};
	const bank = bankOf(settings.answer);
	const O = TEXTS.overview;
	return {
		needs:
			bank && !bank.ready
				? [
						{
							key: 'bank',
							tone: 'warning',
							title: O.noBank.title,
							effect: bankHelp(bank),
							action: (
								<Button size="sm" variant="secondary" onClick={() => open('settings')}>
									{O.noBank.action}
								</Button>
							),
						},
					]
				: [],
		steps: bank ? [{ key: 'bank', label: O.bankStep, done: bank.ready, onSelect: () => open('settings') }] : [],
		numbers: (
			<Stat
				label={O.gateways}
				value={gatewaysReady(overview.data, settings.answer)}
				hint={O.gatewaysHelp}
				icon="coins"
				kind="connection"
			/>
		),
	};
};

/** @param {TabProps} props */
const PaymentsOverview = (props) => <OverviewTab {...props} useMore={usePaymentsOverview} />;

/**
 * Each gateway's keys and the proof storage have their own form; the tokens keep the one value field.
 * @type {NonNullable<Parameters<typeof ConnectionsTab>[0]['form']>}
 */
const connectionForm = (item, save) => (item.name in FORMS ? <ConnectionForm name={item.name} onSave={save} /> : null);

/** @param {TabProps} props */
const PaymentsConnections = (props) => <ConnectionsTab {...props} form={connectionForm} />;

/**
 * Developers: the payment API, the gateway addresses of this website, webhooks, links, refunds, bank details and
 * subscriptions, the widget snippets and the ticket request.
 * @param {TabProps} props
 */
function PaymentsDevelopers(props) {
	const origin = typeof window === 'undefined' ? '' : window.location.origin;
	const D = TEXTS.developers;
	const snippets = createSnippets({
		base: origin,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
	});
	const urls = callbackUrls(origin, String(props.websiteId));
	return (
		<DevelopersTab {...props}>
			<Section title={D.api} description={D.apiHelp}>
				<CodeBlock code={snippets.create} />
				<CodeBlock code={snippets.verify} />
			</Section>
			<Section title={D.callbacks} description={D.callbacksHelp}>
				<CodeBlock
					code={Object.entries(urls)
						.map(
							([gateway, url]) =>
								`${gateway}: ${url}${gateway === 'jazzcash' || gateway === 'easypaisa' ? '/<paymentId>' : ''}`,
						)
						.join('\n')}
				/>
			</Section>
			<Section title={D.events} description={D.eventsHelp}>
				<CodeBlock code={snippets.webhook} />
			</Section>
			<Section title={D.more} description={D.moreHelp}>
				<CodeBlock code={snippets.link} />
				<CodeBlock code={snippets.refund} />
				<CodeBlock code={snippets.bank} />
				<CodeBlock code={snippets.subscription} />
			</Section>
			<Section title={D.widgets} description={D.widgetsHelp}>
				<CodeBlock code={snippets.visitor} />
				<CodeBlock code={snippets.admin} />
			</Section>
			<Section title={D.ticket} description={D.ticketHelp}>
				<CodeBlock code={snippets.ticketNode} />
			</Section>
		</DevelopersTab>
	);
}

/** Payments' sections in place of the shared Overview, Connections and Developers. */
export const TABS = Object.freeze({
	overview: PaymentsOverview,
	connections: PaymentsConnections,
	developers: PaymentsDevelopers,
});
