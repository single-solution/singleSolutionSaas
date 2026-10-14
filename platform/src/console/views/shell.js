'use client';
/**
 * The signed-in merchant console frame (PLAN 0.6): the menu Overview · Websites · Usage and credits · Account, the
 * website switcher, the balance, sign out and the billing banner, with the Branding. The frame is the console's
 * layout, so it stays across navigations: pages hand it their fresh billing summary (frame-billing.js). The public
 * account pages render without it.
 * @module
 */
import { usePathname, useRouter } from 'next/navigation.js';
import { useEffect, useState, useTransition } from 'react';
import { AppShell, Button, Icon, Select, ToastProvider, formatCredits, useNavigationProgress } from '@ss/ui';
import { MERCHANT } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link, NavLink } from '../link.js';
import { PUBLIC_PATHS, api, routes } from '../paths.js';
import { BillingBanner } from './billing.js';
import { accentStyle } from './brand.js';
import { BillingContext } from './frame-billing.js';
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
 * @param {{ me: any, merchantId: string | null, websites: any[], billing: any, children: import('react').ReactNode,
 *   branding?: { name: string, accent: string, support?: any } }} props
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

	return (
		<BillingContext.Provider value={setBilling}>
			<ToastProvider>
				<div style={accentStyle(branding?.accent)}>
					<AppShell
						brand={{ name: branding?.name ?? 'Single Solution' }}
						linkAs={NavLink}
						sections={merchantSections(pathname)}
						banner={<BillingBanner summary={billing} contact={contactLine(branding?.support)} />}
						topbar={
							<>
								<span
									title={merchant?.name ?? merchantId}
									className="hidden min-w-0 truncate px-1 text-sm font-semibold text-fg sm:block">
									{merchant?.name ?? merchantId}
								</span>
								{websites.length > 0 ? (
									<Select
										label={MERCHANT.website}
										hideLabel
										fieldClassName="w-full min-w-32 max-w-[11rem] sm:max-w-[14rem]"
										className="truncate font-medium"
										value={currentWebsiteId}
										disabled={switching}
										options={[
											{ value: '', label: MERCHANT.allWebsites },
											...websites.map((w) => ({ value: w.websiteId, label: w.domain })),
										]}
										onChange={(e) => {
											const next = e.currentTarget.value ? routes.website(e.currentTarget.value) : routes.websites();
											startSwitch(() => router.push(next));
										}}
									/>
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
								<Button variant="ghost" size="sm" onClick={signOut} icon={<Icon name="logout" size={14} />}>
									<span className="hidden sm:inline">{MERCHANT.signOut}</span>
									<span className="sr-only sm:hidden">{MERCHANT.signOut}</span>
								</Button>
							</>
						}
						sidebarFooter={
							<div className="rounded-xl bg-surface-2 p-3 text-xs">
								<p className="truncate font-semibold text-fg">{merchant?.email}</p>
							</div>
						}>
						{children}
					</AppShell>
				</div>
			</ToastProvider>
		</BillingContext.Provider>
	);
}
