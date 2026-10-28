'use client';
/**
 * Ecommerce's parts of the dashboard tabs (PLAN 0.4.3, 0.8.8), on the shared tabs of `@ss/ui/dashboard`: the Overview's
 * own items, its settings sections (Settings and Defaults), and the developer snippets with the catalog and SEO guide,
 * above which the connections (the courier connection form with its hint; the database, the storage and the AI provider
 * key are the Portal's).
 * @module
 */
import { Fragment } from 'react';
import { Button, ButtonLink, CodeBlock, LocalTime, Section, Stat, TextLink } from '@ss/ui';
import {
	DefaultsTab,
	DevelopersTab,
	OverviewTab,
	fill,
	settingSectionOf,
	useLoad,
	useSetupSteps,
	wantsSettings,
} from '@ss/ui/dashboard';
import manifest from '../../manifest.json' with { type: 'json' };
import { paidByHand } from '../../core/payment-methods.js';
import { SEARCH_INDEX_DEFINITION } from '../../core/search.js';
import { SITE_ROUTES, createSnippets } from '../../core/snippets.js';
import { ConnectionForm, formOf } from './forms.js';
import { SETUP } from './setup-steps.js';
import { SettingsTab, settingsNotice } from './settings.js';
import { TEXTS } from './texts.js';

/** @typedef {import('@ss/ui/dashboard').TabProps} TabProps */
/** @typedef {import('@ss/ui/dashboard').Connection} Connection */
/** @typedef {import('@ss/ui/dashboard').Answer} Answer */

/**
 * Fill `{name}` placeholders with text or elements (a `<LocalTime>`), as children.
 * @param {string} text
 * @param {Record<string, import('react').ReactNode>} values
 * @returns {import('react').ReactNode}
 */
const say = (text, values) =>
	text
		.split(/\{(\w+)\}/g)
		.map((part, i) =>
			i % 2 === 0 ? part : Object.hasOwn(values, part) ? <Fragment key={i}>{values[part]}</Fragment> : `{${part}}`,
		);

/**
 * @typedef {{ search: 'basic' | 'atlas', index: string,
 *   state: { missing: boolean, at: string, message: string } | null }} SearchIndex
 */

/**
 * A setting's value and whether the merchant set it (`source` `website`) in the dashboard's settings answer.
 * @param {Answer | null} answer @param {string} feature @param {string} key
 * @returns {{ value: unknown, set: boolean } | null} null while not loaded or the feature is not shown
 */
const settingOf = (answer, feature, key) => {
	if (!answer?.ok) return null;
	/** @type {{ key: string, values: Record<string, { value: unknown, source: string }> } | undefined} */
	const found = answer.data.features.find((/** @type {{ key: string }} */ item) => item.key === feature);
	const entry = found?.values?.[key];
	return entry ? { value: entry.value, set: entry.source === 'website' } : null;
};

/**
 * Ecommerce's part of the Overview (PLAN 0.6 "Overviews talk"), judged from setup only (no business data): with
 * checkout, Payments (recommended) and Notifications (optional, when no feature needs it), payment methods paid by hand
 * with no instructions or account details for shoppers; with the catalog, the Atlas Search index while the shop or Chat searches with Atlas;
 * with Staff alerts, someone to alert and the admin page they
 * link to; and how many of the connections the features need are ready. `/connections` is read only with checkout or
 * Staff alerts, `/search-index` and `/settings` only with the catalog.
 * @type {import('@ss/ui/dashboard').UseOverviewMore}
 */
const useShopOverview = (overview, { websiteId, open }) => {
	const base = `/v1/dashboard/websites/${websiteId}`;
	/** @type {string[]} */
	const on = overview?.ok ? overview.data.featuresOn : [];
	const shop = on.includes('checkout');
	const catalog = on.includes('catalog');
	// staff alerts demoted under Checkout — load Connections whenever checkout is on
	const connections = useLoad(shop ? `${base}/connections` : null);
	const search = useLoad(catalog ? `${base}/search-index` : null);
	const settings = useLoad(catalog || wantsSettings(overview, SETUP) ? `${base}/settings` : null);
	// the settings and lists the switched-on features need to be set, as steps with a button to their section
	const setup = useSetupSteps({ overview, websiteId, open, settings: settings.answer }, SETUP);
	const methods = useLoad(shop ? `${base}/lists/payment_methods` : null);
	if (!overview?.ok) return {};
	const O = TEXTS.overview;
	/** The Settings section of a feature, for a button that opens it. @param {string} feature */
	const sectionOf = (feature) => {
		/** @type {import('@ss/ui/dashboard').FeatureSettings | undefined} */
		const found = settings.answer?.ok
			? settings.answer.data.features.find((/** @type {{ key: string }} */ item) => item.key === feature)
			: undefined;
		return found ? settingSectionOf(found) : feature;
	};
	/** @param {string} label @param {string} tab @param {string} [section] */
	const go = (label, tab, section) => (
		<Button size="sm" variant="secondary" onClick={() => (section ? open(tab, section) : open(tab))}>
			{label}
		</Button>
	);
	/** @type {Connection[]} */
	const needed = overview.data.checklist.connections;
	/** @type {Connection[]} */
	const all = connections.answer?.ok ? connections.answer.data.connections : [];
	/** @param {string} name */
	const connection = (name) => [...needed, ...all].find((item) => item.name === name) ?? null;
	// not required by a feature, but what a shop with checkout normally wants
	const payments = shop && !needed.some((item) => item.name === 'link_payments') ? connection('link_payments') : null;
	const messages = shop && !needed.some((item) => item.name === 'link_notifications') ? connection('link_notifications') : null;
	const ready = needed.filter((item) => item.status === 'connected').length;
	/** @type {import('@ss/ui').Need[]} */
	const needs = [];
	/** @type {NonNullable<import('@ss/ui/dashboard').OverviewMore['steps']>} */
	const steps = [];
	if (payments) {
		if (payments.status !== 'connected')
			needs.push({
				key: 'payments',
				tone: 'warning',
				title: O.payments.title,
				effect: O.payments.effect,
				action: go(O.payments.action, 'developers', 'connection-link_payments'),
			});
		steps.push({
			key: 'payments',
			label: O.payments.step,
			why: O.payments.why,
			actionLabel: O.payments.action,
			done: payments.status === 'connected',
			onSelect: () => open('developers', 'connection-link_payments'),
		});
	}
	if (messages)
		steps.push({
			key: 'notifications',
			label: O.notificationsStep,
			why: O.notificationsWhy,
			actionLabel: O.notificationsAction,
			optional: true,
			done: messages.status === 'connected',
			onSelect: () => open('developers', 'connection-link_notifications'),
		});
	// the Atlas Search index, while the shop or Chat searches with Atlas (E14)
	/** @type {NonNullable<import('@ss/ui/dashboard').OverviewMore['steps']>[number] | null} */
	let searchStep = null;
	/** @type {SearchIndex | null} */
	const atlas = catalog && search.answer?.ok && search.answer.data?.search === 'atlas' ? search.answer.data : null;
	if (atlas) {
		const { state, index } = atlas;
		const docs = (
			<ButtonLink size="sm" href="/docs#atlas-search">
				{O.search.docs}
			</ButtonLink>
		);
		if (state?.missing)
			needs.push({
				key: 'search',
				tone: 'warning',
				title: fill(O.search.title, { index }),
				effect: [
					say(O.search.effect, { time: <LocalTime value={state.at} /> }),
					state.message ? ` ${fill(O.search.message, { message: state.message })}` : '',
				],
				action: docs,
			});
		searchStep = {
			key: 'search',
			label: fill(O.search.step, { index }),
			why: O.search.why,
			actionLabel: O.search.docs,
			done: state !== null && !state.missing,
			detail: !state
				? O.search.unchecked
				: say(state.missing ? O.search.missing : O.search.ready, { time: <LocalTime value={state.at} /> }),
			href: '/docs#atlas-search',
		};
	}
	// someone to alert, and the admin page alerts link to (shop health P5-18, setup part)
	if (alertsOn && settings.answer?.ok) {
		const recipients = settingOf(settings.answer, 'staff_alerts', 'recipients')?.value;
		const permission = String(settingOf(settings.answer, 'staff_alerts', 'staffPermission')?.value ?? '');
		const listed = Array.isArray(recipients) && recipients.length > 0;
		const staff = permission !== '' && connection('accounts')?.status === 'connected';
		if (!listed && !staff)
			needs.push({
				key: 'alerts',
				tone: 'warning',
				title: O.alerts.title,
				effect: O.alerts.effect,
				action: go(O.alerts.action, 'settings', sectionOf('staff_alerts')),
			});
		if (!String(settingOf(settings.answer, 'staff_alerts', 'adminUrl')?.value ?? '').trim())
			needs.push({
				key: 'admin-url',
				tone: 'warning',
				title: O.adminUrl.title,
				effect: O.adminUrl.effect,
				action: go(O.adminUrl.action, 'settings', sectionOf('staff_alerts')),
			});
	}
	// a method paid by hand, offered, with nothing telling shoppers where to pay (no instructions, no account row with
	// a value)
	const listed = methods.answer?.ok && Array.isArray(methods.answer.data?.value) ? methods.answer.data.value : [];
	const untold = listed.filter(
		(/** @type {import('../../core/payment-methods.js').PaymentMethodRecord} */ method) =>
			method.active &&
			paidByHand(method) &&
			!method.instructions &&
			!method.accounts.some((account) => account.rows.some((row) => row.value !== '')),
	);
	if (shop && untold.length > 0)
		needs.push({
			key: 'bank',
			tone: 'warning',
			title: fill(O.bank.title, { methods: untold.map((/** @type {any} */ method) => method.name).join(', ') }),
			effect: O.bank.effect,
			action: go(O.bank.action, 'settings', 'checkout.payment-methods'),
		});
	return {
		needs,
		// the connections first, then what the features need set, then the search index
		steps: [...steps, ...setup, ...(searchStep ? [searchStep] : [])],
		numbers: (
			<Stat
				label={O.connectionsReady}
				value={fill(O.ofTotal, { count: ready, total: needed.length })}
				hint={O.connectionsHint}
				tone={ready < needed.length ? 'warning' : 'success'}
				icon="plug"
				kind="connection"
			/>
		),
	};
};

/**
 * The one-line help under a connection: what to paste or enter (one for every courier API connection).
 * @param {string} name
 */
const connectionHint = (name) =>
	TEXTS.connections.hints[/** @type {keyof typeof TEXTS.connections.hints} */ (formOf(name) ?? name)] ?? null;

/**
 * The structured value of each courier API (the other connections take one value; the database, the storage and the AI
 * provider key are the Portal's).
 * @param {Connection} item
 * @param {(value: unknown) => Promise<void>} save
 */
const connectionForm = (item, save) => (formOf(item.name) ? <ConnectionForm name={item.name} onSave={save} /> : null);

/** @param {TabProps} props */
function Overview(props) {
	return <OverviewTab {...props} useMore={useShopOverview} />;
}

/**
 * The widget scripts, the JS API, the ticket request, what the merchant's site serves, the Atlas Search index and the
 * storage CORS, pointing at this Ecommerce; the catalog and SEO guide beside the docs. The connections come first.
 * @param {TabProps} props
 */
function Developers(props) {
	const origin = typeof window === 'undefined' ? '' : window.location.origin;
	const snippets = createSnippets({
		base: origin,
		widgets: manifest.widgets,
		permissions: manifest.permissions.map((permission) => permission.key),
	});
	const D = TEXTS.developers;
	/** @param {string} id @param {string} title @param {string} help @param {import('react').ReactNode} body @param {import('@ss/ui').IconName} icon @param {import('react').ReactNode} [actions] */
	const part = (id, title, help, body, icon, actions) => ({
		id,
		label: title,
		icon,
		content: (
			<Section title={title} description={help} {...(actions ? { actions } : {})}>
				{body}
			</Section>
		),
	});
	return (
		<DevelopersTab
			{...props}
			connections={{ hint: connectionHint, form: connectionForm }}
			sections={[
				part('visitor', D.visitor, D.visitorHelp, <CodeBlock code={snippets.visitor} />, 'users'),
				part('api', D.api, D.apiHelp, <CodeBlock code={snippets.api} />, 'code'),
				part('event', D.event, D.eventHelp, <CodeBlock code={snippets.addToCartEvent} />, 'activity'),
				part('admin', D.admin, D.adminHelp, <CodeBlock code={snippets.admin} />, 'box'),
				part(
					'ticket',
					D.ticket,
					D.ticketHelp,
					<div className="space-y-4">
						<CodeBlock code={snippets.ticketNode} />
						<CodeBlock code={snippets.ticketCurl} />
					</div>,
					'key',
				),
				part(
					'site',
					D.site,
					D.siteHelp,
					<div className="space-y-4">
						{SITE_ROUTES.map((entry) => (
							<CodeBlock key={entry.name} code={snippets.site[entry.name] ?? ''} />
						))}
						<CodeBlock code={snippets.productMeta} />
						<CodeBlock code={snippets.listingPage} />
						<CodeBlock code={snippets.policies} />
					</div>,
					'globe',
					<TextLink className="text-sm" href="/docs#catalog-seo">
						{D.catalogSeo}
					</TextLink>,
				),
				part(
					'search-index',
					D.searchIndex,
					fill(D.searchIndexHelp, { collection: 'ss_ecommerce_products' }),
					<CodeBlock code={JSON.stringify(SEARCH_INDEX_DEFINITION, null, 2)} />,
					'database',
					<TextLink className="text-sm" href="/docs#atlas-search">
						{D.searchIndexDocs}
					</TextLink>,
				),
				part('cors', D.cors, D.corsHelp, <CodeBlock code={snippets.cors} />, 'shield'),
			]}
		/>
	);
}

/** Defaults (Owner): the global defaults of the same features and the widget texts. @param {TabProps} props */
const Defaults = (props) => <DefaultsTab {...props} notice={settingsNotice} />;

/** Ecommerce's tabs in place of the standard ones (Features and Prices are the standard tabs). */
export const TABS = Object.freeze({
	overview: Overview,
	settings: SettingsTab,
	developers: Developers,
	defaults: Defaults,
});
