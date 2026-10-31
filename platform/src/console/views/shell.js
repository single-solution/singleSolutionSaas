'use client';
/**
 * The signed-in merchant console frame (PLAN 0.6, Unite dialect): the menu Overview · Websites · Usage and
 * credits · Account; at the bottom of the sidebar (and its phone drawer) the website switcher, help and the account menu
 * (My account, the theme, Sign out) and the credit balance (a link to Usage and credits); the billing banner on top;
 * and a mark on the Usage and credits entry while the balance is low, in grace or stopped, with the Branding. The page
 * title and its breadcrumbs are the page's own header (layout contract R2). The frame is the console's layout, so it
 * stays across navigations: pages hand it their fresh billing summary (frame-billing.js). The public account pages
 * render without it.
 * @module
 */
import { usePathname, useRouter } from 'next/navigation.js';
import { createContext, useContext, useEffect, useState, useTransition } from 'react';
import { AppShell, Icon, SwitcherSelect, ToastProvider, cx, formatCredits, useNavigationProgress } from '@ss/ui';
import { BILLING, MERCHANT, WEBSITE } from '../../texts/console.js';
import { apiFetch } from '../client.js';
import { Link, NavLink } from '../link.js';
import { PUBLIC_PATHS, api, routes } from '../paths.js';
import { BillingBanner } from './billing.js';
import { accentStyle } from './common.js';
import { contactLine } from './sign-in.js';

/** Set by the frame: replaces the billing summary it shows. */
export const BillingContext = createContext(/** @type {((billing: any) => void) | null} */ (null));

/**
 * Hands a page's billing summary (from its own check) to the frame's balance and banner.
 * @param {{ billing: any }} props
 */
export function FrameBilling({ billing }) {
	const set = useContext(BillingContext);
	useEffect(() => {
		if (set && billing) set(billing);
	}, [set, billing]);
	return null;
}

/** The look of a footer row (the same for the balance and the help link). @param {boolean} rail */
const footerRowClass = (rail) =>
	cx(
		'ss-motion ss-press flex h-9 items-center gap-2.5 rounded-control text-sm font-medium text-fg/80 hover:bg-surface-2 hover:text-fg',
		'focus-visible:outline-2 focus-visible:outline-focus',
		rail ? 'justify-center' : 'px-2.5',
	);

/**
 * Bottom of the merchant sidebar: credits balance and help link.
 * @param {{ rail: boolean, balance?: number | null, help?: { label: string, url: string } | null }} props
 */
function FrameFooter({ rail, balance = null, help = null }) {
	return (
		<div className="space-y-0.5">
			<a href={routes.docs()} title={WEBSITE.docs} target="_blank" rel="noopener noreferrer" className={footerRowClass(rail)}>
				<span aria-hidden="true" className="text-muted">
					<Icon name="code" size={17} />
				</span>
				<span className={rail ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{WEBSITE.docs}</span>
			</a>
			{balance !== null ? (
				<Link href={routes.credits()} title={MERCHANT.balanceLink} className={footerRowClass(rail)}>
					<span aria-hidden="true" className="text-muted">
						<Icon name="wallet" size={17} />
					</span>
					<span className={rail ? 'sr-only' : 'min-w-0 flex-1 truncate'}>
						{MERCHANT.balanceLink}
						<span className="ml-1.5 tabular-nums text-muted">{formatCredits(balance)}</span>
					</span>
				</Link>
			) : null}
			{help ? (
				<a
					href={help.url}
					title={help.label}
					{...(/^https?:/i.test(help.url) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
					className={footerRowClass(rail)}>
					<span aria-hidden="true" className="text-info">
						<Icon name="help" size={17} />
					</span>
					<span className={rail ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{help.label}</span>
				</a>
			) : null}
		</div>
	);
}

/**
 * The attention mark of Usage and credits for a billing summary: red when the websites are stopped, amber while the
 * balance is low or in grace; nothing otherwise.
 * @param {any} billing
 * @returns {{ dot: 'danger' | 'attention', dotLabel: string } | null}
 */
const creditsMark = (billing) => {
	if (billing?.status === 'stopped') return { dot: 'danger', dotLabel: BILLING.banner.stopped };
	if (billing?.status === 'grace') return { dot: 'attention', dotLabel: BILLING.banner.grace };
	if (billing?.status === 'low_balance') return { dot: 'attention', dotLabel: BILLING.banner.low };
	return null;
};

/**
 * The merchant menu with the current entry marked; `billing` (the billing summary) puts a mark on Usage and credits
 * while the balance needs attention.
 * @param {string} pathname
 * @param {any} [billing]
 * @returns {import('@ss/ui').NavSection[]}
 */
export const merchantSections = (pathname, billing = null) => {
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
				{
					href: routes.credits(),
					label: MERCHANT.menu.usage,
					kind: 'credit',
					icon: 'wallet',
					current: is(routes.credits()),
					...creditsMark(billing),
				},
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
 * The website switcher: a select of the merchant's websites, "All websites" first, with a small avatar.
 * @param {{ websites: any[], current: string, disabled: boolean, onPick: (next: string) => void }} props
 */
function WebsiteSwitcher({ websites, current, disabled, onPick }) {
	return (
		<SwitcherSelect
			label={MERCHANT.website}
			value={current}
			disabled={disabled}
			options={[{ value: '', label: MERCHANT.allWebsites }, ...websites.map((w) => ({ value: w.websiteId, label: w.domain }))]}
			onChange={onPick}
		/>
	);
}

/**
 * @param {{ me: any, websites: any[], billing: any, children: import('react').ReactNode,
 *   branding: { name: string, accent: string, support?: any } }} props
 */
export function ConsoleShell({ me, websites, billing: frameBilling, children, branding }) {
	const pathname = usePathname() ?? '';
	const router = useRouter();
	const [switching, startSwitch] = useTransition();
	useNavigationProgress(switching);
	const [billing, setBilling] = useState(frameBilling);
	useEffect(() => setBilling(frameBilling), [frameBilling]);
	if (PUBLIC_PATHS.includes(pathname) || pathname === '/docs' || pathname.startsWith('/docs/')) return children;
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
						sections={merchantSections(pathname, billing)}
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
						scrollKey={pathname}
						account={{
							name: accountName,
							...(merchant?.email ? { email: merchant.email } : {}),
							items: accountItems,
							label: MERCHANT.accountMenu,
						}}
						sidebarFooter={({ rail }) => (
							<FrameFooter
								rail={rail}
								balance={billing && typeof billing.balance === 'number' ? billing.balance : null}
								help={helpChannel ? { label: MERCHANT.help, url: helpChannel.url } : null}
							/>
						)}>
						{children}
					</AppShell>
				</div>
			</ToastProvider>
		</BillingContext.Provider>
	);
}
