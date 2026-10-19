'use client';
/**
 * The page (layout contract 2026-10-17, item 2): the ONE wrapper of every screen, on every level. Under the frame's
 * sidebar it draws a one-line header (the breadcrumbs, the last step being the title; status pills; up to four clickable
 * numbers; the actions: one primary, up to two secondary and a More menu; the page's description behind an (i)), then an
 * optional inner navigation beside the main panel, which holds a fixed toolbar, the page's body (the only thing that
 * scrolls) and a fixed footer (pagination). The window never scrolls (R1); the title lives only in the header (R2).
 * `loading` draws the page's own skeleton in the same sizes, `error` an error in the body.
 *
 * On phones (R9) the frame's menu button leads the header, only the title of the breadcrumbs shows, the numbers hide,
 * the secondary actions move into More, and the inner navigation is a dropdown above the panel.
 *
 * Inside an `AppShell` the frame's own header hides itself while a page draws this one (`:has([data-ss-page])`), so old
 * pages keep working until they move onto this component.
 * @module
 */
import { useId } from 'react';
import { cx } from './cx.js';
import { ErrorState, StatusPill } from './display.js';
import { InnerNav } from './InnerNav.js';
import { PAGE, pageBody } from './layout-metrics.js';
import { Crumbs, Fact, HeaderActions, InfoButton, PAGE_TEXTS, ShellMenuButton, useNarrow } from './page-parts.js';
import { useShell } from './shell-state.js';
import { PageSkeleton } from './skeletons.js';

export { PAGE_TEXTS };

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./page-parts.js').PageCrumb} PageCrumb */
/** @typedef {import('./page-parts.js').PageFact} PageFact */
/** @typedef {import('./page-parts.js').PageAction} PageAction */
/** @typedef {import('./page-parts.js').PageActions} PageActions */
/** @typedef {import('./page-parts.js').PageStatus} PageStatus */
/** @typedef {import('./page-parts.js').PageTexts} PageTexts */
/** @typedef {Parameters<typeof InnerNav>[0]} PageNav */

/**
 * @param {{ crumbs: PageCrumb[], status?: PageStatus[], facts?: PageFact[], actions?: PageActions, info?: ReactNode,
 *   nav?: PageNav, toolbar?: ReactNode, footer?: ReactNode, loading?: boolean,
 *   error?: string | { title?: string, message?: ReactNode, action?: ReactNode }, flush?: boolean,
 *   bodyKey?: string, skeleton?: ReactNode, linkAs?: import('react').ElementType, texts?: Partial<PageTexts>,
 *   className?: string, children?: ReactNode }} props `crumbs`: every step a link, the last one the title (and the
 *   page's one heading); `status`: pills after the title; `facts`: live numbers, at most four, each a filter button
 *   (`onClick`), a link (`href`) or plain; `actions`: `{ primary, secondary (at most two), more }`; `info`: the page's
 *   description, shown from an (i); `nav`: the props of an `InnerNav` (the page's sub-pages); `toolbar`: a `Toolbar`;
 *   `footer`: a `Pagination`; `loading`: draw the page's skeleton (`skeleton` is the body's own, a few settings cards by
 *   default); `error`: a message (or `{ title, message, action }`) in place of the body, toolbar and footer; `flush`: the
 *   body has no padding (a table uses all of it); `bodyKey`: when it changes (the sub-page) the body fades in again;
 *   `linkAs`: the router link (the frame's by default)
 */
export function Page({
	crumbs,
	status,
	facts,
	actions,
	info,
	nav,
	toolbar,
	footer,
	loading = false,
	error,
	flush = false,
	bodyKey,
	skeleton,
	linkAs,
	texts,
	className,
	children,
}) {
	const shell = useShell();
	const narrow = useNarrow();
	const titleId = useId();
	const words = { ...PAGE_TEXTS, ...texts };
	const link = linkAs ?? shell.linkAs;
	if (loading)
		return (
			<PageSkeleton
				crumbs={crumbs}
				{...(link ? { linkAs: link } : {})}
				nav={Boolean(nav)}
				toolbar={Boolean(toolbar)}
				footer={Boolean(footer)}
				flush={flush}
				{...(className ? { className } : {})}>
				{skeleton}
			</PageSkeleton>
		);
	const failure = typeof error === 'string' ? { message: error } : error;
	// a page that failed has no list to search or to page through
	const bar = !failure && toolbar;
	const end = !failure && footer;
	return (
		<div data-ss-page="" className={cx(PAGE.root, className)}>
			<header data-ss-part="header" className={PAGE.header}>
				<ShellMenuButton texts={words} />
				<div className="flex min-w-0 shrink items-center gap-1">
					<Crumbs crumbs={crumbs} titleId={titleId} texts={words} {...(link ? { linkAs: link } : {})} />
					{info ? <InfoButton label={words.info}>{info}</InfoButton> : null}
				</div>
				{status && status.length > 0 ? (
					<div className="flex min-w-0 shrink-0 items-center gap-1.5">
						{status.map((pill, i) => (
							<StatusPill key={i} status={pill.status} {...(pill.title ? { title: pill.title } : {})}>
								{pill.label}
							</StatusPill>
						))}
					</div>
				) : null}
				{facts && facts.length > 0 ? (
					<ul aria-label={words.facts} className="hidden min-w-0 items-center gap-1.5 md:flex">
						{facts.slice(0, 4).map((fact, i) => (
							<li key={i} className={cx(i >= 2 && 'hidden xl:block')}>
								<Fact fact={fact} {...(link ? { linkAs: link } : {})} />
							</li>
						))}
					</ul>
				) : null}
				<div className="ml-auto flex shrink-0 items-center">
					{actions ? <HeaderActions actions={actions} narrow={narrow} texts={words} /> : null}
				</div>
			</header>
			<div className={PAGE.area}>
				{nav ? <InnerNav {...(link ? { linkAs: link } : {})} {...nav} /> : null}
				<section className={PAGE.main}>
					{bar ? (
						<div data-ss-part="toolbar" className={PAGE.toolbar}>
							{bar}
						</div>
					) : null}
					<div
						data-ss-part="body"
						className={pageBody({ toolbar: Boolean(bar), footer: Boolean(end) })}
						{...(flush ? {} : { role: 'region', tabIndex: 0, 'aria-labelledby': titleId })}>
						<div key={bodyKey} className={cx(flush ? PAGE.flush : PAGE.padded, 'animate-ss-enter')}>
							{failure ? (
								<ErrorState
									{...(failure.title ? { title: failure.title } : {})}
									message={failure.message}
									{...(failure.action ? { action: failure.action } : {})}
								/>
							) : (
								children
							)}
						</div>
					</div>
					{end ? (
						<div data-ss-part="footer" className={PAGE.footer}>
							{end}
						</div>
					) : null}
				</section>
			</div>
		</div>
	);
}
