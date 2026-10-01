'use client';
/**
 * Console frame: a floating sidebar island (brand, sections of links) and a top bar island (switchers on the left,
 * account actions on the right). Below `md` the sidebar becomes an off-canvas panel opened by the menu button.
 * Includes a skip link to the main content. Router links are rendered with `linkAs` (e.g. Next's `Link`).
 * @module
 */
import { useEffect, useRef, useState } from 'react';
import { cx } from './cx.js';
import { Icon } from './icons.js';
import { useFocusTrap } from './overlay.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {{ href: string, label: ReactNode, icon?: import('./icons.js').IconName, current?: boolean, badge?: ReactNode }} NavItem */
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
										'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-semibold transition-colors',
										'focus-visible:outline-2 focus-visible:outline-focus',
										item.current
											? 'bg-primary-soft text-on-primary-soft'
											: 'text-muted hover:bg-surface-2 hover:text-fg',
									)}>
									{item.icon ? <Icon name={item.icon} size={16} /> : null}
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
			<span className="flex size-9 items-center justify-center rounded-xl bg-primary text-on-primary shadow-card">
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
 *   sidebarFooter?: ReactNode, mainId?: string }} props
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
			<div className="mx-auto flex max-w-[1440px] gap-4 p-3 sm:p-4">
				<aside className="sticky top-4 hidden h-[calc(100vh-2rem)] w-64 shrink-0 flex-col justify-between overflow-y-auto rounded-card border border-line bg-surface p-4 shadow-card md:flex">
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
							className="flex h-full w-72 max-w-[85vw] flex-col justify-between overflow-y-auto border-r border-line bg-surface p-4 shadow-overlay">
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
				<div className="flex min-w-0 flex-1 flex-col gap-4">
					<header className="sticky top-3 z-30 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface/95 px-3 py-2.5 shadow-card backdrop-blur sm:top-4 sm:px-4">
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
						{actions ? <div className="flex items-center gap-2">{actions}</div> : null}
					</header>
					{banner}
					<main id={mainId} tabIndex={-1} className="min-w-0 space-y-6 pb-12 focus:outline-none">
						{children}
					</main>
				</div>
			</div>
		</div>
	);
}
