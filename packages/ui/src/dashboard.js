'use client';
/**
 * `@ss/ui/dashboard` — the product dashboard (PLAN 0.4.3), one for every product: one page, opened from the Portal
 * (`/sso` → `/dashboard?websiteId=…`), with the left sidebar Overview · Features · Settings · Texts · Connections ·
 * Developers, plus Defaults and Prices for Owners. The look, the Format and the business facts are not here: they are the
 * Portal's Website settings, shown read-only where a value is used (`ManagedNote`) with a link to the place to change it.
 * Every tab draws a `Page` (layout contract 2026-10-17: the breadcrumbs `Product › Section › sub-page` are its title, the
 * old descriptions sit behind its (i)); a tab with sub-pages uses `SectionsPage` (an inner navigation, each sub-page its
 * own `#address`). Admins get the website switcher's merchant names and a small "Viewing as admin" note; everyone gets
 * the docs and Back to Portal; all three sit at the bottom of the sidebar. Saved and errors show as toasts at the bottom
 * right. Setup only: it calls the kit's dashboard API and shows no business data.
 *
 * Sections and websites switch inside the page (the address follows; Back and Forward work): the session is loaded
 * once, the menu marks the new section at once, and its content cross-fades in, showing its last answer at once
 * (refreshed in the background) or its skeleton (PLAN 0.6 motion).
 *
 * A product's `app/dashboard/page.js` renders `<ProductDashboard manifest texts tabs?>` with its manifest, its words
 * (`dashboardTexts` from `@ss/ui`) and the tabs it fills in or adds; its own tabs are built from the pieces exported
 * here.
 * @module
 */
import { createContext, startTransition, useCallback, useContext, useEffect, useState } from 'react';
import { AppShell, SwitcherSelect } from './AppShell.js';
import { cx } from './cx.js';
import { Callout, EmptyState } from './display.js';
import { Icon } from './icons.js';
import { SwapTransition } from './motion.js';
import { PageSkeleton } from './skeletons.js';
import { describeProblem } from './problems.js';
import { call, fill, useLoad } from './dashboard-api.js';
import { DisplayLocale } from './time.js';
import { DashboardProvider, useDashboard } from './dashboard-parts.js';
import { FrameContext } from './dashboard-page.js';
import {
	ConnectionsTab,
	DefaultsTab,
	DevelopersTab,
	FeaturesTab,
	OverviewTab,
	PricesTab,
	SettingsTab,
	TextsTab,
} from './dashboard-tabs.js';

export { call, fill, useLoad } from './dashboard-api.js';
export { isFilled, useSetupSteps, wantsSettings } from './dashboard-setup.js';
export {
	DashboardProvider,
	Loaded,
	Outcome,
	ResealCard,
	SaveOutcome,
	SettingsForms,
	TextsForm,
	hasSettings,
	toneOf,
	useDashboard,
	withDependents,
} from './dashboard-parts.js';
export {
	SettingsBar,
	TextsTable,
	featureSections,
	settingSectionOf,
	textGroups,
	textSections,
	useSettingsEditor,
	useTextsEditor,
} from './dashboard-settings.js';
export { FrameContext, SectionsPage, navGroupsOf, pageState, useCrumbs } from './dashboard-page.js';
export { WEBSITE_SECTION_NAMES, websiteSettingsUrl } from './portal-links.js';
export { ConnectionsTab, DefaultsTab, DevelopersTab, FeaturesTab, OverviewTab, PricesTab, SettingsTab, TextsTab };

/** @typedef {import('./dashboard-api.js').Answer} Answer */
/** @typedef {import('./dashboard-parts.js').DashboardManifest} DashboardManifest */
/** @typedef {import('./dashboard-parts.js').FeatureSettings} FeatureSettings */
/** @typedef {import('./dashboard-parts.js').SettingsNotice} SettingsNotice */
/** @typedef {import('./dashboard-parts.js').DashboardCategories} DashboardCategories */
/** @typedef {import('./dashboard-settings.js').FeatureExtra} FeatureExtra */
/** @typedef {import('./dashboard-setup.js').SetupRequirement} SetupRequirement */
/** @typedef {import('./overview.js').SetupStep} SetupStep */
/** @typedef {import('./blocks.js').SectionSpec} SectionSpec */
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
	['texts', { component: TextsTab, icon: 'type', kind: 'settings' }],
	['connections', { component: ConnectionsTab, icon: 'plug', kind: 'connection' }],
	['developers', { component: DevelopersTab, icon: 'code', kind: 'developer' }],
	['defaults', { component: DefaultsTab, icon: 'layers', kind: 'default', global: true }],
	['prices', { component: PricesTab, icon: 'coins', kind: 'price', global: true }],
];

/**
 * The tabs of a product: the standard ones with the product's own sections in their place, then its new tabs (a
 * website's before the Owner tabs). A standard tab set to `null` is not shown (Growth has no provider key, so no
 * Connections tab).
 * @param {Record<string, TabComponent | TabSpec | null>} own
 * @returns {Array<[string, TabSpec]>}
 */
const tabsOf = (own) => {
	const found = new Map(STANDARD_TABS);
	for (const [key, value] of Object.entries(own)) {
		const standard = found.get(key);
		if (value === null) {
			if (!standard) throw new Error(`ProductDashboard: there is no standard tab “${key}” to leave out`);
			found.delete(key);
		} else if (typeof value === 'function') {
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
 * A menu link that switches the section inside the page; a new tab or window still opens its address. A click on a link
 * to a sub-page (`#address`) is handled by the page that owns it.
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
				// a sub-page is opened by the page that owns it (the address is its hash); nothing else to do here
				if (!href.startsWith('#')) go(href);
			}}>
			{children}
		</a>
	);
}

/**
 * The bottom of the sidebar: a note when an admin looks at a merchant's website, then the links the old header held (the
 * docs, Back to Portal). On the icon rail the note hides and each link is its icon.
 * @param {{ rail: boolean, note?: string, links: Array<{ href: string, label: string, icon: import('./icons.js').IconName,
 *   external?: boolean }> }} props
 */
function FrameFooter({ rail, note, links }) {
	return (
		<div className="space-y-1">
			{note && !rail ? <p className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-label text-muted">{note}</p> : null}
			{links.map((link) => (
				<a
					key={link.href}
					href={link.href}
					title={link.label}
					{...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
					className={cx(
						'ss-motion ss-press flex h-9 items-center gap-2.5 rounded-lg text-sm font-medium text-fg/80 hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus',
						rail ? 'justify-center' : 'px-2.5',
					)}>
					<span aria-hidden="true" className="text-muted">
						<Icon name={link.icon} size={17} />
					</span>
					<span className={rail ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{link.label}</span>
				</a>
			))}
		</div>
	);
}

/**
 * The picked website's dates and numbers in its Format's `locale` (fixed-choices audit K2; the words stay US English);
 * US English on the global tabs and until the Format is read.
 * @param {{ websiteId: string | null, children: import('react').ReactNode }} props
 */
function WebsiteLocale({ websiteId, children }) {
	const format = useLoad(websiteId ? `/v1/dashboard/websites/${websiteId}/format` : null);
	const locale = format.answer?.ok ? /** @type {{ format?: { locale?: string } }} */ (format.answer.data).format?.locale : '';
	return <DisplayLocale locale={locale}>{children}</DisplayLocale>;
}

/**
 * The whole dashboard of a product: its manifest (feature names), its words (`dashboardTexts`: the title and its own
 * words over the shared ones) and its tabs — a standard tab's key with a component puts the product's section in its
 * place (often the standard tab with the product's props); a new key with `{ component, icon, kind, global? }` adds a
 * tab (its label in `texts.tabs`).
 * `categories` groups the features for the Features and Settings sidebars (most used first).
 * @param {{ manifest: DashboardManifest, texts: { title: string } & Record<string, any>, categories?: DashboardCategories,
 *   tabs?: Record<string, TabComponent | TabSpec | null> }} props
 */
export function ProductDashboard({ manifest, texts, categories, tabs = {} }) {
	return (
		<DashboardProvider manifest={manifest} texts={texts} {...(categories ? { categories } : {})}>
			<DashboardPage tabs={tabs} {...(manifest.id ? { product: manifest.id } : {})} />
		</DashboardProvider>
	);
}

/**
 * The page inside the provider: the session, the address, the sidebar and the section shown. `product` (the manifest's
 * id) gives the sidebar's mark the product's meaning color.
 * @param {{ tabs: Record<string, TabComponent | TabSpec | null>, product?: string }} props
 */
function DashboardPage({ tabs: own, product }) {
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
		const hash = window.location.hash;
		window.history.pushState(null, '', href);
		startTransition(() => setQuery(queryOf(window.location.search)));
		// the page of a tab that is already open follows the sub-page in the new address
		if (window.location.hash !== hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
	}, []);

	if (!query || !session)
		return (
			<div className="flex h-dvh min-h-0 flex-col p-3 lg:p-4">
				<PageSkeleton label={texts.loading} />
			</div>
		);
	if (!session.ok)
		return (
			<main className="mx-auto max-w-xl p-8">
				<Callout tone="danger" title={texts.failed}>
					{session.problem?.status === 401 ? texts.signedOut : describeProblem(session.problem)}
				</Callout>
			</main>
		);

	/** @type {{ who: Who, portalUrl: string, branding: { name: string }, support: { channels: import('./format.js').SupportChannel[] }, switcher: Array<{ merchantId: string, merchantName: string, websites: Array<{ websiteId: string, domain: string }> }> }} */
	const { who, portalUrl, branding, support, switcher } = session.data;
	const admin = who.kind === 'admin';
	const owner = admin && who.role === 'owner';
	const shown = tabsOf(own).filter(([, tab]) => owner || !tab.global);
	const keys = shown.map(([key]) => key);
	const view = query.view && keys.includes(query.view) ? query.view : query.websiteId || !owner ? 'overview' : 'defaults';
	const sites = switcher.flatMap((group) =>
		group.websites.map((site) => ({ ...site, merchantName: group.merchantName, merchantId: group.merchantId })),
	);
	const site = sites.find((entry) => entry.websiteId === query.websiteId) ?? null;
	/** @param {string} tab @param {string | null} [websiteId] */
	const href = (tab, websiteId = query.websiteId) =>
		`?${new URLSearchParams({ ...(websiteId ? { websiteId } : {}), view: tab }).toString()}`;
	const current = /** @type {TabSpec} */ (shown.find(([key]) => key === view)?.[1]);
	const Tab = current.component;
	const needsWebsite = !current.global;

	const picker = (
		<SwitcherSelect
			label={texts.website}
			value={site ? site.websiteId : ''}
			placeholder={texts.pickWebsite}
			options={sites.map((entry) => ({
				value: entry.websiteId,
				label: admin ? `${entry.merchantName} / ${entry.domain}` : entry.domain,
			}))}
			onChange={(next) => go(href(needsWebsite ? view : 'overview', next))}
		/>
	);

	/** The frame around the tab: its addresses keep the picked website. */
	const frame = { hrefOf: (/** @type {string} */ tab) => href(tab), home: href(site || !owner ? 'overview' : 'defaults') };

	return (
		<GoContext.Provider value={go}>
			<FrameContext.Provider value={frame}>
				<AppShell
					brand={{ name: branding.name, tagline: texts.title, ...(product ? { product } : {}) }}
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
					switcher={picker}
					crumbs={[{ label: texts.title }]}
					sidebarFooter={({ rail }) => (
						<FrameFooter
							rail={rail}
							links={[
								{ href: '/docs', label: texts.developers.openDocs, icon: 'help', external: true },
								{ href: portalUrl, label: texts.backToPortal, icon: 'chevronLeft' },
							]}
							{...(admin && site
								? { note: fill(texts.adminView, { merchant: site.merchantName, domain: site.domain }) }
								: {})}
						/>
					)}
					scrollKey={`${view}|${site ? site.websiteId : ''}`}>
					<SwapTransition id={`${view}|${site ? site.websiteId : ''}`}>
						{needsWebsite && !site ? (
							<EmptyState
								icon="globe"
								title={texts.pickWebsite}
								action={<div className="w-64 max-w-full text-left">{picker}</div>}
							/>
						) : (
							<WebsiteLocale websiteId={site ? site.websiteId : null}>
								<Tab
									websiteId={site ? site.websiteId : null}
									merchantId={site ? site.merchantId : null}
									domain={site ? site.domain : ''}
									who={who}
									support={support}
									portal={portalUrl}
									brand={branding.name}
									open={(tab, section) => go(href(tab) + (section ? `#${encodeURIComponent(section)}` : ''))}
								/>
							</WebsiteLocale>
						)}
					</SwapTransition>
				</AppShell>
			</FrameContext.Provider>
		</GoContext.Provider>
	);
}
