'use client';
/**
 * Console frame (owner 2026-10-14: floating, never glued to the window edges): a sidebar panel (brand, sections of
 * links, each link with an icon tile — the accent tint with a `kind`, solid for the current page) and a top bar panel
 * (switchers on the left, account actions and the System / Light / Dark theme switch on the right) that stays on top of
 * the page as it scrolls, both with space around them. The switchers keep at least 10rem on one line with the menu
 * button; where that and the actions do not fit, the actions move to a second row. The top bar and the page share one
 * width (at most 1200 px, centered beside the sidebar) and one rhythm (24 px between blocks); the components inside
 * follow the width they get (container queries), not the screen's. Below 1024 px (`lg`, PLAN 0.6 Phones and tablets) the sidebar becomes an off-canvas panel opened by
 * the menu button.
 * Includes a skip link to the main content. Router links are rendered with `linkAs` (e.g. Next's `Link`).
 *
 * Motion (PLAN 0.6): the current item's tint is one marker that slides to the clicked item at once (before its page
 * arrives); items tint on hover and press in when clicked; the phone menu slides in and out; the frame holds the
 * `NavigationProgress` bar and stays still while pages change (`PageTransition`).
 * @module
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from './cx.js';
import { Icon } from './icons.js';
import { NavigationProgress, usePresence } from './motion.js';
import { useFocusTrap } from './overlay.js';
import { ThemeToggle } from './theme.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./display.js').Kind} Kind */
/**
 * A menu link; its icon sits in a small tile, in the accent tint when the link has a `kind` (PLAN 0.6 color rule).
 * @typedef {{ href: string, label: ReactNode, icon?: import('./icons.js').IconName, kind?: Kind, current?: boolean, badge?: ReactNode }} NavItem
 */
/** @typedef {{ label?: string, items: NavItem[] }} NavSection */

/**
 * A plain left click (not a new tab or window).
 * @param {import('react').MouseEvent} event
 */
const plainClick = (event) =>
	!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * @param {{ sections: NavSection[], linkAs?: import('react').ElementType, onNavigate?: () => void }} props
 */
function Nav({ sections, linkAs, onNavigate }) {
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
	}, [active, sections]);
	return (
		<nav ref={root} aria-label="Main" className="relative isolate space-y-6">
			<span
				ref={marker}
				aria-hidden="true"
				className={cx(
					'pointer-events-none absolute inset-x-0 top-0 -z-10 rounded-control bg-primary-soft opacity-0',
					placed && 'transition-[transform,opacity] duration-(--ss-motion-slow) ease-ss-move',
				)}
			/>
			{sections.map((section, i) => (
				<div key={section.label ?? i} className="space-y-1">
					{section.label ? <p className="px-2.5 pb-1 text-xs font-medium text-muted">{section.label}</p> : null}
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
										className={cx(
											'ss-motion ss-press flex items-center gap-2.5 rounded-control px-2 py-1.5 text-sm',
											'focus-visible:outline-2 focus-visible:outline-focus',
											on
												? cx('font-semibold text-on-primary-soft', placed ? 'bg-transparent' : 'bg-primary-soft')
												: 'font-medium text-fg/80 hover:bg-surface-2 hover:text-fg',
										)}>
										{item.icon ? (
											<span
												aria-hidden="true"
												className={cx(
													'ss-motion flex size-7 shrink-0 items-center justify-center rounded-lg',
													on
														? 'bg-primary text-on-primary'
														: item.kind
															? 'bg-primary-soft text-primary'
															: 'bg-surface-2 text-muted',
												)}>
												<Icon name={item.icon} size={15} />
											</span>
										) : null}
										<span className="min-w-0 flex-1 truncate">{item.label}</span>
										{item.badge}
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
 * The product's mark and name; `compact` (the phone top bar) shows the name only.
 * @param {{ name: ReactNode, tagline?: ReactNode, compact?: boolean }} props
 */
function Brand({ name, tagline, compact = false }) {
	return (
		<div className={cx('flex min-w-0 items-center gap-2.5', !compact && 'px-1.5')}>
			<span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-primary text-on-primary">
				<Icon name="zap" size={16} />
			</span>
			<span className="min-w-0">
				<span className="block truncate font-display text-base font-extrabold leading-tight tracking-[-0.01em] text-fg">
					{name}
				</span>
				{tagline && !compact ? <span className="block truncate text-xs text-muted">{tagline}</span> : null}
			</span>
		</div>
	);
}

/**
 * @param {{ brand?: { name: ReactNode, tagline?: ReactNode }, sections: NavSection[], topbar?: ReactNode,
 *   actions?: ReactNode, banner?: ReactNode, children: ReactNode, linkAs?: import('react').ElementType,
 *   sidebarFooter?: ReactNode, mainId?: string, themeToggle?: boolean }} props `themeToggle`: show the theme switch
 *   (default true)
 */
export function AppShell({
	brand = { name: 'Single Solution', tagline: 'Console' },
	sections,
	topbar,
	actions,
	banner,
	children,
	linkAs,
	sidebarFooter,
	mainId = 'main',
	themeToggle = true,
}) {
	const [open, setOpen] = useState(false);
	const panel = useRef(/** @type {HTMLDivElement | null} */ (null));
	const drawer = usePresence(open);
	useFocusTrap(panel, open, () => setOpen(false));
	useEffect(() => {
		if (!open) return undefined;
		const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(min-width: 1024px)') : null;
		const onChange = () => {
			if (media?.matches) setOpen(false);
		};
		media?.addEventListener?.('change', onChange);
		return () => media?.removeEventListener?.('change', onChange);
	}, [open]);
	return (
		<NavigationProgress>
			<div className="min-h-screen bg-canvas text-fg">
				<a
					href={`#${mainId}`}
					className="sr-only z-[70] rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
					Skip to content
				</a>
				<div className="flex w-full gap-4 p-3 sm:p-4 lg:gap-6 lg:p-6">
					<aside className="sticky top-6 hidden h-[calc(100vh-3rem)] w-60 shrink-0 flex-col justify-between overflow-y-auto rounded-card border border-line-soft bg-surface p-3 [view-transition-name:ss-sidebar] lg:flex">
						<div className="space-y-7">
							<Brand {...brand} />
							<Nav sections={sections} {...(linkAs ? { linkAs } : {})} />
						</div>
						{sidebarFooter ? <div className="pt-4">{sidebarFooter}</div> : null}
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
								className="flex h-full w-72 max-w-[85vw] animate-ss-drawer flex-col justify-between overflow-y-auto rounded-card bg-surface p-3 shadow-overlay group-data-[state=closed]:animate-ss-drawer-out">
								<div className="space-y-7">
									<div className="flex items-center justify-between">
										<Brand {...brand} />
										<button
											type="button"
											onClick={() => setOpen(false)}
											aria-label="Close navigation"
											className="ss-motion ss-press rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
											<Icon name="close" size={16} />
										</button>
									</div>
									<Nav sections={sections} {...(linkAs ? { linkAs } : {})} onNavigate={() => setOpen(false)} />
								</div>
								{sidebarFooter ? <div className="pt-4">{sidebarFooter}</div> : null}
							</div>
						</div>
					) : null}
					<div className="flex min-w-0 flex-1 flex-col">
						<div className="sticky top-0 z-30 -mt-3 bg-canvas pt-3 [view-transition-name:ss-topbar] sm:-mt-4 sm:pt-4 lg:-mt-6 lg:pt-6">
							<header className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-3 rounded-card border border-line-soft bg-surface px-2 py-2 sm:px-3">
								<div className={cx('flex min-w-0 items-center gap-2', topbar ? 'flex-[1_1_10rem]' : 'flex-1')}>
									<button
										type="button"
										onClick={() => setOpen(true)}
										aria-label="Open navigation"
										aria-expanded={open}
										className="ss-motion ss-press shrink-0 rounded-lg p-2 text-fg hover:bg-surface-2 lg:hidden">
										<Icon name="menu" size={18} />
									</button>
									{!topbar ? (
										<span className="lg:hidden">
											<Brand {...brand} compact />
										</span>
									) : null}
									{topbar ? <div className="flex min-w-0 flex-1 items-center gap-2">{topbar}</div> : null}
								</div>
								{actions || themeToggle ? (
									<div className="flex items-center gap-2">
										{themeToggle ? <ThemeToggle /> : null}
										{actions}
									</div>
								) : null}
							</header>
						</div>
						<div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 pb-16 pt-6">
							{banner}
							<main id={mainId} tabIndex={-1} className="min-w-0 space-y-6 focus:outline-none">
								{children}
							</main>
						</div>
					</div>
				</div>
			</div>
		</NavigationProgress>
	);
}
