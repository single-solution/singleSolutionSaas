'use client';
/**
 * Payments' own parts of the shared dashboard tabs (PLAN 0.4.3): the Overview's ways to pay ready and the manual
 * payment methods payers do not see yet, the manual payment methods editor in Settings, each gateway's key form in
 * Connections, and the payment API, gateway addresses and snippets in Developers. The other tabs are the shared ones as they are.
 * @module
 */
import { Button, CodeBlock, Section, Stat } from '@ss/ui';
import { ConnectionsTab, DevelopersTab, OverviewTab, SettingsTab, fill, useLoad } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { GATEWAY_CONNECTIONS, GATEWAY_FEATURES, GATEWAYS } from '../../core/gateways.js';
import { methodReady } from '../../core/methods.js';
import { callbackUrls, createSnippets } from '../../core/snippets.js';
import { ConnectionForm, FORMS } from './forms.js';
import { MethodsEditor } from './methods.js';
import { TEXTS } from './texts.js';

/** @typedef {import('@ss/ui/dashboard').Answer} Answer */
/** @typedef {import('@ss/ui/dashboard').TabProps} TabProps */

/**
 * The manual payment methods payers see and those they do not see yet (a method paid first without an account with
 * details or instructions), and those that take proofs; null while the list is not loaded.
 * @param {Answer | null} list the `manual_methods` list
 * @returns {{ ready: string[], waiting: string[], proof: string[] } | null}
 */
const methodsOf = (list) => {
	if (!list?.ok) return null;
	/** @type {import('../../core/methods.js').ManualMethod[]} */
	const methods = list.data.value;
	return {
		ready: methods.filter((method) => methodReady(method, null).ready).map((method) => method.key),
		waiting: methods.filter((method) => !methodReady(method, null).ready).map((method) => method.name || method.key),
		proof: methods.filter((method) => method.proof).map((method) => method.name || method.key),
	};
};

/**
 * Whether the website's storage (for payment proofs) is connected; null while not known.
 * @param {Answer | null} connections
 */
const storageConnected = (connections) =>
	connections?.ok
		? connections.data.connections.some(
				(/** @type {{ name: string, status: string }} */ item) => item.name === 'storage' && item.status === 'connected',
			)
		: null;

/**
 * Switched-on gateways whose keys are connected, plus the manual payment methods payers see.
 * @param {{ featuresOn: string[], checklist: { connections: Array<{ name: string, status: string }> } }} data
 * @param {{ ready: string[] } | null} methods
 */
const gatewaysReady = (data, methods) =>
	GATEWAYS.filter((gateway) => {
		if (!data.featuresOn.includes(GATEWAY_FEATURES[gateway])) return false;
		const name = GATEWAY_CONNECTIONS[gateway];
		return data.checklist.connections.some((item) => item.name === name && item.status === 'connected');
	}).length + (methods?.ready.length ?? 0);

/**
 * Payments' part of the Overview (PLAN 0.6 "Overviews talk"): the ways to pay ready, and, while Manual payment methods
 * is on (its list is read only then), the methods payers do not see yet, and Storage missing while a method takes
 * proofs (the connections are read only then).
 * @type {import('@ss/ui/dashboard').UseOverviewMore}
 */
const usePaymentsOverview = (overview, { websiteId, open }) => {
	const manualOn = overview?.ok === true && overview.data.featuresOn.includes('manual_payments');
	const list = useLoad(manualOn ? `/v1/dashboard/websites/${websiteId}/lists/manual_methods` : null);
	const methods = manualOn ? methodsOf(list.answer) : null;
	const proofs = methods !== null && methods.proof.length > 0;
	const connections = useLoad(proofs ? `/v1/dashboard/websites/${websiteId}/connections` : null);
	if (!overview?.ok) return {};
	const waiting = methods !== null && methods.waiting.length > 0;
	const noStorage = proofs && storageConnected(connections.answer) === false;
	const O = TEXTS.overview;
	return {
		needs: [
			...(methods && waiting
				? [
						{
							key: 'methods',
							tone: /** @type {const} */ ('warning'),
							title: O.noMethods.title,
							effect: fill(O.methodsHelp, { names: methods.waiting.join(', ') }),
							action: (
								<Button size="sm" variant="secondary" onClick={() => open('settings')}>
									{O.noMethods.action}
								</Button>
							),
						},
					]
				: []),
			// proofs need the merchant's storage: said only while a method takes them
			...(methods && noStorage
				? [
						{
							key: 'storage',
							tone: /** @type {const} */ ('warning'),
							title: O.noStorage.title,
							effect: fill(O.storageHelp, { names: methods.proof.join(', ') }),
							action: (
								<Button size="sm" variant="secondary" onClick={() => open('connections')}>
									{O.noStorage.action}
								</Button>
							),
						},
					]
				: []),
		],
		steps: methods ? [{ key: 'methods', label: O.methodsStep, done: !waiting, onSelect: () => open('settings') }] : [],
		numbers: (
			<Stat
				label={O.gateways}
				value={gatewaysReady(overview.data, methods)}
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
 * Settings: the shared one, with the manual payment methods editor beside the features' settings while the feature is
 * shown (merchants see switched-on features only; Owner and Support may prepare it while it is off).
 * @param {TabProps} props
 */
const PaymentsSettings = (props) => (
	<SettingsTab
		{...props}
		featureCards={(features) => {
			const manual = features.find((feature) => feature.key === 'manual_payments');
			return manual && props.websiteId ? (
				<MethodsEditor websiteId={String(props.websiteId)} off={manual.on === false} />
			) : null;
		}}
	/>
);

/**
 * Each gateway's keys and the proof storage have their own form; the tokens keep the one value field.
 * @type {NonNullable<Parameters<typeof ConnectionsTab>[0]['form']>}
 */
const connectionForm = (item, save) => (item.name in FORMS ? <ConnectionForm name={item.name} onSave={save} /> : null);

/** @param {TabProps} props */
const PaymentsConnections = (props) => <ConnectionsTab {...props} form={connectionForm} />;

/**
 * Developers: the payment API, the gateway addresses of this website, webhooks, links, refunds, manual payment methods
 * and subscriptions, the widget snippets and the ticket request.
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
				<CodeBlock code={snippets.methods} />
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

/** Payments' sections in place of the shared Overview, Settings, Connections and Developers. */
export const TABS = Object.freeze({
	overview: PaymentsOverview,
	settings: PaymentsSettings,
	connections: PaymentsConnections,
	developers: PaymentsDevelopers,
});
