'use client';
/**
 * The product dashboard (PLAN 0.4.3): one page, opened from the Portal (`/sso` → `/dashboard?websiteId=…`), with the
 * left sidebar Overview · Features · Settings · Connections · Developers, plus Defaults and Prices for Owners. Admins
 * get the website switcher and the `Admin view` banner; everyone gets Back to Portal. Setup only: it calls the kit's
 * dashboard API and shows no business data.
 *
 * Sections and websites switch inside the page (the address follows; Back and Forward work): the session is loaded
 * once, the menu marks the new section at once, and its content cross-fades in, showing its last answer at once
 * (refreshed in the background) or its skeleton (PLAN 0.6 motion).
 * @module
 */
import { createContext, startTransition, useCallback, useContext, useEffect, useState } from 'react';
import { AppShell, Callout, Select, Skeleton, SwapTransition, describeProblem } from '@ss/ui';
import { call, fill } from './api.js';
import { TABS } from './tabs.js';
import { TEXTS } from './texts.js';

/**
 * Sidebar icon and kind of each tab: the kind gives its colour, the same in every product (PLAN 0.6 colour rule).
 * @type {{ [tab in keyof typeof TABS]: { icon: import('@ss/ui').IconName, kind: import('@ss/ui').Kind } }}
 */
const TAB_ICONS = {
	overview: { icon: 'home', kind: 'overview' },
	features: { icon: 'zap', kind: 'feature' },
	settings: { icon: 'sliders', kind: 'settings' },
	connections: { icon: 'plug', kind: 'connection' },
	developers: { icon: 'code', kind: 'developer' },
	defaults: { icon: 'layers', kind: 'default' },
	prices: { icon: 'coins', kind: 'price' },
};

/** Tabs that need no picked website (Owner only). */
const GLOBAL_TABS = ['defaults', 'prices'];

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

export default function Dashboard() {
	const [query, setQuery] = useState(/** @type {{ websiteId: string | null, view: string | null } | null} */ (null));
	const [session, setSession] = useState(/** @type {import('./api.js').Answer | null} */ (null));
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

	if (!query || !session) return <Skeleton className="m-8" lines={4} label={TEXTS.loading} />;
	if (!session.ok)
		return (
			<main className="mx-auto max-w-xl p-8">
				<Callout tone="danger" title={TEXTS.failed}>
					{session.problem?.status === 401 ? TEXTS.signedOut : describeProblem(session.problem)}
				</Callout>
			</main>
		);

	/** @type {{ who: { kind: 'merchant' | 'admin', id: string, name: string, role?: 'owner' | 'support' }, portalUrl: string, branding: { name: string }, support: { email: string, phone: string }, switcher: Array<{ merchantName: string, websites: Array<{ websiteId: string, domain: string }> }> }} */
	const { who, portalUrl, branding, support, switcher } = session.data;
	const admin = who.kind === 'admin';
	const owner = admin && who.role === 'owner';
	const tabs = Object.keys(TABS).filter((tab) => owner || !GLOBAL_TABS.includes(tab));
	const view = query.view && tabs.includes(query.view) ? query.view : query.websiteId || !owner ? 'overview' : 'defaults';
	const sites = switcher.flatMap((group) => group.websites.map((site) => ({ ...site, merchantName: group.merchantName })));
	const site = sites.find((entry) => entry.websiteId === query.websiteId) ?? null;
	/** @param {string} tab @param {string | null} [websiteId] */
	const href = (tab, websiteId = query.websiteId) =>
		`?${new URLSearchParams({ ...(websiteId ? { websiteId } : {}), view: tab }).toString()}`;
	const Tab = TABS[/** @type {keyof typeof TABS} */ (view)];
	const needsWebsite = !GLOBAL_TABS.includes(view);

	return (
		<GoContext.Provider value={go}>
			<AppShell
				brand={{ name: branding.name, tagline: TEXTS.title }}
				linkAs={SectionLink}
				sections={[
					{
						items: tabs.map((tab) => ({
							href: href(tab),
							label: TEXTS.tabs[/** @type {keyof typeof TEXTS.tabs} */ (tab)],
							icon: TAB_ICONS[/** @type {keyof typeof TAB_ICONS} */ (tab)].icon,
							kind: TAB_ICONS[/** @type {keyof typeof TAB_ICONS} */ (tab)].kind,
							current: tab === view,
						})),
					},
				]}
				topbar={
					<Select
						label={TEXTS.website}
						hideLabel
						value={site ? site.websiteId : ''}
						placeholder={TEXTS.pickWebsite}
						options={sites.map((entry) => ({
							value: entry.websiteId,
							label: admin ? `${entry.merchantName} / ${entry.domain}` : entry.domain,
						}))}
						onChange={(event) => go(href(needsWebsite ? view : 'overview', event.target.value))}
					/>
				}
				actions={
					<a className="ss-motion text-sm font-semibold text-primary hover:underline" href={portalUrl}>
						{TEXTS.backToPortal}
					</a>
				}
				banner={
					admin && site ? (
						<Callout tone="info">{fill(TEXTS.adminView, { merchant: site.merchantName, domain: site.domain })}</Callout>
					) : null
				}>
				<SwapTransition id={`${view}|${site ? site.websiteId : ''}`}>
					{needsWebsite && !site ? (
						<Callout tone="info">{TEXTS.pickWebsite}</Callout>
					) : (
						<Tab websiteId={site ? site.websiteId : null} who={who} support={support} portal={portalUrl} />
					)}
				</SwapTransition>
			</AppShell>
		</GoContext.Provider>
	);
}
