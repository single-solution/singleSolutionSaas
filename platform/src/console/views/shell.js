'use client';
/**
 * The signed-in merchant console frame (PLAN 0.6, premium layout 2026-10-16): the menu Overview · Websites · Usage and
 * credits · Account, the website switcher (in the sidebar, in the header on phones), the balance chip and the account
 * menu (My account, Sign out) in the header, help and account at the bottom of the sidebar, and the billing banner,
 * with the Branding. The frame is the console's
 * layout, so it stays across navigations: pages hand it their fresh billing summary (frame-billing.js). The public
 * account pages render without it.
 * @module
 */
import { usePathname, useRouter } from 'next/navigation.js';
import { useEffect, useState, useTransition } from 'react';
import { AccountMenu, AppShell, Icon, Select, ToastProvider, formatCredits, useNavigationProgress } from '@ss/ui';
import { MERCHANT } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link, NavLink } from '../link.js';
import { PUBLIC_PATHS, api, routes } from '../paths.js';
import { BillingBanner } from './billing.js';
import { accentStyle } from './brand.js';
import { BillingContext } from './frame-billing.js';
import { FrameFooter } from './frame-footer.js';
import { contactLine } from './sign-in.js';

/**
 * The merchant menu with the current entry marked.
 * @param {string} pathname
 * @returns {import('@ss/ui').NavSection[]}
 */
export const merchantSections = (pathname) => {
	/** @param {string} href */
	const is = (href) => pathname === href || pathname.startsWith(`${href}/`);
	return [
		{
			label: '',
			items: [
				{
					href: routes.overview(),
					label: MERCHANT.menu.overview,
					kind: 'overview',
					icon: 'home',
					current: is(routes.overview()),
				},
				{
					href: routes.websites(),
					label: MERCHANT.menu.websites,
					kind: 'website',
					icon: 'globe',
					current: is(routes.websites()),
				},
				{ href: routes.credits(), label: MERCHANT.menu.usage, kind: 'credit', icon: 'wallet', current: is(routes.credits()) },
				{
					href: routes.account(),
					label: MERCHANT.menu.account,
					kind: 'merchant',
					icon: 'user',
					current: is(routes.account()),
				},
			],
		},
	];
};

/**
 * The website switcher: a select of the merchant's websites, "All websites" first.
 * @param {{ websites: any[], current: string, disabled: boolean, onPick: (next: string) => void, className?: string }} props
 */
function WebsiteSwitcher({ websites, current, disabled, onPick, className }) {
	return (
		<Select
			label={MERCHANT.website}
			hideLabel
			fieldClassName={className ?? 'w-full'}
			className="truncate font-medium"
			value={current}
			disabled={disabled}
			options={[{ value: '', label: MERCHANT.allWebsites }, ...websites.map((w) => ({ value: w.websiteId, label: w.domain }))]}
			onChange={(e) => onPick(e.currentTarget.value)}
		/>
	);
}

/**
 * @param {{ me: any, merchantId: string | null, websites: any[], billing: any, children: import('react').ReactNode,
 *   branding: { name: string, accent: string, support?: any } }} props
 */
export function ConsoleShell({ me, merchantId, websites, billing: frameBilling, children, branding }) {
	const pathname = usePathname() ?? '';
	const router = useRouter();
	const [switching, startSwitch] = useTransition();
	useNavigationProgress(switching);
	const [billing, setBilling] = useState(frameBilling);
	useEffect(() => setBilling(frameBilling), [frameBilling]);
	if (PUBLIC_PATHS.includes(pathname)) return children;
	const currentWebsiteId = /^\/websites\/([^/?#]+)/.exec(pathname)?.[1] ?? '';
	const merchant = me?.merchant ?? null;
	const signOut = async () => {
		await apiFetch(api.signOut(), { method: 'POST', redirectOn401: false });
		window.location.assign(routes.login());
	};
	/** @param {string} next */
	const pickWebsite = (next) => startSwitch(() => router.push(next ? routes.website(next) : routes.websites()));
	const helpChannel = branding.support?.channels?.[0];
	const accountName = merchant?.ownerName || merchant?.name || merchant?.email || '';
	/** @type {import('@ss/ui').MenuItem[]} */
	const accountItems = [
		{ label: MERCHANT.menu.account, onSelect: () => router.push(routes.account()) },
		{ label: MERCHANT.signOut, onSelect: () => void signOut(), danger: true },
	];

	return (
		<BillingContext.Provider value={setBilling}>
			<ToastProvider>
				<div style={accentStyle(branding.accent)}>
					<AppShell
						brand={{ name: branding.name }}
						linkAs={NavLink}
						sections={merchantSections(pathname)}
						banner={<BillingBanner summary={billing} contact={contactLine(branding.support)} />}
						switcher={
							websites.length > 0 ? (
								<WebsiteSwitcher
									websites={websites}
									current={currentWebsiteId}
									disabled={switching}
									onPick={pickWebsite}
								/>
							) : null
						}
						topbar={
							<>
								<span
									title={merchant?.name ?? merchantId}
									className="min-w-0 truncate px-1 text-sm font-semibold text-fg">
									{merchant?.name ?? merchantId}
								</span>
								{websites.length > 0 ? (
									<span className="min-w-0 flex-1 lg:hidden">
										<WebsiteSwitcher
											websites={websites}
											current={currentWebsiteId}
											disabled={switching}
											onPick={pickWebsite}
											className="w-full min-w-28 max-w-[14rem]"
										/>
									</span>
								) : null}
							</>
						}
						actions={
							<>
								{billing && typeof billing.balance === 'number' ? (
									<Link
										href={routes.credits()}
										className="ss-motion hidden h-9 items-center gap-1.5 rounded-control bg-primary-soft px-3 text-sm font-semibold text-on-primary-soft hover:bg-surface-3 sm:inline-flex"
										title={MERCHANT.balanceLink}>
										<Icon name="wallet" size={14} />
										<span className="tabular-nums">{formatCredits(billing.balance)}</span>
									</Link>
								) : null}
								<AccountMenu
									name={accountName}
									{...(merchant?.email ? { email: merchant.email } : {})}
									items={accountItems}
									label={MERCHANT.accountMenu}
									compact
								/>
							</>
						}
						sidebarFooter={({ rail }) => (
							<FrameFooter
								rail={rail}
								help={helpChannel ? { label: MERCHANT.help, url: helpChannel.url } : null}
								account={{ name: accountName, email: merchant?.email, label: MERCHANT.accountMenu, items: accountItems }}
							/>
						)}>
						{children}
					</AppShell>
				</div>
			</ToastProvider>
		</BillingContext.Provider>
	);
}
