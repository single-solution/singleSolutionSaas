'use client';
/**
 * Console frame: a soft sidebar island (brand, sections of links, each link with an icon tile — the accent tint with a
 * `kind`, solid for the current page) and a top bar island (switchers on the left, account actions and the System /
 * Light / Dark theme switch on the right) that stays on top of the page as it scrolls. The frame uses the available
 * width (16 px side padding on phones, 24–32 px from `md`, at most 1680 px wide); pages decide their own reading
 * widths. Below `md` the sidebar becomes an off-canvas panel opened by the menu button.
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
 * A menu link; its icon sits in a small tile, in the accent tint when the link has a `kind` (PLAN 0.6 colour rule).
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
		<nav ref={root} aria-label="Main" className="relative isolate space-y-5">
			<span
				ref={marker}
				aria-hidden="true"
				className={cx(
					'pointer-events-none absolute inset-x-0 top-0 -z-10 rounded-[12px] bg-primary-soft opacity-0',
					placed && 'transition-[transform,opacity] duration-(--ss-motion-slow) ease-ss-move',
				)}
			/>
			{sections.map((section, i) => (
				<div key={section.label ?? i} className="space-y-1">
					{section.label ? (
						<p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted">{section.label}</p>
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
										className={cx(
											'ss-motion ss-press flex items-center gap-3 rounded-[12px] px-2.5 py-2 text-sm font-semibold',
											'focus-visible:outline-2 focus-visible:outline-focus',
											on
												? cx('text-on-primary-soft', placed ? 'bg-transparent' : 'bg-primary-soft')
												: 'text-fg hover:bg-surface-2',
										)}>
										{item.icon ? (
											<span
												aria-hidden="true"
												className={cx(
													'ss-motion flex size-[26px] shrink-0 items-center justify-center rounded-[9px]',
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
 * @param {{ name: ReactNode, tagline?: ReactNode }} props
 */
function Brand({ name, tagline }) {
	return (
		<div className="flex items-center gap-3 px-2">
			<span className="flex size-9 items-center justify-center rounded-xl bg-primary text-on-primary">
				<Icon name="zap" size={18} />
			</span>
			<span className="min-w-0">
				<span className="block truncate text-sm font-extrabold leading-tight tracking-tight text-fg">{name}</span>
				{tagline ? <span className="block text-[11px] font-bold uppercase tracking-wider text-muted">{tagline}</span> : null}
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
		const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(min-width: 768px)') : null;
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
				<div className="mx-auto flex w-full max-w-[1680px] gap-5 px-4 py-3 sm:py-4 md:px-6 lg:gap-6 lg:px-8">
					<aside className="sticky top-4 hidden h-[calc(100vh-2rem)] w-64 shrink-0 flex-col justify-between overflow-y-auto rounded-card bg-surface p-4 [view-transition-name:ss-sidebar] md:flex">
						<div className="space-y-6">
							<Brand {...brand} />
							<Nav sections={sections} {...(linkAs ? { linkAs } : {})} />
						</div>
						{sidebarFooter ? <div className="pt-4">{sidebarFooter}</div> : null}
					</aside>
					{drawer.mounted ? (
						<div
							ref={drawer.ref}
							data-state={drawer.closing ? 'closed' : 'open'}
							className="group fixed inset-0 z-50 animate-ss-fade bg-overlay data-[state=closed]:pointer-events-none data-[state=closed]:animate-ss-fade-out md:hidden"
							onMouseDown={(event) => {
								if (event.target === event.currentTarget) setOpen(false);
							}}>
							<div
								ref={panel}
								role="dialog"
								aria-modal="true"
								aria-label="Navigation"
								className="flex h-full w-72 max-w-[85vw] animate-ss-drawer flex-col justify-between overflow-y-auto bg-surface p-4 group-data-[state=closed]:animate-ss-drawer-out">
								<div className="space-y-6">
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
					<div className="flex min-w-0 flex-1 flex-col gap-6">
						<div className="sticky top-0 z-30 -mt-3 bg-canvas pt-3 [view-transition-name:ss-topbar] sm:-mt-4 sm:pt-4">
							<header className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-surface px-3 py-2.5 sm:px-4">
								<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
									<button
										type="button"
										onClick={() => setOpen(true)}
										aria-label="Open navigation"
										aria-expanded={open}
										className="ss-motion ss-press rounded-lg p-2 text-fg hover:bg-surface-2 md:hidden">
										<Icon name="menu" size={18} />
									</button>
									{topbar}
								</div>
								{actions || themeToggle ? (
									<div className="flex items-center gap-2">
										{themeToggle ? <ThemeToggle /> : null}
										{actions}
									</div>
								) : null}
							</header>
						</div>
						{banner}
						<main id={mainId} tabIndex={-1} className="min-w-0 space-y-8 pb-16 focus:outline-none">
							{children}
						</main>
					</div>
				</div>
			</div>
		</NavigationProgress>
	);
}
