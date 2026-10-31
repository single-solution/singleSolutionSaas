'use client';
/**
 * Payments' own parts of the shared dashboard tabs (PLAN 0.4.3): the Overview's ways to pay ready and the manual
 * payment methods payers do not see yet, the manual payment methods editor in Settings, and in Developers the payment
 * API, gateway addresses and snippets, with each gateway's key form among the connections. The other tabs are the shared
 * ones as they are.
 * @module
 */
import { Button, CodeBlock, Section, Stat } from '@ss/ui';
import { DevelopersTab, OverviewTab, SettingsTab, fill, useLoad, useSetupSteps } from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { CUSTOM_GATEWAY_CONNECTIONS, GATEWAY_CONNECTIONS, GATEWAY_FEATURES, GATEWAYS } from '../../core/gateways.js';
import { methodReady } from '../../core/methods.js';
import { createSnippets } from '../../core/snippets.js';
import { ConnectionForm, FORMS } from './forms.js';
import { MethodsEditor } from './methods.js';
import { TEXTS } from './texts.js';

/** @type {ReadonlyArray<import('@ss/ui/dashboard').SetupRequirement>} */
const SETUP = Object.freeze([
	{
		key: 'way-to-pay',
		oneOf: [
			'stripe',
			'paypal',
			'payfast',
			'payfast_pk',
			'jazzcash',
			'easypaisa',
			'rapid',
			'generic_gateway',
			'manual_payments',
		],
		label: 'Switch on a way to take payments',
		why: 'Payers have nothing to pay with until a payment gateway or a manual method is on.',
		action: 'See features',
	},
]);

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
	GATEWAYS.reduce((count, gateway) => {
		if (!data.featuresOn.includes(GATEWAY_FEATURES[gateway])) return count;
		// the custom gateways count one each (P4)
		const names = gateway === 'generic' ? CUSTOM_GATEWAY_CONNECTIONS : [GATEWAY_CONNECTIONS[gateway]];
		return count + data.checklist.connections.filter((item) => names.includes(item.name) && item.status === 'connected').length;
	}, 0) + (methods?.ready.length ?? 0);

/**
 * Payments' part of the Overview (PLAN 0.6 "Overviews talk"): the ways to pay ready, and, while Manual payment methods
 * is on (its list is read only then), the methods payers do not see yet, and Storage missing while a method takes
 * proofs (the connections are read only then).
 * @type {import('@ss/ui/dashboard').UseOverviewMore}
 */
const usePaymentsOverview = (overview, { websiteId, open }) => {
	const setup = useSetupSteps({ overview, websiteId, open }, SETUP);
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
								<Button size="sm" variant="secondary" onClick={() => open('settings', 'manual_payments')}>
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
								<Button size="sm" variant="secondary" onClick={() => open('developers', 'connection-storage')}>
									{O.noStorage.action}
								</Button>
							),
						},
					]
				: []),
		],
		steps: [
			...setup,
			...(methods
				? [
						{
							key: 'methods',
							label: O.methodsStep,
							why: O.methodsWhy,
							actionLabel: O.methodsAction,
							done: !waiting,
							onSelect: () => open('settings', 'manual_payments'),
						},
					]
				: []),
		],
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
 * Settings: the shared one, with the manual payment methods editor under the Manual payment methods feature (shown
 * while the feature is on).
 * @param {TabProps} props
 */
const PaymentsSettings = (props) => (
	<SettingsTab
		{...props}
		extras={{
			manual_payments: props.websiteId ? <MethodsEditor websiteId={String(props.websiteId)} bare /> : null,
		}}
	/>
);

/**
 * Each gateway's keys and the proof storage have their own form; the tokens keep the one value field.
 * @type {NonNullable<import('@ss/ui/dashboard').ConnectionParts['form']>}
 */
const connectionForm = (item, save) => (item.name in FORMS ? <ConnectionForm name={item.name} onSave={save} /> : null);

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
	// each gateway's console addresses, as its adapter declares them (P12)
	const addresses = useLoad(props.websiteId ? `/v1/dashboard/websites/${props.websiteId}/gateway-addresses` : null);
	/** @type {Array<{ gateway: string, name: string, urls: string[] }>} */
	const items = addresses.answer?.ok ? addresses.answer.data.items : [];
	/** @param {string} id @param {string} title @param {string} help @param {import('react').ReactNode} body @param {import('@ss/ui').IconName} icon */
	const part = (id, title, help, body, icon) => ({
		id,
		label: title,
		icon,
		content: (
			<Section title={title} description={help}>
				{body}
			</Section>
		),
	});
	return (
		<DevelopersTab
			{...props}
			connections={{ form: connectionForm }}
			sections={[
				part(
					'api',
					D.api,
					D.apiHelp,
					<>
						<CodeBlock code={snippets.create} />
						<CodeBlock code={snippets.verify} />
					</>,
					'code',
				),
				part(
					'callbacks',
					D.callbacks,
					D.callbacksHelp,
					<CodeBlock code={items.flatMap((item) => item.urls.map((url) => `${item.name}: ${url}`)).join('\n')} />,
					'link',
				),
				part('events', D.events, D.eventsHelp, <CodeBlock code={snippets.webhook} />, 'bell'),
				part(
					'more',
					D.more,
					D.moreHelp,
					<>
						<CodeBlock code={snippets.link} />
						<CodeBlock code={snippets.refund} />
						<CodeBlock code={snippets.methods} />
						<CodeBlock code={snippets.subscription} />
					</>,
					'layers',
				),
				part(
					'widgets',
					D.widgets,
					D.widgetsHelp,
					<>
						<CodeBlock code={snippets.visitor} />
						<CodeBlock code={snippets.admin} />
					</>,
					'box',
				),
				part('ticket', D.ticket, D.ticketHelp, <CodeBlock code={snippets.ticketNode} />, 'key'),
			]}
		/>
	);
}

/** Payments' sections in place of the shared Overview, Settings and Developers. */
export const TABS = Object.freeze({
	overview: PaymentsOverview,
	settings: PaymentsSettings,
	developers: PaymentsDevelopers,
});
