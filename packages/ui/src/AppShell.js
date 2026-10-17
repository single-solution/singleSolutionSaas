'use client';
/**
 * Console frame (owner 2026-10-17: app-like, premium): the window is the frame and the page itself never scrolls. A
 * floating sidebar panel (260 px: brand, an optional switcher, groups of links with icons and a soft accent pill on the
 * current page, help and account at the bottom; it folds to an icon rail), a floating 56 px header (the menu button on
 * phones, the breadcrumbs and page title, an optional context pill, search, actions, Back to Portal, and one account
 * or theme menu) and the main pane, which fills the rest of the window and scrolls on its own (`Pane`). Nothing
 * touches the screen edges: the panels keep 12-16 px from the window and from each other. Below 1024 px (`lg`) the
 * sidebar becomes a floating drawer opened by the menu button; nothing scrolls sideways. The slots `switcher` and
 * `sidebarFooter` may be functions of `{ rail }` so they can draw a compact version. Includes a skip link to the main
 * content. Router links are rendered with `linkAs` (e.g. Next's `Link`).
 *
 * Motion (PLAN 0.6): the current item's pill is one marker that slides to the clicked item at once (before its page
 * arrives); items tint on hover and press in when clicked; the rail folds in 180 ms; the phone drawer slides in and
 * out; the frame holds the `NavigationProgress` bar and stays still while pages change (`PageTransition`). The main
 * pane returns to its top when the page changes (`scrollKey`).
 * @module
 */
import { Fragment, createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from './cx.js';
import { Avatar } from './display.js';
import { Icon } from './icons.js';
import { AccountMenu, ThemeMenu } from './Menu.js';
import { NavigationProgress, usePresence } from './motion.js';
import { useFocusTrap } from './overlay.js';
import { ThemeToggle } from './theme.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./display.js').Kind} Kind */
/**
 * A menu link; its icon sits before the label (the rail shows only the icon, with the label as its tooltip).
 * @typedef {{ href: string, label: ReactNode, icon?: import('./icons.js').IconName, kind?: Kind, current?: boolean, badge?: ReactNode }} NavItem
 */
/** @typedef {{ label?: string, items: NavItem[] }} NavSection */
/** A step of the header's breadcrumbs (a link with `href`). @typedef {{ label: ReactNode, href?: string }} Crumb */
/**
 * The header's account menu (with the theme choice in it).
 * @typedef {{ name: string, email?: string, label?: string, items: import('./Menu.js').MenuItem[] }} ShellAccount
 */

/** The frame state the slots can read: `rail` is true while the sidebar is folded to icons. */
const ShellContext = createContext({ rail: false });

/** @returns {{ rail: boolean }} whether the sidebar is folded to its icon rail */
export const useShell = () => useContext(ShellContext);

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
					'pointer-events-none absolute inset-x-0 top-0 -z-10 rounded-lg bg-primary-soft opacity-0',
					placed && 'transition-[transform,opacity] duration-(--ss-motion) ease-ss-move',
				)}
			/>
			{sections.map((section, i) => (
				<div
					key={section.label ?? i}
					className={cx(i > 0 && (rail ? 'mt-2 border-t border-line-soft pt-2' : 'mt-6'), 'space-y-0.5')}>
					{section.label && !rail ? (
						<p className="px-2.5 pb-1.5 text-micro font-semibold tracking-[0.06em] text-muted uppercase">
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
											'ss-motion ss-press flex h-9 items-center gap-2.5 rounded-lg text-sm',
											'focus-visible:outline-2 focus-visible:outline-focus',
											rail ? 'justify-center px-0' : 'px-2.5',
											on
												? cx('font-medium text-on-primary-soft', placed ? 'bg-transparent' : 'bg-primary-soft')
												: 'font-medium text-fg/75 hover:bg-surface-2 hover:text-fg',
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
										{rail ? null : item.badge}
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
 * The product's mark and name; `compact` shows the mark alone (the rail) or the name alone (the phone header).
 * @param {{ name: ReactNode, tagline?: ReactNode, compact?: boolean, markOnly?: boolean }} props
 */
function Brand({ name, tagline, compact = false, markOnly = false }) {
	return (
		<div className={cx('flex min-w-0 items-center gap-2.5', markOnly && 'justify-center')}>
			<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-on-primary shadow-[inset_0_1px_0_rgb(255_255_255/0.18)]">
				<Icon name="zap" size={15} />
			</span>
			{markOnly ? (
				<span className="sr-only">{name}</span>
			) : (
				<span className="min-w-0">
					<span className="block truncate text-title font-semibold tracking-[-0.01em] text-fg">{name}</span>
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
const slotOf = (slot, rail) => (typeof slot === 'function' ? slot({ rail }) : slot);

/**
 * The website / merchant switcher of the sidebar: a select with a small avatar of the picked item and a chevron
 * (a native select underneath, so keyboards and screen readers work everywhere).
 * @param {{ label: string, value: string, options: Array<{ value: string, label: string }>, onChange: (value: string) => void,
 *   placeholder?: string, disabled?: boolean, className?: string }} props
 */
export function SwitcherSelect({ label, value, options, onChange, placeholder, disabled = false, className }) {
	const picked = options.find((option) => option.value === value);
	return (
		<div
			className={cx(
				'ss-motion relative flex h-10 min-w-0 items-center gap-2.5 rounded-control border border-line bg-surface pr-8 pl-2 shadow-card',
				'hover:border-line-strong has-[select:focus-visible]:border-primary has-[select:focus-visible]:ring-[3px] has-[select:focus-visible]:ring-primary/20',
				disabled && 'opacity-60',
				className,
			)}>
			<Avatar name={picked?.label || placeholder || label} size="sm" className="rounded-md" />
			<span aria-hidden="true" className={cx('min-w-0 flex-1 truncate text-sm font-medium', picked ? 'text-fg' : 'text-muted')}>
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
 * The context of what the page shows, as a small subtle pill in the header ("Viewing as admin · shop / site").
 * @param {{ children: ReactNode, icon?: import('./icons.js').IconName, className?: string }} props
 */
export function ContextPill({ children, icon = 'eye', className }) {
	return (
		<span
			className={cx(
				'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-line-soft bg-surface-2 px-2.5 text-label font-medium text-muted',
				className,
			)}>
			<Icon name={icon} size={13} className="shrink-0" />
			<span className="min-w-0 truncate">{children}</span>
		</span>
	);
}

/**
 * The header's breadcrumbs and page title on one line: the steps muted (links where they have an `href`), the title in
 * full color.
 * @param {{ crumbs: Crumb[], title?: ReactNode, linkAs?: import('react').ElementType }} props
 */
function TitleTrail({ crumbs, title, linkAs }) {
	const LinkTag = linkAs ?? 'a';
	return (
		<nav aria-label="Breadcrumb" className="min-w-0">
			<ol className="flex min-w-0 items-center gap-1.5 text-sm">
				{crumbs.map((crumb, i) => (
					<Fragment key={i}>
						<li className="hidden min-w-0 shrink truncate text-muted sm:block">
							{crumb.href ? (
								<LinkTag href={crumb.href} className="ss-motion rounded hover:text-fg">
									{crumb.label}
								</LinkTag>
							) : (
								crumb.label
							)}
						</li>
						<li aria-hidden="true" className="hidden shrink-0 text-subtle sm:block">
							<Icon name="chevronRight" size={14} />
						</li>
					</Fragment>
				))}
				{title ? (
					<li aria-current="page" className="min-w-0 truncate text-title font-semibold text-fg">
						{title}
					</li>
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
 * @param {{ brand?: { name: ReactNode, tagline?: ReactNode }, sections: NavSection[], topbar?: ReactNode,
 *   actions?: ReactNode, search?: ReactNode, banner?: ReactNode, children: ReactNode,
 *   linkAs?: import('react').ElementType, switcher?: ReactNode | ((state: { rail: boolean }) => ReactNode),
 *   sidebarFooter?: ReactNode | ((state: { rail: boolean }) => ReactNode), mainId?: string, themeToggle?: boolean,
 *   collapsible?: boolean, title?: ReactNode, crumbs?: Crumb[], context?: ReactNode, account?: ShellAccount,
 *   back?: { href: string, label: ReactNode }, scrollKey?: string }} props `switcher`: the website / merchant switcher
 *   under the brand; `search`: the header's search box; `title`: the page title in the header (the current menu
 *   item's label by default) after the `crumbs` (its menu group by default); `context`: a small pill beside it;
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
	context,
	account,
	back,
	scrollKey,
}) {
	const [open, setOpen] = useState(false);
	const [folded, setFolded] = useState(false);
	const rail = collapsible && folded;
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

	/** The sidebar's content; the drawer shows it wide, with its own close button. */
	const sidebar = (/** @type {boolean} */ narrow, /** @type {boolean} */ inDrawer) => (
		<ShellContext.Provider value={{ rail: narrow }}>
			<div className="flex h-full min-h-0 flex-col">
				<div className={cx('flex h-16 shrink-0 items-center gap-2 px-4', narrow ? 'justify-center px-0' : 'justify-between')}>
					<Brand {...brand} markOnly={narrow} />
					{inDrawer ? (
						<button
							type="button"
							onClick={() => setOpen(false)}
							aria-label="Close navigation"
							className="ss-motion ss-press rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
							<Icon name="close" size={16} />
						</button>
					) : null}
				</div>
				{switcher && !narrow ? <div className="shrink-0 px-3 pb-3">{slotOf(switcher, narrow)}</div> : null}
				<ScrollArea className="flex-1 overflow-x-hidden px-3 pt-1 pb-3">
					<Nav
						sections={sections}
						{...(linkAs ? { linkAs } : {})}
						rail={narrow}
						{...(inDrawer ? { onNavigate: () => setOpen(false) } : {})}
					/>
				</ScrollArea>
				<div className="shrink-0 space-y-1 border-t border-line-soft p-3">
					{sidebarFooter ? slotOf(sidebarFooter, narrow) : null}
					{inDrawer && themeToggle ? <ThemeToggle className="w-fit" /> : null}
					{!inDrawer && collapsible ? (
						<button
							type="button"
							onClick={() => fold(!narrow)}
							aria-label={narrow ? 'Expand sidebar' : 'Collapse sidebar'}
							aria-pressed={narrow}
							title={narrow ? 'Expand sidebar' : 'Collapse sidebar'}
							className={cx(
								'ss-motion ss-press flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-label font-medium text-muted hover:bg-surface-2 hover:text-fg',
								narrow ? 'w-full justify-center px-0' : 'w-full',
							)}>
							<Icon name={narrow ? 'chevronRight' : 'panelLeft'} size={16} />
							{narrow ? null : <span>Collapse</span>}
						</button>
					) : null}
				</div>
			</div>
		</ShellContext.Provider>
	);

	return (
		<NavigationProgress>
			<div className="flex h-dvh w-full gap-3 overflow-hidden bg-canvas p-3 text-fg lg:gap-4 lg:p-4">
				<a
					href={`#${mainId}`}
					className="sr-only z-[70] rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
					Skip to content
				</a>
				<aside
					data-rail={rail || undefined}
					className={cx(
						'hidden h-full shrink-0 overflow-hidden rounded-panel border border-line-soft bg-surface shadow-panel [view-transition-name:ss-sidebar] lg:block',
						'transition-[width] duration-(--ss-motion) ease-ss',
						rail ? 'w-[4.5rem]' : 'w-[16.25rem]',
					)}>
					{sidebar(rail, false)}
				</aside>
				{drawer.mounted ? (
					<div
						ref={drawer.ref}
						data-state={drawer.closing ? 'closed' : 'open'}
						className="group fixed inset-0 z-50 animate-ss-fade bg-overlay p-3 data-[state=closed]:pointer-events-none data-[state=closed]:animate-ss-fade-out lg:hidden"
						onMouseDown={(event) => {
							if (event.target === event.currentTarget) setOpen(false);
						}}>
						<div
							ref={panel}
							role="dialog"
							aria-modal="true"
							aria-label="Navigation"
							className="h-full w-[16.25rem] max-w-[85vw] animate-ss-drawer overflow-hidden rounded-panel border border-line-soft bg-surface shadow-overlay group-data-[state=closed]:animate-ss-drawer-out">
							{sidebar(false, true)}
						</div>
					</div>
				) : null}
				<div className="flex h-full min-w-0 flex-1 flex-col gap-3 lg:gap-4">
					<header className="flex h-14 shrink-0 items-center gap-2 rounded-panel border border-line-soft bg-surface px-2 shadow-panel [view-transition-name:ss-topbar] sm:gap-3 sm:px-4">
						<button
							type="button"
							onClick={() => setOpen(true)}
							aria-label="Open navigation"
							aria-expanded={open}
							className="ss-motion ss-press shrink-0 rounded-lg p-2 text-fg hover:bg-surface-2 lg:hidden">
							<Icon name="menu" size={18} />
						</button>
						<div className="flex min-w-0 flex-1 items-center gap-3">
							{pageTitle || trail.length > 0 ? (
								<TitleTrail crumbs={trail} title={pageTitle} {...(linkAs ? { linkAs } : {})} />
							) : (
								<span className="lg:hidden">
									<Brand {...brand} compact />
								</span>
							)}
							{context ? (
								<span className="hidden min-w-0 md:flex">
									<ContextPill>{context}</ContextPill>
								</span>
							) : null}
							{topbar ? <div className="flex min-w-0 items-center gap-2">{topbar}</div> : null}
						</div>
						{search ? <div className="hidden min-w-0 shrink md:block md:w-64 xl:w-80">{search}</div> : null}
						{actions || back || account || themeToggle ? (
							<div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
								{back ? (
									<a
										href={back.href}
										className="ss-motion inline-flex h-8 items-center gap-1 rounded-control px-2 text-label font-medium text-muted hover:bg-surface-2 hover:text-fg">
										<Icon name="chevronLeft" size={14} />
										<span className="sr-only sm:not-sr-only">{back.label}</span>
									</a>
								) : null}
								{actions}
								{account ? (
									<AccountMenu
										name={account.name}
										{...(account.email ? { email: account.email } : {})}
										items={account.items}
										{...(account.label ? { label: account.label } : {})}
										theme={themeToggle}
										compact
									/>
								) : themeToggle ? (
									<ThemeMenu />
								) : null}
							</div>
						) : null}
					</header>
					<ScrollArea ref={pane} className="-mx-1 flex-1 px-1 [--ss-pane-h:calc(100dvh-6rem)] lg:[--ss-pane-h:calc(100dvh-6.5rem)]">
						<div className="flex w-full min-w-0 flex-col gap-6 pb-6">
							{banner}
							<main id={mainId} tabIndex={-1} className="min-w-0 space-y-6 focus:outline-none">
								{children}
							</main>
						</div>
					</ScrollArea>
				</div>
			</div>
		</NavigationProgress>
	);
}
