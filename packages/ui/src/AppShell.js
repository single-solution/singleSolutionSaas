'use client';
/**
 * Console frame: a soft sidebar island (brand, sections of links, each link with an icon tile in the colour of its `kind`) and a top bar island (switchers on the left,
 * account actions and the System / Light / Dark theme switch on the right). The frame uses the available width (16 px
 * side padding on phones, 24–32 px from `md`, at most 1600 px wide); pages decide their own reading widths. Below `md`
 * the sidebar becomes an off-canvas panel opened by the menu button.
 * Includes a skip link to the main content. Router links are rendered with `linkAs` (e.g. Next's `Link`).
 * @module
 */
import { useEffect, useRef, useState } from 'react';
import { cx } from './cx.js';
import { Icon } from './icons.js';
import { useFocusTrap } from './overlay.js';
import { ThemeToggle } from './theme.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./display.js').Kind} Kind */
/**
 * A menu link; its icon sits in a small tile tinted with the colour of its `kind` (PLAN 0.6 colour rule).
 * @typedef {{ href: string, label: ReactNode, icon?: import('./icons.js').IconName, kind?: Kind, current?: boolean, badge?: ReactNode }} NavItem
 */
/** @typedef {{ label?: string, items: NavItem[] }} NavSection */

/**
 * @param {{ sections: NavSection[], linkAs?: import('react').ElementType, onNavigate?: () => void }} props
 */
function Nav({ sections, linkAs, onNavigate }) {
	const LinkTag = linkAs ?? 'a';
	return (
		<nav aria-label="Main" className="space-y-5">
			{sections.map((section, i) => (
				<div key={section.label ?? i} className="space-y-1">
					{section.label ? (
						<p className="px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted">{section.label}</p>
					) : null}
					<ul className="space-y-0.5">
						{section.items.map((item) => (
							<li key={item.href}>
								<LinkTag
									href={item.href}
									onClick={onNavigate}
									aria-current={item.current ? 'page' : undefined}
									className={cx(
										'flex items-center gap-3 rounded-[12px] px-2.5 py-2 text-sm font-semibold transition-colors',
										'focus-visible:outline-2 focus-visible:outline-focus',
										item.current ? 'bg-primary-soft text-on-primary-soft' : 'text-fg hover:bg-surface-2',
									)}>
									{item.icon ? (
										<span
											aria-hidden="true"
											{...(item.current || !item.kind ? {} : { 'data-tone': item.kind })}
											className={cx(
												'flex size-[26px] shrink-0 items-center justify-center rounded-[9px]',
												item.current
													? 'bg-primary text-on-primary'
													: item.kind
														? 'bg-tone-tint text-tone-ink'
														: 'bg-surface-2 text-muted',
											)}>
											<Icon name={item.icon} size={15} />
										</span>
									) : null}
									<span className="min-w-0 flex-1 truncate">{item.label}</span>
									{item.badge}
								</LinkTag>
							</li>
						))}
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
		<div className="min-h-screen bg-canvas text-fg">
			<a
				href={`#${mainId}`}
				className="sr-only z-[70] rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-on-primary focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
				Skip to content
			</a>
			<div className="mx-auto flex w-full max-w-[1680px] gap-5 px-4 py-3 sm:py-4 md:px-6 lg:gap-6 lg:px-8">
				<aside className="sticky top-4 hidden h-[calc(100vh-2rem)] w-64 shrink-0 flex-col justify-between overflow-y-auto rounded-card bg-surface p-4 md:flex">
					<div className="space-y-6">
						<Brand {...brand} />
						<Nav sections={sections} {...(linkAs ? { linkAs } : {})} />
					</div>
					{sidebarFooter ? <div className="pt-4">{sidebarFooter}</div> : null}
				</aside>
				{open ? (
					<div
						className="fixed inset-0 z-50 bg-overlay md:hidden"
						onMouseDown={(event) => {
							if (event.target === event.currentTarget) setOpen(false);
						}}>
						<div
							ref={panel}
							role="dialog"
							aria-modal="true"
							aria-label="Navigation"
							className="flex h-full w-72 max-w-[85vw] flex-col justify-between overflow-y-auto bg-surface p-4">
							<div className="space-y-6">
								<div className="flex items-center justify-between">
									<Brand {...brand} />
									<button
										type="button"
										onClick={() => setOpen(false)}
										aria-label="Close navigation"
										className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
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
					<header className="sticky top-3 z-30 flex flex-wrap items-center justify-between gap-3 rounded-card bg-surface/95 px-3 py-2.5 backdrop-blur sm:top-4 sm:px-4">
						<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
							<button
								type="button"
								onClick={() => setOpen(true)}
								aria-label="Open navigation"
								aria-expanded={open}
								className="rounded-lg p-2 text-fg hover:bg-surface-2 md:hidden">
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
					{banner}
					<main id={mainId} tabIndex={-1} className="min-w-0 space-y-8 pb-16 focus:outline-none">
						{children}
					</main>
				</div>
			</div>
		</div>
	);
}
