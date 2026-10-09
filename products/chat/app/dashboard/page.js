'use client';
/**
 * The product dashboard (PLAN 0.4.3): one page, opened from the Portal (`/sso` → `/dashboard?websiteId=…`), with the
 * left sidebar Overview · Features · Settings · Connections · Developers, plus Defaults and Prices for Owners. Admins
 * get the website switcher and the `Admin view` banner; everyone gets Back to Portal. Setup only: it calls the kit's
 * dashboard API and shows no business data (no conversations, no leads).
 * @module
 */
import { useEffect, useState } from 'react';
import { AppShell, Callout, Select, Skeleton, describeProblem } from '@ss/ui';
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

export default function Dashboard() {
	const [query, setQuery] = useState(/** @type {{ websiteId: string | null, view: string | null } | null} */ (null));
	const [session, setSession] = useState(/** @type {import('./api.js').Answer | null} */ (null));
	useEffect(() => {
		const found = new URLSearchParams(window.location.search);
		setQuery({ websiteId: found.get('websiteId'), view: found.get('view') });
		void call('GET', '/v1/dashboard/session').then(setSession);
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
		<AppShell
			brand={{ name: branding.name, tagline: TEXTS.title }}
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
					onChange={(event) => {
						window.location.search = href(needsWebsite ? view : 'overview', event.target.value);
					}}
				/>
			}
			actions={
				<a className="text-sm font-semibold text-primary" href={portalUrl}>
					{TEXTS.backToPortal}
				</a>
			}
			banner={
				admin && site ? (
					<Callout tone="info">{fill(TEXTS.adminView, { merchant: site.merchantName, domain: site.domain })}</Callout>
				) : null
			}>
			{needsWebsite && !site ? (
				<Callout tone="info">{TEXTS.pickWebsite}</Callout>
			) : (
				<Tab websiteId={site ? site.websiteId : null} who={who} support={support} portal={portalUrl} />
			)}
		</AppShell>
	);
}
