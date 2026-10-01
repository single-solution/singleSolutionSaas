'use client';
/**
 * The signed-in console frame: navigation, merchant and website switchers, balance pill, sign out and the
 * low-balance banner.
 * @module
 */
import { usePathname } from 'next/navigation.js';
import { AppShell, Button, Callout, Icon, ToastProvider, formatCredits, formatHours } from '@ss/ui';
import { apiFetch } from '../client.js';
import { Link } from '../link.js';
import { WEBSITE_TABS, routes } from '../paths.js';
import { ImpersonationBanner } from '../admin/views/impersonation.js';

/** Hours of credits left under which the banner warns. */
export const LOW_BALANCE_HOURS = 24;

/**
 * Low-balance state of a meter: `empty` (≤ 0 — everything pauses), `low` (< 24 h at the current burn), or null.
 * @param {any} meter
 * @returns {'empty' | 'low' | null}
 */
export const balanceState = (meter) => {
	if (!meter || typeof meter.balanceMillicredits !== 'number') return null;
	if (meter.balanceMillicredits <= 0 && (meter.burnRatePerHour > 0 || (meter.subscriptions ?? []).length > 0)) return 'empty';
	if (typeof meter.hoursRemaining === 'number' && meter.burnRatePerHour > 0 && meter.hoursRemaining < LOW_BALANCE_HOURS)
		return 'low';
	return null;
};

/**
 * @param {{ me: any, merchantId: string | null, websites: any[], meter: any, children: import('react').ReactNode,
 *   notifications?: any[],
 *   impersonation?: { staffId: string, staffName?: string | null, expiresAt: string | null } | null }} props `impersonation`: the staff member
 *   acting as this user (session `via`) — shown as a banner on every page.
 */
export function ConsoleShell({ me, merchantId, websites, meter, children, impersonation = null, notifications = [] }) {
	const pathname = usePathname() ?? '';
	const match = /^\/websites\/(web_[0-9a-z]+)(?:\/([a-z-]+))?/.exec(pathname);
	const currentWebsiteId = match?.[1] ?? null;
	const currentTab = match ? (match[2] ?? 'overview') : null;
	const current = websites.find((w) => w.websiteId === currentWebsiteId) ?? null;
	const live = websites.filter((w) => w.env === 'live');
	const memberships = /** @type {any[]} */ (me?.memberships ?? []);
	const merchant = memberships.find((m) => m.merchantId === merchantId) ?? null;
	/** @param {string} href */
	const is = (href) => pathname === href || pathname.startsWith(`${href}/`);

	/** @type {import('@ss/ui').NavSection[]} */
	const sections = [
		{
			label: 'Workspace',
			items: [
				{ href: routes.websites(), label: 'Websites', icon: 'globe', current: is('/websites') && !current },
				{ href: routes.credits(), label: 'Credits', icon: 'wallet', current: is('/credits') },
				{ href: routes.spendPolicies(), label: 'Spend policies', icon: 'sliders', current: is('/spend-policies') },
				{ href: routes.team(), label: 'Team', icon: 'users', current: is('/team') },
				{ href: routes.account(), label: 'Account', icon: 'user', current: is('/account') },
			],
		},
	];
	if (current) {
		/** @type {Record<string, import('@ss/ui').IconName>} */
		const icons = { overview: 'grid', products: 'box', usage: 'activity', keys: 'key', resources: 'plug', deliveries: 'send' };
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

	const switchMerchant = async (/** @type {string} */ id) => {
		const result = await apiFetch('/v1/me/merchant', { method: 'POST', body: { merchantId: id } });
		if (result.ok) window.location.assign(routes.websites());
	};
	/** @param {string} id */
	const switchWebsite = (id) => {
		if (!id) return;
		const tab = WEBSITE_TABS.find((t) => t.key === currentTab) ?? WEBSITE_TABS[0];
		window.location.assign((tab?.href ?? routes.website)(id));
	};
	const signOut = async () => {
		await apiFetch('/v1/auth/merchant/logout', { method: 'POST', redirectOn401: false });
		window.location.assign(routes.login());
	};

	const state = balanceState(meter);
	const balanceBanner =
		state === 'empty' ? (
			<Callout
				tone="danger"
				title="Your credit balance is empty"
				actions={
					<Link href={routes.credits()} className="text-sm font-semibold underline">
						View credits
					</Link>
				}>
				Every subscription is paused until credits are added. Paused time is never billed.
			</Callout>
		) : state === 'low' ? (
			<Callout
				tone="warning"
				title={`About ${formatHours(meter.hoursRemaining)} of credits left`}
				actions={
					<Link href={routes.credits()} className="text-sm font-semibold underline">
						View credits
					</Link>
				}>
				At the current spend of {formatCredits(meter.burnRatePerHour)} per hour your subscriptions pause when the balance
				reaches zero.
			</Callout>
		) : null;
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
		impersonation || balanceBanner || requestBanner ? (
			<div className="space-y-3">
				<ImpersonationBanner impersonation={impersonation} userEmail={me?.user?.email ?? null} />
				{balanceBanner}
				{requestBanner}
			</div>
		) : null;

	const selectClass =
		'min-h-9 max-w-[14rem] truncate rounded-xl border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-fg hover:border-line-strong focus-visible:outline-2 focus-visible:outline-focus';

	return (
		<ToastProvider>
			<AppShell
				linkAs={Link}
				sections={sections}
				banner={banner}
				topbar={
					<>
						{memberships.length > 1 ? (
							<label className="flex items-center gap-2">
								<span className="sr-only">Organisation</span>
								<select
									className={selectClass}
									value={merchantId ?? ''}
									onChange={(e) => void switchMerchant(e.currentTarget.value)}>
									{memberships.map((m) => (
										<option key={m.merchantId} value={m.merchantId}>
											{m.name ?? m.merchantId}
										</option>
									))}
								</select>
							</label>
						) : (
							<span className="truncate px-1 text-sm font-bold text-fg">{merchant?.name ?? 'Your organisation'}</span>
						)}
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
						{meter && typeof meter.balanceMillicredits === 'number' ? (
							<Link
								href={routes.credits()}
								className="hidden items-center gap-1.5 rounded-xl border border-line px-3 py-1.5 text-sm font-semibold text-fg hover:border-line-strong sm:inline-flex"
								title="Credit balance">
								<Icon name="wallet" size={14} />
								<span className="tabular-nums">{formatCredits(meter.balanceMillicredits)}</span>
							</Link>
						) : null}
						<Button variant="ghost" size="sm" onClick={signOut} icon={<Icon name="logout" size={14} />}>
							<span className="hidden sm:inline">Sign out</span>
							<span className="sr-only sm:hidden">Sign out</span>
						</Button>
					</>
				}
				sidebarFooter={
					<div className="rounded-xl border border-line bg-surface-2 p-3 text-xs">
						<p className="truncate font-semibold text-fg">{me?.user?.email}</p>
						<p className="text-muted">
							{(memberships.find((m) => m.merchantId === merchantId)?.roles ?? []).join(', ') || 'member'}
						</p>
					</div>
				}>
				{children}
			</AppShell>
		</ToastProvider>
	);
}
