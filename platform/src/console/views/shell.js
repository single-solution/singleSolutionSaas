'use client';
/**
 * The signed-in merchant console frame (PLAN 0.6): the menu Overview · Websites · Usage and credits · Account, the
 * website switcher, the balance, sign out and the billing banner, with the Branding.
 * @module
 */
import { usePathname } from 'next/navigation.js';
import { AppShell, Button, Icon, ToastProvider, formatCredits } from '@ss/ui';
import { MERCHANT } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { api, routes } from '../paths.js';
import { BillingBanner } from './billing.js';
import { accentStyle } from './brand.js';
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
				{ href: routes.overview(), label: MERCHANT.menu.overview, icon: 'grid', current: is(routes.overview()) },
				{ href: routes.websites(), label: MERCHANT.menu.websites, icon: 'globe', current: is(routes.websites()) },
				{ href: routes.credits(), label: MERCHANT.menu.usage, icon: 'wallet', current: is(routes.credits()) },
				{ href: routes.account(), label: MERCHANT.menu.account, icon: 'user', current: is(routes.account()) },
			],
		},
	];
};

/**
 * @param {{ me: any, merchantId: string | null, websites: any[], billing: any, children: import('react').ReactNode,
 *   branding?: { name: string, accent: string, support?: any } }} props
 */
export function ConsoleShell({ me, merchantId, websites, billing, children, branding }) {
	const pathname = usePathname() ?? '';
	const currentWebsiteId = /^\/websites\/([^/?#]+)/.exec(pathname)?.[1] ?? '';
	const merchant = me?.merchant ?? null;
	const signOut = async () => {
		await apiFetch(api.signOut(), { method: 'POST', redirectOn401: false });
		window.location.assign(routes.login());
	};
	const selectClass =
		'min-h-9 max-w-[11rem] truncate rounded-xl bg-surface-2 px-3 py-1.5 text-sm font-semibold text-fg hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-focus sm:max-w-[14rem]';

	return (
		<ToastProvider>
			<div style={accentStyle(branding?.accent)}>
				<AppShell
					brand={{ name: branding?.name ?? 'Single Solution' }}
					linkAs={Link}
					sections={merchantSections(pathname)}
					banner={<BillingBanner summary={billing} contact={contactLine(branding?.support)} />}
					topbar={
						<>
							<span className="hidden truncate px-1 text-sm font-bold text-fg sm:inline">
								{merchant?.name ?? merchantId}
							</span>
							{websites.length > 0 ? (
								<label className="flex min-w-0 items-center gap-2">
									<span className="sr-only">{MERCHANT.website}</span>
									<select
										className={selectClass}
										value={currentWebsiteId}
										onChange={(e) =>
											window.location.assign(
												e.currentTarget.value ? routes.website(e.currentTarget.value) : routes.websites(),
											)
										}>
										<option value="">{MERCHANT.allWebsites}</option>
										{websites.map((w) => (
											<option key={w.websiteId} value={w.websiteId}>
												{w.domain}
											</option>
										))}
									</select>
								</label>
							) : null}
						</>
					}
					actions={
						<>
							{billing && typeof billing.balance === 'number' ? (
								<Link
									href={routes.credits()}
									className="hidden items-center gap-1.5 rounded-xl bg-tint-indigo px-3 py-1.5 text-sm font-semibold text-fg hover:bg-primary-soft sm:inline-flex"
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
						<div className="rounded-2xl bg-surface-2 p-3 text-xs">
							<p className="truncate font-semibold text-fg">{merchant?.email}</p>
						</div>
					}>
					{children}
				</AppShell>
			</div>
		</ToastProvider>
	);
}
