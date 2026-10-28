'use client';
/**
 * Console frame (Unite dialect via theme.css: hard borders, teal accent, dense): the window is the frame and the page itself
 * never scrolls. On the off-white canvas sit a floating WHITE sidebar, bottom-weighted (240 px; it folds to a 64 px icon
 * rail): the logo on top, the main sections in the middle, and at the bottom the website / merchant switcher, help, the
 * account, the theme and the fold button; a floating 56 px header (the menu button on phones, the breadcrumbs and the
 * page title, optional search and actions, Back to Portal; a page drawn with `Page` has its own header and this one hides);
 * and the main pane, which fills the rest of the window and scrolls on its own (`Pane`). Nothing touches the screen edges: the panels keep
 * 12-16 px from the window and from each other. Below 1024 px (`lg`) the sidebar becomes a floating drawer opened by
 * the menu button, and the header holds the account (or theme) menu; nothing scrolls sideways. The slots `switcher`
 * and `sidebarFooter` may be functions of `{ rail }` so they can draw a compact version. No command bar, no assistant
 * dock. Includes a skip link to the main content. Router links are rendered with `linkAs` (e.g. Next's `Link`).
 *
 * Motion (PLAN 0.6): the current item's pill is one marker that slides to the clicked item at once (before its page
 * arrives); items tint on hover and press in when clicked; the rail folds in 180 ms; the phone drawer slides in and
 * out; the frame holds the `NavigationProgress` bar and stays still while pages change (`PageTransition`). The main
 * pane returns to its top when the page changes (`scrollKey`).
 * @module
 */
import { Fragment, cloneElement, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cx } from './cx.js';
import { Avatar, DOTS, IconBadge, TINTS } from './display.js';
import { Icon } from './icons.js';
import { AccountMenu, ThemeMenu } from './Menu.js';
import { NavigationProgress, usePresence } from './motion.js';
import { useFocusTrap } from './overlay.js';
import { ShellContext } from './shell-state.js';
import { ThemeToggle } from './theme.js';

export { useShell } from './shell-state.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./display.js').Kind} Kind */
/** @typedef {import('./display.js').Tone} Tone */
/**
 * A count at the right of a menu item (99+ above 99, nothing for 0), tinted by its `tone` (neutral by default); `label`
 * says what it counts, for screen readers and the tooltip ("4 orders to ship").
 * @typedef {{ count: number, tone?: Tone, label?: string }} NavBadge
 */
/**
 * A menu link; its icon sits before the label (the rail shows only the icon, with the label as its tooltip). `badge`
 * is a count and `dot` an attention dot (`true` = the attention tone; `dotLabel` names it for screen readers); the
 * rail folds either into a small mark on the icon.
 * @typedef {{ href: string, label: ReactNode, icon?: import('./icons.js').IconName, kind?: Kind, current?: boolean,
 *   badge?: NavBadge, dot?: Tone | true, dotLabel?: string }} NavItem
 */
/** @typedef {{ label?: string, items: NavItem[] }} NavSection */
/** A step of the header's breadcrumbs (a link with `href`). @typedef {{ label: ReactNode, href?: string }} Crumb */
/**
 * The header's account menu (with the theme choice in it).
 * `role` is a small chip beside the name ("Owner"); the narrow rail leaves it out.
 * @typedef {{ name: string, email?: string, label?: string, items: import('./Menu.js').MenuItem[], role?: ReactNode }} ShellAccount
 */

/** The words the frame itself says (for screen readers). */
export const SHELL_TEXTS = Object.freeze({ attention: 'Needs attention' });

/** The biggest count shown as a number. */
const MAX_COUNT = 99;

/**
 * What an item says about itself besides its name: a count and an attention dot at the right, or - in the icon rail - one
 * small mark on the icon (the count is still spoken).
 * @param {{ item: NavItem, rail: boolean }} props
 */
function NavMarks({ item, rail }) {
	const badge = item.badge && item.badge.count > 0 ? item.badge : null;
	const dotTone = item.dot === true ? 'attention' : item.dot;
	const dotLabel = item.dotLabel ?? SHELL_TEXTS.attention;
	if (rail) {
		const tone = dotTone ?? (badge ? (badge.tone ?? 'primary') : null);
		return (
			<>
				{tone ? (
					<span
						data-ss-mark=""
						aria-hidden="true"
						className={cx('absolute top-1 right-2 size-2 rounded-full ring-2 ring-surface', DOTS[tone])}
					/>
				) : null}
				{badge ? <span className="sr-only">{badge.label ?? badge.count}</span> : null}
				{dotTone ? <span className="sr-only">{dotLabel}</span> : null}
			</>
		);
	}
	const shown = badge ? (badge.count > MAX_COUNT ? `${MAX_COUNT}+` : String(badge.count)) : '';
	return (
		<>
			{badge ? (
				<span
					data-ss-badge=""
					{...(badge.label ? { title: badge.label } : {})}
					className={cx(
						'ss-motion inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-micro leading-none font-semibold tabular-nums',
						TINTS[badge.tone ?? 'neutral'],
					)}>
					{badge.label ? (
						<>
							<span aria-hidden="true">{shown}</span>
							<span className="sr-only">{badge.label}</span>
						</>
					) : (
						shown
					)}
				</span>
			) : null}
			{dotTone ? (
				<span data-ss-dot="" title={dotLabel} className="flex shrink-0 items-center">
					<span aria-hidden="true" className={cx('size-2 rounded-full', DOTS[dotTone])} />
					<span className="sr-only">{dotLabel}</span>
				</span>
			) : null}
		</>
	);
}

/** Where the folded state of the sidebar is kept (this browser only). */
const RAIL_KEY = 'ss-nav-rail';

/**
 * A plain left click (not a new tab or window).
 * @param {import('react').MouseEvent} event
 */
const plainClick = (event) =>
	!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * @param {{ sections: NavSection[], linkAs?: import('react').ElementType, onNavigate?: () => void, rail?: boolean }} props
 */
function Nav({ sections, linkAs, onNavigate, rail = false }) {
	const LinkTag = linkAs ?? 'a';
	const root = useRef(/** @type {HTMLElement | null} */ (null));
	const marker = useRef(/** @type {HTMLSpanElement | null} */ (null));
	const current = sections.flatMap((section) => section.items).find((item) => item.current)?.href ?? null;
	// the clicked item shows as current at once; the real current item takes over when it changes
	const [pressed, setPressed] = useState(/** @type {string | null} */ (null));
	const [placed, setPlaced] = useState(false);
	useEffect(() => setPressed(null), [current]);
	const active = pressed ?? current;
	useLayoutEffect(() => {
		const box = marker.current;
		const nav = root.current;
		if (!box || !nav) return;
		const link = /** @type {HTMLElement[]} */ ([...nav.querySelectorAll('[href]')]).find(
			(el) => el.getAttribute('href') === active,
		);
		if (!link) {
			box.style.opacity = '0';
			return;
		}
		box.style.height = `${link.offsetHeight}px`;
		box.style.transform = `translateY(${link.offsetTop}px)`;
		box.style.opacity = '1';
		setPlaced(true);
	}, [active, sections, rail]);
	return (
		<nav ref={root} aria-label="Main" className="relative isolate">
			<span
				ref={marker}
				aria-hidden="true"
				className={cx(
					'pointer-events-none absolute inset-x-0 top-0 -z-10 rounded-control border border-line bg-surface ss-hard opacity-0',
					placed && 'transition-[transform,opacity,height] duration-(--ss-motion) ease-ss-move',
				)}
			/>
			{sections.map((section, i) => (
				<div
					key={section.label ?? i}
					className={cx(i > 0 && (rail ? 'mt-3 border-t border-line pt-3' : 'mt-5'), 'space-y-0.5')}>
					{section.label && !rail ? (
						<p className="px-2.5 pb-1.5 font-mono text-micro font-semibold tracking-[0.1em] text-primary uppercase">
							{section.label}
						</p>
					) : null}
					<ul className="space-y-0.5">
						{section.items.map((item) => {
							const on = item.href === active;
							return (
								<li key={item.href}>
									<LinkTag
										href={item.href}
										onClick={(/** @type {import('react').MouseEvent | undefined} */ event) => {
											if (event && plainClick(event)) setPressed(item.href);
											onNavigate?.();
										}}
										aria-current={item.current ? 'page' : undefined}
										{...(rail && typeof item.label === 'string' ? { title: item.label } : {})}
										className={cx(
											'ss-motion ss-press relative flex h-9 items-center gap-2.5 rounded-control text-sm',
											'focus-visible:outline-2 focus-visible:outline-focus',
											rail ? 'justify-center px-0' : 'px-2.5',
											on
												? cx(
														'font-medium text-fg',
														placed ? 'bg-transparent' : 'border border-line bg-surface ss-hard',
													)
												: 'font-medium text-muted hover:bg-surface/70 hover:text-fg',
										)}>
										{item.icon ? (
											<span
												aria-hidden="true"
												className={cx(
													'ss-motion flex size-5 shrink-0 items-center justify-center',
													on ? 'text-primary' : 'text-muted',
												)}>
												<Icon name={item.icon} size={16} />
											</span>
										) : rail ? (
											<span aria-hidden="true" className="text-sm font-semibold">
												{typeof item.label === 'string' ? item.label.slice(0, 1).toUpperCase() : '·'}
											</span>
										) : null}
										<span className={cx(rail ? 'sr-only' : 'min-w-0 flex-1 truncate')}>{item.label}</span>
										<NavMarks item={item} rail={rail} />
									</LinkTag>
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</nav>
	);
}

/**
 * The console's mark and name; `compact` shows the mark alone (the rail) or the name alone (the phone header). In a
 * product dashboard (`product`, its id) the mark is the product's chip in its meaning color.
 * @param {{ name: ReactNode, tagline?: ReactNode, product?: string, compact?: boolean, markOnly?: boolean }} props
 */
function Brand({ name, tagline, product, compact = false, markOnly = false }) {
	const mark =
		typeof name === 'string'
			? name
					.split(/\s+/)
					.filter(Boolean)
					.slice(0, 2)
					.map((part) => part[0]?.toUpperCase() ?? '')
					.join('') || 'SS'
			: 'SS';
	return (
		<div className={cx('flex min-w-0 items-center gap-2.5', markOnly && 'justify-center')}>
			{product ? (
				<IconBadge product={product} size="sm" />
			) : (
				<span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-fg font-mono text-micro font-semibold tracking-tight text-canvas">
					{mark}
				</span>
			)}
			{markOnly ? (
				<span className="sr-only">{name}</span>
			) : (
				<span className="min-w-0">
					<span className="block truncate text-sm font-semibold tracking-[-0.01em] text-fg">{name}</span>
					{tagline && !compact ? <span className="block truncate text-help text-muted">{tagline}</span> : null}
				</span>
			)}
		</div>
	);
}

/**
 * A slot that may be a node or a function of the frame state.
 * @param {ReactNode | ((state: { rail: boolean }) => ReactNode)} slot
 * @param {boolean} rail
 */
const slotOf = (slot, rail) => {
	if (typeof slot === 'function') return slot({ rail });
	if (isValidElement(slot) && rail && typeof slot.type !== 'string')
		return cloneElement(/** @type {import('react').ReactElement<{ compact?: boolean }>} */ (slot), {
			compact: true,
		});
	return slot;
};

/**
 * The website / merchant switcher of the sidebar: a select with a small avatar of the picked item and a chevron
 * (a native select underneath, so keyboards and screen readers work everywhere). In the folded rail, `compact` shows
 * the avatar with tooltip and the native select over it.
 * @param {{ label: string, value: string, options: Array<{ value: string, label: string }>, onChange: (value: string) => void,
 *   placeholder?: string, disabled?: boolean, compact?: boolean, className?: string }} props
 */
export function SwitcherSelect({ label, value, options, onChange, placeholder, disabled = false, compact = false, className }) {
	const picked = options.find((option) => option.value === value);
	const title = picked?.label || placeholder || label;
	if (compact) {
		return (
			<div
				title={title}
				className={cx(
					'ss-motion relative flex size-10 min-w-0 items-center justify-center rounded-control border border-line bg-surface hover:bg-surface-2',
					'hover:border-line-strong has-[select:focus-visible]:border-primary has-[select:focus-visible]:ring-[3px] has-[select:focus-visible]:ring-primary/20',
					disabled && 'opacity-60',
					className,
				)}>
				<Avatar name={title} size="sm" className="rounded-control" />
				<select
					aria-label={label}
					value={value}
					disabled={disabled}
					onChange={(event) => onChange(event.currentTarget.value)}
					className="absolute inset-0 size-full cursor-pointer appearance-none bg-none opacity-0 disabled:cursor-not-allowed">
					{placeholder ? (
						<option value="" disabled>
							{placeholder}
						</option>
					) : null}
					{options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>
		);
	}
	return (
		<div
			className={cx(
				'ss-motion relative flex h-10 min-w-0 items-center gap-2.5 rounded-control border border-line bg-surface pr-8 pl-2 hover:bg-surface-2',
				'hover:border-line-strong has-[select:focus-visible]:border-primary has-[select:focus-visible]:ring-[3px] has-[select:focus-visible]:ring-primary/20',
				disabled && 'opacity-60',
				className,
			)}>
			<Avatar name={picked?.label || placeholder || label} size="sm" className="rounded-control" />
			<span
				aria-hidden="true"
				className={cx('min-w-0 flex-1 truncate text-sm font-medium', picked ? 'text-fg' : 'text-muted')}>
				{picked?.label ?? placeholder ?? ''}
			</span>
			<span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-muted">
				<Icon name="chevronsUpDown" size={14} />
			</span>
			<select
				aria-label={label}
				value={value}
				disabled={disabled}
				onChange={(event) => onChange(event.currentTarget.value)}
				className="absolute inset-0 size-full cursor-pointer appearance-none bg-none opacity-0 disabled:cursor-not-allowed">
				{placeholder ? (
					<option value="" disabled>
						{placeholder}
					</option>
				) : null}
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</div>
	);
}

/**
 * The header's breadcrumbs and page title on one line: the steps muted (links where they have an `href`), the title in
 * full color.
 * @param {{ crumbs: Crumb[], title?: ReactNode, linkAs?: import('react').ElementType }} props
 */
function TitleTrail({ crumbs, title, linkAs }) {
	if (crumbs.length === 0 && !title) return null;
	const LinkTag = linkAs ?? 'a';
	return (
		<nav aria-label="Breadcrumb" className="min-w-0">
			<ol className="flex min-w-0 items-center gap-1.5">
				{crumbs.map((crumb, i) => (
					<Fragment key={i}>
						{i > 0 ? (
							<li
								aria-hidden="true"
								className="hidden shrink-0 font-mono text-micro text-subtle before:content-['/'] sm:block"
							/>
						) : null}
						<li className="hidden min-w-0 shrink truncate font-mono text-micro tracking-[0.04em] text-muted uppercase sm:block">
							{crumb.href ? (
								<LinkTag href={crumb.href} className="ss-motion rounded-control hover:text-fg">
									{crumb.label}
								</LinkTag>
							) : (
								crumb.label
							)}
						</li>
					</Fragment>
				))}
				{title ? (
					<>
						{crumbs.length > 0 ? (
							<li
								aria-hidden="true"
								className="hidden shrink-0 font-mono text-micro text-subtle before:content-['/'] sm:block"
							/>
						) : null}
						<li
							aria-current="page"
							className="min-w-0 truncate font-display text-title font-semibold tracking-[-0.02em] text-fg">
							{title}
						</li>
					</>
				) : null}
			</ol>
		</nav>
	);
}

/**
 * A scrolling pane of the frame: it fills the height it is given and scrolls on its own (a thin themed scrollbar
 * shows while the pointer is over it), never the page. Use it for any long list inside a card too.
 * @param {{ children?: ReactNode, className?: string, label?: string, ref?: import('react').Ref<HTMLDivElement>,
 *   as?: 'div' | 'section' | 'aside' }} props `label` makes it a labeled region that takes focus (the keyboard can
 *   scroll it)
 */
export function ScrollArea({ children, className, label, ref, as = 'div' }) {
	const Tag = as;
	return (
		<Tag
			ref={ref}
			className={cx('ss-scroll min-h-0 min-w-0 focus-visible:outline-2 focus-visible:-outline-offset-2', className)}
			{...(label ? { role: 'region', 'aria-label': label, tabIndex: 0 } : {})}>
			{children}
		</Tag>
	);
}

/**
 * @param {{ brand?: { name: ReactNode, tagline?: ReactNode, product?: string }, sections: NavSection[], topbar?: ReactNode,
 *   actions?: ReactNode, search?: ReactNode, banner?: ReactNode, children: ReactNode,
 *   linkAs?: import('react').ElementType, switcher?: ReactNode | ((state: { rail: boolean }) => ReactNode),
 *   sidebarFooter?: ReactNode | ((state: { rail: boolean }) => ReactNode), mainId?: string, themeToggle?: boolean,
 *   collapsible?: boolean, title?: ReactNode, crumbs?: Crumb[], account?: ShellAccount,
 *   back?: { href: string, label: ReactNode }, scrollKey?: string }} props `switcher`: the website / merchant switcher
 *   under the brand; `search`: the header's search box; `title`: the page title in the header (the current menu
 *   item's label by default) after the `crumbs` (its menu group by default);
 *   `account`: the header's account menu (it holds the theme choice); `themeToggle`: offer the theme choice (default
 *   true; without an `account` it is a small theme menu); `back`: a subtle text link (Back to Portal); `collapsible`:
 *   the sidebar folds to an icon rail (default true); `scrollKey`: the main pane goes back to its top when it changes
 *   (the current menu item by default)
 */
export function AppShell({
	brand = { name: 'Single Solution', tagline: 'Console' },
	sections,
	topbar,
	actions,
	search,
	banner,
	children,
	linkAs,
	switcher,
	sidebarFooter,
	mainId = 'main',
	themeToggle = true,
	collapsible = true,
	title,
	crumbs,
	account,
	back,
	scrollKey,
}) {
	const [open, setOpen] = useState(false);
	const [folded, setFolded] = useState(false);
	const rail = collapsible && folded;
	// what the pages inside read (shell-state.js): the folded state, the router link, the phone menu button
	const shell = useMemo(() => ({ rail, ...(linkAs ? { linkAs } : {}), openNav: () => setOpen(true) }), [rail, linkAs]);
	const panel = useRef(/** @type {HTMLDivElement | null} */ (null));
	const pane = useRef(/** @type {HTMLDivElement | null} */ (null));
	const drawer = usePresence(open);
	useFocusTrap(panel, open, () => setOpen(false));
	const currentSection = sections.find((section) => section.items.some((item) => item.current));
	const currentItem = currentSection?.items.find((item) => item.current);
	const pageTitle = title ?? currentItem?.label;
	const trail = crumbs ?? (currentSection?.label ? [{ label: currentSection.label }] : []);
	const paneKey = scrollKey ?? currentItem?.href ?? '';
	useEffect(() => {
		try {
			setFolded(window.localStorage.getItem(RAIL_KEY) === '1');
		} catch {
			// storage blocked: the sidebar starts wide
		}
	}, []);
	useEffect(() => {
		if (pane.current) pane.current.scrollTop = 0;
	}, [paneKey]);
	/** @param {boolean} next */
	const fold = (next) => {
		setFolded(next);
		try {
			window.localStorage.setItem(RAIL_KEY, next ? '1' : '0');
		} catch {
			// storage blocked: the choice lasts for this page only
		}
	};
	useEffect(() => {
		if (!open) return undefined;
		const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(min-width: 1024px)') : null;
		const onChange = () => {
			if (media?.matches) setOpen(false);
		};
		media?.addEventListener?.('change', onChange);
		return () => media?.removeEventListener?.('change', onChange);
	}, [open]);

	/**
	 * The sidebar's content, bottom-weighted: the logo; the main sections; then the switcher, the footer slot (help), the
	 * account, and the theme with the fold button. The drawer shows it wide, with its own close button.
	 */
	const sidebar = (/** @type {boolean} */ narrow, /** @type {boolean} */ inDrawer) => (
		<ShellContext.Provider value={{ ...shell, rail: narrow }}>
			<div className="flex h-full min-h-0 flex-col">
				<div className={cx('flex h-14 shrink-0 items-center gap-2 px-3', narrow ? 'justify-center px-0' : 'justify-between')}>
					<Brand {...brand} markOnly={narrow} />
					{inDrawer ? (
						<button
							type="button"
							onClick={() => setOpen(false)}
							aria-label="Close navigation"
							className="ss-motion ss-press rounded-control p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
							<Icon name="close" size={16} />
						</button>
					) : null}
				</div>
				<ScrollArea className="flex-1 overflow-x-hidden px-2.5 pt-1 pb-2">
					<Nav
						sections={sections}
						{...(linkAs ? { linkAs } : {})}
						rail={narrow}
						{...(inDrawer ? { onNavigate: () => setOpen(false) } : {})}
					/>
				</ScrollArea>
				<div
					data-ss-part="sidebar-bottom"
					className={cx('shrink-0 space-y-1 border-t border-line p-3', narrow && 'flex flex-col items-center')}>
					{switcher ? (
						<div className={cx('pb-2', narrow && 'flex w-full justify-center')}>{slotOf(switcher, narrow)}</div>
					) : null}
					{sidebarFooter ? <div className="w-full">{slotOf(sidebarFooter, narrow)}</div> : null}
					{account ? (
						<div className={cx('w-full', narrow && 'flex justify-center')}>
							<AccountMenu
								name={account.name}
								{...(account.email ? { email: account.email } : {})}
								items={account.items}
								{...(account.label ? { label: account.label } : {})}
								{...(account.role && !narrow ? { role: account.role } : {})}
								theme={narrow && themeToggle}
								compact={narrow}
								placement="up"
							/>
						</div>
					) : null}
					{narrow ? (
						<>
							{themeToggle && !account ? <ThemeMenu placement="up" /> : null}
							{collapsible && !inDrawer ? (
								<button
									type="button"
									onClick={() => fold(false)}
									aria-label="Expand sidebar"
									aria-pressed={true}
									title="Expand sidebar"
									className="ss-motion ss-press flex size-9 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg">
									<Icon name="panelLeft" size={16} />
								</button>
							) : null}
						</>
					) : themeToggle || (collapsible && !inDrawer) ? (
						<div className="flex items-center justify-between gap-2 pt-1">
							{themeToggle ? <ThemeToggle /> : <span />}
							{collapsible && !inDrawer ? (
								<button
									type="button"
									onClick={() => fold(true)}
									aria-label="Collapse sidebar"
									aria-pressed={false}
									title="Collapse sidebar"
									className="ss-motion ss-press flex size-8 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg">
									<Icon name="panelLeft" size={16} />
								</button>
							) : null}
						</div>
					) : null}
				</div>
			</div>
		</ShellContext.Provider>
	);

	return (
		<NavigationProgress>
			<ShellContext.Provider value={shell}>
				{/* Unite portal-kit frame: one hard shell, sidebar flush with main (no floating panels) */}
				<div
					className={cx(
						'flex h-dvh w-full overflow-hidden bg-canvas p-2 text-fg sm:p-2.5',
						// save bar centres on the page area inside the frame
						'[--ss-pane-left:0.5rem] [--ss-pane-right:0.5rem] sm:[--ss-pane-left:0.625rem] sm:[--ss-pane-right:0.625rem]',
						rail ? 'lg:[--ss-pane-left:5.125rem]' : 'lg:[--ss-pane-left:16.625rem]',
					)}>
					<a
						href={`#${mainId}`}
						className="sr-only z-[70] rounded-control bg-primary px-3 py-2 text-sm font-semibold text-on-primary focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
						Skip to content
					</a>
					<div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-panel border border-line bg-surface">
						<aside
							data-rail={rail || undefined}
							className={cx(
								// menus open upward over the page from the rail
								'relative z-30 hidden h-full shrink-0 border-r border-line bg-canvas/65 [view-transition-name:ss-sidebar] lg:block',
								'transition-[width] duration-(--ss-motion) ease-ss',
								rail ? 'w-16' : 'w-[15.5rem]',
							)}>
							{sidebar(rail, false)}
						</aside>
						{drawer.mounted ? (
							<div
								ref={drawer.ref}
								data-state={drawer.closing ? 'closed' : 'open'}
								className="group fixed inset-0 z-50 animate-ss-fade bg-overlay p-2 data-[state=closed]:pointer-events-none data-[state=closed]:animate-ss-fade-out lg:hidden"
								onMouseDown={(event) => {
									if (event.target === event.currentTarget) setOpen(false);
								}}>
								<div
									ref={panel}
									role="dialog"
									aria-modal="true"
									aria-label="Navigation"
									className="h-full w-60 max-w-[85vw] animate-ss-drawer rounded-panel border border-line bg-canvas group-data-[state=closed]:animate-ss-drawer-out">
									{sidebar(false, true)}
								</div>
							</div>
						) : null}
						<div className="group/main flex h-full min-w-0 flex-1 flex-col ss-grid-wash">
							<header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface/90 px-2 group-has-[[data-ss-page]]/main:hidden [view-transition-name:ss-topbar] sm:gap-3 sm:px-3">
								<button
									type="button"
									onClick={() => setOpen(true)}
									aria-label="Open navigation"
									aria-expanded={open}
									className="ss-motion ss-press shrink-0 rounded-control p-2 text-fg hover:bg-surface-2 lg:hidden">
									<Icon name="menu" size={18} />
								</button>
								<div className="flex min-w-0 flex-1 items-center gap-2.5">
									{pageTitle || trail.length > 0 ? (
										<TitleTrail crumbs={trail} title={pageTitle} {...(linkAs ? { linkAs } : {})} />
									) : (
										<span className="lg:hidden">
											<Brand {...brand} compact />
										</span>
									)}
									{topbar ? <div className="flex min-w-0 items-center gap-2">{topbar}</div> : null}
								</div>
								{search ? <div className="hidden min-w-0 shrink md:block md:w-64 xl:w-80">{search}</div> : null}
								{actions || back || account || themeToggle ? (
									<div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
										{back ? (
											<a
												href={back.href}
												className="ss-motion inline-flex h-8 items-center gap-1 rounded-control border border-transparent px-2 text-label font-medium text-muted hover:border-line hover:bg-surface hover:text-fg">
												<Icon name="chevronLeft" size={14} />
												<span className="sr-only sm:not-sr-only">{back.label}</span>
											</a>
										) : null}
										{actions}
										{account ? (
											<span className="lg:hidden">
												<AccountMenu
													name={account.name}
													{...(account.email ? { email: account.email } : {})}
													items={account.items}
													{...(account.label ? { label: account.label } : {})}
													theme={themeToggle}
													compact
												/>
											</span>
										) : themeToggle ? (
											<span className="lg:hidden">
												<ThemeMenu />
											</span>
										) : null}
									</div>
								) : null}
							</header>
							<ScrollArea
								ref={pane}
								className="flex-1 [--ss-pane-h:calc(100dvh-5.5rem)] lg:[--ss-pane-h:calc(100dvh-5.75rem)] has-[[data-ss-page]]:overflow-hidden has-[[data-ss-page]]:pb-1">
								<div className="flex w-full min-w-0 flex-col gap-5 p-3 pb-5 has-[[data-ss-page]]:h-full has-[[data-ss-page]]:gap-2 has-[[data-ss-page]]:p-2 has-[[data-ss-page]]:pb-0 lg:has-[[data-ss-page]]:gap-3 sm:p-3.5">
									{banner}
									<main
										id={mainId}
										tabIndex={-1}
										className="min-w-0 space-y-5 focus:outline-none has-[[data-ss-page]]:flex has-[[data-ss-page]]:min-h-0 has-[[data-ss-page]]:flex-1 has-[[data-ss-page]]:flex-col">
										{children}
									</main>
								</div>
							</ScrollArea>
						</div>
					</div>
				</div>
			</ShellContext.Provider>
		</NavigationProgress>
	);
}
