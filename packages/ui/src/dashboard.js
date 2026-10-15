'use client';
/**
 * `@ss/ui/dashboard` — the product dashboard (PLAN 0.4.3), one for every product: one page, opened from the Portal
 * (`/sso` → `/dashboard?websiteId=…`), with the left sidebar Overview · Features · Settings · Connections ·
 * Developers, plus Defaults and Prices for Owners. Admins get the website switcher's merchant names and the `Admin
 * view` banner; everyone gets Back to Portal. Setup only: it calls the kit's dashboard API and shows no business data.
 *
 * Sections and websites switch inside the page (the address follows; Back and Forward work): the session is loaded
 * once, the menu marks the new section at once, and its content cross-fades in, showing its last answer at once
 * (refreshed in the background) or its skeleton (PLAN 0.6 motion).
 *
 * A product's `app/dashboard/page.js` renders `<ProductDashboard manifest texts tabs?>` with its manifest, its words
 * (`dashboardTexts`) and the tabs it fills in or adds; its own tabs are built from the pieces exported here.
 * @module
 */
import { createContext, startTransition, useCallback, useContext, useEffect, useState } from 'react';
import { AppShell } from './AppShell.js';
import { Callout, Skeleton } from './display.js';
import { Select } from './fields.js';
import { SwapTransition } from './motion.js';
import { describeProblem } from './problems.js';
import { call, fill } from './dashboard-api.js';
import { DashboardProvider, useDashboard } from './dashboard-parts.js';
import {
	ConnectionsTab,
	DefaultsTab,
	DevelopersTab,
	FeaturesTab,
	OverviewTab,
	PricesTab,
	SettingsTab,
} from './dashboard-tabs.js';

export { call, fill, useLoad } from './dashboard-api.js';
export { DASHBOARD_TEXTS, dashboardTexts } from './dashboard-texts.js';
export {
	DashboardProvider,
	FormatForm,
	Loaded,
	Outcome,
	ResealCard,
	SettingsForms,
	TextsForm,
	ThemeForm,
	hasSettings,
	toneOf,
	useDashboard,
	withDependents,
} from './dashboard-parts.js';
export { ConnectionsTab, DefaultsTab, DevelopersTab, FeaturesTab, OverviewTab, PricesTab, SettingsTab };

/** @typedef {import('./dashboard-api.js').Answer} Answer */
/** @typedef {import('./dashboard-parts.js').DashboardManifest} DashboardManifest */
/** @typedef {import('./dashboard-parts.js').FeatureSettings} FeatureSettings */
/** @typedef {import('./dashboard-parts.js').SettingsNotice} SettingsNotice */
/** @typedef {import('./dashboard-tabs.js').TabProps} TabProps */
/** @typedef {import('./dashboard-tabs.js').Who} Who */
/** @typedef {import('./dashboard-tabs.js').Feature} Feature */
/** @typedef {import('./dashboard-tabs.js').Connection} Connection */
/** @typedef {import('./dashboard-tabs.js').OverviewMore} OverviewMore */
/** @typedef {import('./dashboard-tabs.js').UseOverviewMore} UseOverviewMore */
/** @typedef {import('react').ComponentType<TabProps>} TabComponent */
/**
 * A sidebar tab: its section, its icon and kind (the kind gives its color, PLAN 0.6 color rule), and whether it is an
 * Owner tab that needs no website (`global`). Its label is `texts.tabs[key]`.
 * @typedef {{ component: TabComponent, icon: import('./icons.js').IconName, kind: import('./display.js').Kind,
 *   global?: boolean }} TabSpec
 */

/**
 * The standard tabs in sidebar order: the five of every website, then the Owner's.
 * @type {ReadonlyArray<[string, TabSpec]>}
 */
const STANDARD_TABS = [
	['overview', { component: OverviewTab, icon: 'home', kind: 'overview' }],
	['features', { component: FeaturesTab, icon: 'zap', kind: 'feature' }],
	['settings', { component: SettingsTab, icon: 'sliders', kind: 'settings' }],
	['connections', { component: ConnectionsTab, icon: 'plug', kind: 'connection' }],
	['developers', { component: DevelopersTab, icon: 'code', kind: 'developer' }],
	['defaults', { component: DefaultsTab, icon: 'layers', kind: 'default', global: true }],
	['prices', { component: PricesTab, icon: 'coins', kind: 'price', global: true }],
];

/**
 * The tabs of a product: the standard ones with the product's own sections in their place, then its new tabs (a
 * website's before the Owner tabs).
 * @param {Record<string, TabComponent | TabSpec>} own
 * @returns {Array<[string, TabSpec]>}
 */
const tabsOf = (own) => {
	const found = new Map(STANDARD_TABS);
	for (const [key, value] of Object.entries(own)) {
		const standard = found.get(key);
		if (typeof value === 'function') {
			if (!standard) throw new Error(`ProductDashboard: the new tab “${key}” needs { component, icon, kind }`);
			found.set(key, { ...standard, component: value });
		} else found.set(key, value);
	}
	const all = [...found];
	return [...all.filter(([, tab]) => !tab.global), ...all.filter(([, tab]) => tab.global)];
};

/**
 * The website and tab of a dashboard address.
 * @param {string} search
 * @returns {{ websiteId: string | null, view: string | null }}
 */
const queryOf = (search) => {
	const found = new URLSearchParams(search);
	return { websiteId: found.get('websiteId'), view: found.get('view') };
};

/** Opens a dashboard address inside the page. */
const GoContext = createContext(/** @type {(href: string) => void} */ (() => undefined));

/**
 * A menu link that switches the section inside the page; a new tab or window still opens its address.
 * @param {{ href: string, onClick?: (event: import('react').MouseEvent<HTMLAnchorElement>) => void,
 *   children?: import('react').ReactNode, [prop: string]: unknown }} props
 */
function SectionLink({ href, onClick, children, ...rest }) {
	const go = useContext(GoContext);
	return (
		<a
			{...rest}
			href={href}
			onClick={(event) => {
				onClick?.(event);
				if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
					return;
				event.preventDefault();
				go(href);
			}}>
			{children}
		</a>
	);
}

/**
 * The whole dashboard of a product: its manifest (feature names), its words (`dashboardTexts`: the title and its own
 * words over the shared ones) and its tabs — a standard tab's key with a component puts the product's section in its
 * place (often the standard tab with the product's props); a new key with `{ component, icon, kind, global? }` adds a
 * tab (its label in `texts.tabs`).
 * @param {{ manifest: DashboardManifest, texts: { title: string } & Record<string, any>,
 *   tabs?: Record<string, TabComponent | TabSpec> }} props
 */
export function ProductDashboard({ manifest, texts, tabs = {} }) {
	return (
		<DashboardProvider manifest={manifest} texts={texts}>
			<DashboardPage tabs={tabs} />
		</DashboardProvider>
	);
}

/**
 * The page inside the provider: the session, the address, the sidebar and the section shown.
 * @param {{ tabs: Record<string, TabComponent | TabSpec> }} props
 */
function DashboardPage({ tabs: own }) {
	const { texts } = useDashboard();
	const [query, setQuery] = useState(/** @type {{ websiteId: string | null, view: string | null } | null} */ (null));
	const [session, setSession] = useState(/** @type {Answer | null} */ (null));
	useEffect(() => {
		setQuery(queryOf(window.location.search));
		void call('GET', '/v1/dashboard/session').then(setSession);
		const moved = () => startTransition(() => setQuery(queryOf(window.location.search)));
		window.addEventListener('popstate', moved);
		return () => window.removeEventListener('popstate', moved);
	}, []);
	const go = useCallback((/** @type {string} */ href) => {
		window.history.pushState(null, '', href);
		startTransition(() => setQuery(queryOf(window.location.search)));
	}, []);

	if (!query || !session) return <Skeleton className="m-8" lines={4} label={texts.loading} />;
	if (!session.ok)
		return (
			<main className="mx-auto max-w-xl p-8">
				<Callout tone="danger" title={texts.failed}>
					{session.problem?.status === 401 ? texts.signedOut : describeProblem(session.problem)}
				</Callout>
			</main>
		);

	/** @type {{ who: Who, portalUrl: string, branding: { name: string }, support: { email: string, phone: string }, switcher: Array<{ merchantName: string, websites: Array<{ websiteId: string, domain: string }> }> }} */
	const { who, portalUrl, branding, support, switcher } = session.data;
	const admin = who.kind === 'admin';
	const owner = admin && who.role === 'owner';
	const shown = tabsOf(own).filter(([, tab]) => owner || !tab.global);
	const keys = shown.map(([key]) => key);
	const view = query.view && keys.includes(query.view) ? query.view : query.websiteId || !owner ? 'overview' : 'defaults';
	const sites = switcher.flatMap((group) => group.websites.map((site) => ({ ...site, merchantName: group.merchantName })));
	const site = sites.find((entry) => entry.websiteId === query.websiteId) ?? null;
	/** @param {string} tab @param {string | null} [websiteId] */
	const href = (tab, websiteId = query.websiteId) =>
		`?${new URLSearchParams({ ...(websiteId ? { websiteId } : {}), view: tab }).toString()}`;
	const current = /** @type {TabSpec} */ (shown.find(([key]) => key === view)?.[1]);
	const Tab = current.component;
	const needsWebsite = !current.global;

	return (
		<GoContext.Provider value={go}>
			<AppShell
				brand={{ name: branding.name, tagline: texts.title }}
				linkAs={SectionLink}
				sections={[
					{
						items: shown.map(([key, tab]) => ({
							href: href(key),
							label: /** @type {Record<string, string>} */ (texts.tabs)[key] ?? key,
							icon: tab.icon,
							kind: tab.kind,
							current: key === view,
						})),
					},
				]}
				topbar={
					<Select
						label={texts.website}
						hideLabel
						value={site ? site.websiteId : ''}
						placeholder={texts.pickWebsite}
						options={sites.map((entry) => ({
							value: entry.websiteId,
							label: admin ? `${entry.merchantName} / ${entry.domain}` : entry.domain,
						}))}
						onChange={(event) => go(href(needsWebsite ? view : 'overview', event.target.value))}
					/>
				}
				actions={
					<a className="ss-motion text-sm font-semibold text-primary hover:underline" href={portalUrl}>
						{texts.backToPortal}
					</a>
				}
				banner={
					admin && site ? (
						<Callout tone="info">{fill(texts.adminView, { merchant: site.merchantName, domain: site.domain })}</Callout>
					) : null
				}>
				<SwapTransition id={`${view}|${site ? site.websiteId : ''}`}>
					{needsWebsite && !site ? (
						<Callout tone="info">{texts.pickWebsite}</Callout>
					) : (
						<Tab
							websiteId={site ? site.websiteId : null}
							domain={site ? site.domain : ''}
							who={who}
							support={support}
							portal={portalUrl}
							open={(tab) => go(href(tab))}
						/>
					)}
				</SwapTransition>
			</AppShell>
		</GoContext.Provider>
	);
}
