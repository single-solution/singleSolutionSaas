'use client';
/**
 * The signed-in merchant console frame (PLAN 0.6): navigation, the website switcher, balance pill, sign out and the
 * banners, with the Branding.
 * @module
 */
import { usePathname } from 'next/navigation.js';
import { AppShell, Button, Callout, Icon, ToastProvider, formatCredits } from '@ss/ui';
import { MERCHANT } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { WEBSITE_TABS, routes } from '../paths.js';
import { BillingBanner } from './billing.js';
import { accentStyle } from './brand.js';
import { contactLine } from './sign-in.js';

/**
 * @param {{ me: any, merchantId: string | null, websites: any[], billing: any, children: import('react').ReactNode,
 *   notifications?: any[], branding?: { name: string, accent: string, support?: any } }} props
 */
export function ConsoleShell({ me, merchantId, websites, billing, children, notifications = [], branding }) {
	const pathname = usePathname() ?? '';
	const match = /^\/websites\/(web_[0-9a-z]+)(?:\/([a-z-]+))?/.exec(pathname);
	const currentWebsiteId = match?.[1] ?? null;
	const currentTab = match ? (match[2] ?? 'overview') : null;
	const current = websites.find((w) => w.websiteId === currentWebsiteId) ?? null;
	const live = websites.filter((w) => w.env === 'live');
	const merchant = me?.merchant ?? null;
	/** @param {string} href */
	const is = (href) => pathname === href || pathname.startsWith(`${href}/`);

	/** @type {import('@ss/ui').NavSection[]} */
	const sections = [
		{
			label: 'Workspace',
			items: [
				{ href: routes.websites(), label: MERCHANT.menu.websites, icon: 'globe', current: is('/websites') && !current },
				{ href: routes.credits(), label: MERCHANT.menu.usage, icon: 'wallet', current: is('/credits') },
				{ href: routes.account(), label: MERCHANT.menu.account, icon: 'user', current: is('/account') },
			],
		},
	];
	if (current) {
		/** @type {Record<string, import('@ss/ui').IconName>} */
		const icons = { overview: 'grid', products: 'box', usage: 'activity', keys: 'key', resources: 'plug' };
		sections.unshift({
			label: current.env === 'test' ? `${current.domain} · test` : current.domain,
			items: WEBSITE_TABS.map((t) => ({
				href: t.href(current.websiteId),
				label: t.label,
				icon: icons[t.key] ?? 'grid',
				current: currentTab === t.key || (t.key === 'products' && currentTab === 'subscriptions'),
			})),
		});
	}

	/** @param {string} id */
	const switchWebsite = (id) => {
		if (!id) return;
		const tab = WEBSITE_TABS.find((t) => t.key === currentTab) ?? WEBSITE_TABS[0];
		window.location.assign((tab?.href ?? routes.website)(id));
	};
	const signOut = async () => {
		await apiFetch('/v1/auth/sign-out', { method: 'POST', redirectOn401: false });
		window.location.assign(routes.login());
	};

	// the billing banner (low balance, grace, stopped) cannot be dismissed and shows the support contact
	const balanceBanner = <BillingBanner summary={billing} contact={contactLine(branding?.support)} />;
	const hasBalanceBanner = ['low_balance', 'grace', 'stopped'].includes(billing?.status);
	// F.16: a product asks to become a website's identity issuer (approve or reject on Website → Identity)
	const requests = (Array.isArray(notifications) ? notifications : []).filter((n) => n?.kind === 'identity_issuer_request');
	const requestBanner =
		requests.length > 0 ? (
			<Callout
				tone="info"
				title={`${requests[0].request?.product?.name ?? 'A product'} wants to become your identity issuer${
					requests[0].domain ? ` on ${requests[0].domain}` : ''
				}`}
				actions={
					<Link href={routes.identity(requests[0].websiteId)} className="text-sm font-semibold underline">
						Review
					</Link>
				}>
				{requests.length > 1
					? `${requests.length} identity issuer requests are waiting for your decision.`
					: 'Nothing changes until you approve the request.'}
			</Callout>
		) : null;
	const banner =
		hasBalanceBanner || requestBanner ? (
			<div className="space-y-3">
				{hasBalanceBanner ? balanceBanner : null}
				{requestBanner}
			</div>
		) : null;

	const selectClass =
		'min-h-9 max-w-[14rem] truncate rounded-xl border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-fg hover:border-line-strong focus-visible:outline-2 focus-visible:outline-focus';

	return (
		<ToastProvider>
			<div style={accentStyle(branding?.accent)}>
				<AppShell
					brand={{ name: branding?.name ?? 'Single Solution' }}
					linkAs={Link}
					sections={sections}
					banner={banner}
					topbar={
						<>
							<span className="truncate px-1 text-sm font-bold text-fg">{merchant?.name ?? merchantId}</span>
							{live.length > 0 ? (
								<>
									<Icon name="chevronRight" size={14} className="text-muted" />
									<label className="flex items-center gap-2">
										<span className="sr-only">Website</span>
										<select
											className={selectClass}
											value={current ? (current.env === 'live' ? current.websiteId : current.twinId) : ''}
											onChange={(e) => switchWebsite(e.currentTarget.value)}>
											<option value="">All websites</option>
											{live.map((w) => (
												<option key={w.websiteId} value={w.websiteId}>
													{w.domain}
												</option>
											))}
										</select>
									</label>
								</>
							) : null}
						</>
					}
					actions={
						<>
							{billing && typeof billing.balance === 'number' ? (
								<Link
									href={routes.credits()}
									className="hidden items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-sm font-semibold text-fg hover:border-line-strong sm:inline-flex"
									title="Credit balance">
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
						<div className="rounded-xl border border-line bg-surface-2 p-3 text-xs">
							<p className="truncate font-semibold text-fg">{merchant?.email}</p>
						</div>
					}>
					{children}
				</AppShell>
			</div>
		</ToastProvider>
	);
}
