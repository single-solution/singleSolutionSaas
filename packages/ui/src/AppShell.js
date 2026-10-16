'use client';
/**
 * Console frame (owner 2026-10-16: floating panels on a quiet canvas, full width): a sidebar panel (brand, an optional
 * switcher, groups of links with icons and a soft pill on the current page, help and account at the bottom; it folds
 * to an icon rail), a sticky header panel (context switchers, search, theme switch, actions) and the page, which is as
 * wide as the window leaves it (pages lay their cards out in a 12-column grid, see `Grid`). Nothing touches the screen
 * edges: the panels keep 12-16 px from the window and from each other, with a rounded edge, a hairline and a soft
 * shadow. Below 1024 px (`lg`) the sidebar becomes a floating drawer opened by the menu button; the page never scrolls
 * sideways. The slots `switcher` and `sidebarFooter` may be functions of `{ rail }` so they can draw a compact version.
 * Includes a skip link to the main content. Router links are rendered with `linkAs` (e.g. Next's `Link`).
 *
 * Motion (PLAN 0.6): the current item's pill is one marker that slides to the clicked item at once (before its page
 * arrives); items tint on hover and press in when clicked; the rail folds in 180 ms; the phone drawer slides in and
 * out; the frame holds the `NavigationProgress` bar and stays still while pages change (`PageTransition`).
 * @module
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from './cx.js';
import { Icon } from './icons.js';
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
					className={cx(i > 0 && (rail ? 'mt-2 border-t border-line-soft pt-2' : 'mt-5'), 'space-y-0.5')}>
					{section.label && !rail ? (
						<p className="px-2.5 pb-1.5 text-micro font-semibold tracking-wide text-muted uppercase">{section.label}</p>
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
												? cx('font-semibold text-on-primary-soft', placed ? 'bg-transparent' : 'bg-primary-soft')
												: 'font-medium text-fg/80 hover:bg-surface-2 hover:text-fg',
										)}>
										{item.icon ? (
											<span
												aria-hidden="true"
												className={cx(
													'ss-motion flex size-5 shrink-0 items-center justify-center',
													on ? 'text-primary' : 'text-muted',
												)}>
												<Icon name={item.icon} size={17} />
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
			<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-on-primary">
				<Icon name="zap" size={16} />
			</span>
			{markOnly ? (
				<span className="sr-only">{name}</span>
			) : (
				<span className="min-w-0">
					<span className="block truncate font-display text-base leading-tight font-extrabold tracking-[-0.01em] text-fg">
						{name}
					</span>
					{tagline && !compact ? <span className="block truncate text-xs text-muted">{tagline}</span> : null}
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
 * @param {{ brand?: { name: ReactNode, tagline?: ReactNode }, sections: NavSection[], topbar?: ReactNode,
 *   actions?: ReactNode, search?: ReactNode, banner?: ReactNode, children: ReactNode,
 *   linkAs?: import('react').ElementType, switcher?: ReactNode | ((state: { rail: boolean }) => ReactNode),
 *   sidebarFooter?: ReactNode | ((state: { rail: boolean }) => ReactNode), mainId?: string, themeToggle?: boolean,
 *   collapsible?: boolean }} props `switcher`: the website / merchant switcher under the brand; `search`: the header's
 *   search box; `themeToggle`: show the theme switch (default true); `collapsible`: the sidebar folds to an icon rail
 *   (default true)
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
}) {
	const [open, setOpen] = useState(false);
	const [folded, setFolded] = useState(false);
	const rail = collapsible && folded;
	const panel = useRef(/** @type {HTMLDivElement | null} */ (null));
	const drawer = usePresence(open);
	useFocusTrap(panel, open, () => setOpen(false));
	useEffect(() => {
		try {
			setFolded(window.localStorage.getItem(RAIL_KEY) === '1');
		} catch {
			// storage blocked: the sidebar starts wide
		}
	}, []);
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
				<div className={cx('flex h-14 shrink-0 items-center gap-2 px-3', narrow ? 'justify-center' : 'justify-between')}>
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
				{switcher && !narrow ? <div className="shrink-0 px-3 pb-2">{slotOf(switcher, narrow)}</div> : null}
				<div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-3 py-2">
					<Nav
						sections={sections}
						{...(linkAs ? { linkAs } : {})}
						rail={narrow}
						{...(inDrawer ? { onNavigate: () => setOpen(false) } : {})}
					/>
				</div>
				<div className="shrink-0 space-y-2 border-t border-line-soft p-3">
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
								'ss-motion ss-press flex h-8 items-center gap-2 rounded-lg px-2 text-label font-medium text-muted hover:bg-surface-2 hover:text-fg',
								narrow ? 'w-full justify-center' : 'w-full',
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
			<div className="min-h-screen bg-canvas text-fg">
				<a
					href={`#${mainId}`}
					className="sr-only z-[70] rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
					Skip to content
				</a>
				<div className="flex w-full gap-3 p-3 lg:gap-4 lg:p-4">
					<aside
						data-rail={rail || undefined}
						className={cx(
							'sticky top-4 hidden h-[calc(100dvh-2rem)] shrink-0 rounded-panel border border-line-soft bg-surface shadow-panel [view-transition-name:ss-sidebar] lg:block',
							'transition-[width] duration-(--ss-motion) ease-ss',
							rail ? 'w-[4.5rem]' : 'w-[15.5rem]',
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
								className="h-full w-72 max-w-[85vw] animate-ss-drawer overflow-hidden rounded-panel border border-line-soft bg-surface shadow-overlay group-data-[state=closed]:animate-ss-drawer-out">
								{sidebar(false, true)}
							</div>
						</div>
					) : null}
					<div className="flex min-w-0 flex-1 flex-col">
						<div className="sticky top-0 z-30 -mt-3 bg-canvas pt-3 pb-3 [view-transition-name:ss-topbar] lg:-mt-4 lg:pt-4">
							<header className="flex min-h-14 items-center gap-2 rounded-panel border border-line-soft bg-surface px-2 py-1.5 shadow-panel sm:gap-3 sm:px-3">
								<button
									type="button"
									onClick={() => setOpen(true)}
									aria-label="Open navigation"
									aria-expanded={open}
									className="ss-motion ss-press shrink-0 rounded-lg p-2 text-fg hover:bg-surface-2 lg:hidden">
									<Icon name="menu" size={18} />
								</button>
								<div className="flex min-w-0 flex-1 items-center gap-2">
									{!topbar ? (
										<span className="lg:hidden">
											<Brand {...brand} compact />
										</span>
									) : (
										<div className="flex min-w-0 flex-1 items-center gap-2">{topbar}</div>
									)}
								</div>
								{search ? <div className="hidden min-w-0 shrink md:block md:w-64 xl:w-80">{search}</div> : null}
								{actions || themeToggle ? (
									<div className="flex shrink-0 items-center gap-2">
										{themeToggle ? <ThemeToggle className="hidden sm:inline-flex" /> : null}
										{actions}
									</div>
								) : null}
							</header>
						</div>
						<div className="flex w-full min-w-0 flex-col gap-4 pb-12 pt-1 lg:gap-6">
							{banner}
							<main id={mainId} tabIndex={-1} className="min-w-0 space-y-4 focus:outline-none lg:space-y-6">
								{children}
							</main>
						</div>
					</div>
				</div>
			</div>
		</NavigationProgress>
	);
}
