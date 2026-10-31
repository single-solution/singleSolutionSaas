'use client';
/**
 * The page (layout contract 2026-10-17, item 2): the ONE wrapper of every screen, on every level. Under the frame's
 * sidebar it draws a one-line header (the breadcrumbs, the last step being the title; status pills; up to four clickable
 * numbers; the actions: one primary, up to two secondary and a More menu; the page's description behind an (i)), then an
 * optional inner navigation beside the main panel, which holds a fixed toolbar, the page's body (the only thing that
 * scrolls) and a fixed footer (pagination). The window never scrolls (R1); the title lives only in the header (R2).
 * `loading` draws the page's own skeleton in the same sizes, `error` an error in the body.
 *
 * The header is a size container (Tailwind `@container`), so its parts give way by its own width, not the window's, and the
 * title always wins (it keeps its place, cuts its own text with an ellipsis and has the full text as a tooltip). From
 * wide to narrow (the width inside the header's padding): below 72rem the third and fourth number hide; below 60rem all
 * numbers; below 48rem the secondary actions move into More (R9); below 40rem only the title of the breadcrumbs shows;
 * below 32rem a status pill shows only its dot (its label is the tooltip and the screen-reader text); below 28rem the
 * primary action shows only its icon (its label is the `aria-label`). Numbers and button labels cut their own text, so
 * nothing overlaps. On phones the frame's menu button leads the header and the inner navigation is a dropdown above the
 * panel.
 *
 * With `list` (a `ListColumn` element) the column of rich rows is drawn where the inner navigation goes (it wins over `nav`
 * and over the sections' jump list) and the body is the picked item's page; the body fades and rises when the picked
 * item changes. On phones one of the two shows: the list while nothing is picked, else the body with a Back button
 * in the header that calls the list's `onBack`.
 *
 * With `sections` the body shows every section of the page at once, all open, and the page has one save bar for all of
 * them (see `page-sections.js`); from four sections up the inner navigation lists them as jumps.
 *
 * Inside an `AppShell` the frame's own header hides itself while a page draws this one (`:has([data-ss-page])`), so old
 * pages keep working until they move onto this component.
 * @module
 */
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { cx } from './cx.js';
import { DOTS, ErrorState, RemovedState, StatusPill } from './display.js';
import { SaveBar } from './blocks.js';
import { Button, IconButton } from './Button.js';
import { Icon } from './icons.js';
import { InnerNav } from './InnerNav.js';
import { ActionMenu } from './Menu.js';
import { PAGE, pageBody } from './layout-metrics.js';
import { LIST_COLUMN_TEXTS } from './ListColumn.js';
import { PageSectionList, markChanged, usePageSections } from './page-sections.js';
import { useShell } from './AppShell.js';
import { PageSkeleton } from './skeletons.js';
import { PickKeepsEditsContext, askLeave } from './unsaved.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./display.js').Tone} Tone */
/** @typedef {import('./Menu.js').MenuItem} MenuItem */
/** One step of the breadcrumbs: a link (`href`); the last step is the page's title. @typedef {{ label: ReactNode, href?: string }} PageCrumb */
/**
 * A live number in the header ("Open 12", "Balance 1,250"). With `onClick` it is a filter button (`active` while on),
 * with `href` a link, otherwise plain text.
 * @typedef {object} PageFact
 * @property {ReactNode} label
 * @property {ReactNode} value
 * @property {Tone} [tone]
 * @property {string} [href]
 * @property {() => void} [onClick]
 * @property {boolean} [active]
 * @property {string} [title]
 */
/**
 * A button in the header. `onClick` may return a promise: the button shows its spinner until it settles.
 * @typedef {object} PageAction
 * @property {string} label
 * @property {() => void | Promise<unknown>} onClick
 * @property {import('./icons.js').IconName} [icon]
 * @property {boolean} [disabled]
 * @property {boolean} [loading]
 * @property {string} [title]
 */
/**
 * The page's actions, the only place for them (layout rule R6): one primary, at most two secondary, the rest in More.
 * On phones the secondary ones move into More.
 * @typedef {{ primary?: PageAction, secondary?: PageAction[], more?: MenuItem[] }} PageActions
 */
/** @typedef {{ status: import('./display.js').PillStatus, label: ReactNode, title?: string }} PageStatus */
/** @typedef {{ breadcrumb: string, info: string, more: string, menu: string, facts: string, sectionMoved: string, itemRemoved: string, back: string }} PageTexts */

/** The words a page's header says itself (replace them to translate). @type {Readonly<PageTexts>} */
export const PAGE_TEXTS = Object.freeze({
	breadcrumb: 'Breadcrumb',
	info: 'About this page',
	more: 'More actions',
	menu: 'Open navigation',
	facts: 'Key numbers',
	sectionMoved: 'That section was moved or removed.',
	itemRemoved: 'This item was removed or you no longer have access.',
	back: 'Back to the list',
});

/** Below this width the header has room for the title and the primary action only (Tailwind `sm`). */
const PHONE = '(max-width: 639px)';

/**
 * Whether the window is a phone; false until the page is in the browser and where the browser cannot tell.
 * @returns {boolean}
 */
export const useNarrow = () => {
	const [narrow, setNarrow] = useState(false);
	useLayoutEffect(() => {
		if (!window.matchMedia) return undefined;
		const media = window.matchMedia(PHONE);
		const read = () => setNarrow(media.matches);
		read();
		media.addEventListener('change', read);
		return () => media.removeEventListener('change', read);
	}, []);
	return narrow;
};

/**
 * The button that opens the navigation sheet, on phones; only inside a console frame.
 * @param {{ texts?: Partial<PageTexts> }} props
 */
export function ShellMenuButton({ texts }) {
	const { openNav } = useShell();
	if (!openNav) return null;
	return (
		<button
			type="button"
			onClick={openNav}
			aria-label={texts?.menu ?? PAGE_TEXTS.menu}
			className="ss-motion ss-press shrink-0 rounded-control p-2 text-fg hover:bg-surface-2 lg:hidden">
			<Icon name="menu" size={18} />
		</button>
	);
}

/**
 * The breadcrumbs, every step a link, and the page title (the last step) as the page's one heading.
 * @param {{ crumbs: PageCrumb[], linkAs?: import('react').ElementType, titleId?: string, texts?: Partial<PageTexts> }} props
 */
export function Crumbs({ crumbs, linkAs, titleId, texts }) {
	const LinkTag = linkAs ?? 'a';
	const last = crumbs.length - 1;
	return (
		<nav aria-label={texts?.breadcrumb ?? PAGE_TEXTS.breadcrumb} className="min-w-0">
			<ol className="flex min-w-0 items-center gap-1.5">
				{crumbs.map((crumb, i) =>
					i === last ? (
						<li key={i} className="max-w-full shrink-0 truncate">
							<h1
								id={titleId}
								aria-current="page"
								{...(typeof crumb.label === 'string' ? { title: crumb.label } : {})}
								className="truncate font-display text-title font-semibold tracking-[-0.02em] text-fg">
								{crumb.label}
							</h1>
						</li>
					) : (
						<Fragment key={i}>
							<li className="hidden max-w-[10rem] min-w-8 shrink truncate font-mono text-micro tracking-[0.04em] text-muted uppercase @[40rem]:block">
								{crumb.href ? (
									<LinkTag
										href={crumb.href}
										{...(typeof crumb.label === 'string' ? { title: crumb.label } : {})}
										className="ss-motion rounded-control hover:text-fg">
										{crumb.label}
									</LinkTag>
								) : (
									crumb.label
								)}
							</li>
							<li
								aria-hidden="true"
								className="hidden shrink-0 font-mono text-micro text-subtle before:content-['/'] @[40rem]:block"
							/>
						</Fragment>
					),
				)}
			</ol>
		</nav>
	);
}

/** The look of every fact: a hard Unite chip with a muted label and the value in full color; it cuts its own text. */
const FACT =
	'inline-flex h-7 max-w-full min-w-0 shrink items-center gap-1.5 whitespace-nowrap rounded-control border border-line bg-canvas px-2.5 text-label text-muted';

/**
 * One fact of the header.
 * @param {{ fact: PageFact, linkAs?: import('react').ElementType }} props
 */
export function Fact({ fact, linkAs }) {
	const LinkTag = linkAs ?? 'a';
	const body = (
		<>
			{fact.tone ? <span aria-hidden="true" className={cx('size-1.5 shrink-0 rounded-full', DOTS[fact.tone])} /> : null}
			<span className="min-w-0 truncate">{fact.label}</span>
			<span className="min-w-0 truncate font-medium text-fg tabular-nums">{fact.value}</span>
		</>
	);
	const tip =
		fact.title ??
		([fact.label, fact.value].every((part) => typeof part === 'string' || typeof part === 'number')
			? `${fact.label} ${fact.value}`
			: undefined);
	const common = { 'data-ss-fact': '', ...(tip ? { title: tip } : {}) };
	if (fact.onClick)
		return (
			<button
				type="button"
				{...common}
				aria-pressed={Boolean(fact.active)}
				onClick={fact.onClick}
				className={cx(
					FACT,
					'ss-motion ss-press focus-visible:outline-2 focus-visible:outline-focus',
					fact.active ? 'border-line bg-surface text-fg ss-hard' : 'hover:bg-surface-2',
				)}>
				{body}
			</button>
		);
	if (fact.href)
		return (
			<LinkTag href={fact.href} {...common} className={cx(FACT, 'ss-motion hover:bg-line-soft')}>
				{body}
			</LinkTag>
		);
	return (
		<span {...common} className={FACT}>
			{body}
		</span>
	);
}

/**
 * The (i) beside the title: the page's old description in a small popover.
 * @param {{ label: string, children: ReactNode }} props
 */
export function InfoButton({ label, children }) {
	const [open, setOpen] = useState(false);
	const root = useRef(/** @type {HTMLDivElement | null} */ (null));
	const id = useId();
	useEffect(() => {
		if (!open) return undefined;
		/** @param {KeyboardEvent} event */
		const onKey = (event) => {
			if (event.key === 'Escape') setOpen(false);
		};
		/** @param {MouseEvent} event */
		const onDown = (event) => {
			if (!root.current?.contains(/** @type {Node} */ (event.target))) setOpen(false);
		};
		document.addEventListener('keydown', onKey);
		document.addEventListener('mousedown', onDown);
		return () => {
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('mousedown', onDown);
		};
	}, [open]);
	return (
		<div ref={root} className="relative shrink-0">
			<button
				type="button"
				aria-label={label}
				aria-expanded={open}
				{...(open ? { 'aria-controls': id } : {})}
				onClick={() => setOpen((o) => !o)}
				className="ss-motion ss-press flex size-8 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
				<Icon name="info" size={16} />
			</button>
			{open ? (
				<div
					id={id}
					className="absolute top-full left-0 z-30 mt-2 w-80 max-w-[85vw] origin-top-left animate-ss-pop rounded-card border border-line bg-surface p-3 text-sm text-pretty text-muted shadow-overlay">
					{children}
				</div>
			) : null}
		</div>
	);
}

/**
 * A page action as a menu item (for narrow headers).
 * @param {PageAction} action
 * @param {string} [className]
 * @returns {MenuItem}
 */
const asItem = (action, className) => ({
	label: action.label,
	onSelect: () => {
		void action.onClick();
	},
	...(action.icon ? { icon: action.icon } : {}),
	...(action.disabled ? { disabled: true } : {}),
	...(className ? { className } : {}),
});

/**
 * The actions at the right of the header: the primary button, up to two secondary ones, then More.
 * @param {{ actions: PageActions, narrow: boolean, texts?: Partial<PageTexts>, byWidth?: boolean }} props
 */
export function HeaderActions({ actions, narrow, texts, byWidth = false }) {
	const secondary = (actions.secondary ?? []).slice(0, 2);
	const more = actions.more ?? [];
	const folded = byWidth && !narrow;
	const items = [
		...(narrow || byWidth ? secondary.map((action) => asItem(action, folded ? '@3xl:hidden' : undefined)) : []),
		...more,
	];
	/** @param {PageAction} action @param {'primary' | 'secondary'} variant */
	const button = (action, variant) => {
		const iconOnly = byWidth && variant === 'primary' && Boolean(action.icon);
		return (
			<Button
				key={action.label}
				variant={variant}
				className={cx(
					byWidth ? 'max-w-[14rem]' : variant === 'secondary' && 'max-sm:hidden',
					byWidth && variant === 'secondary' && '@max-3xl:hidden',
					iconOnly && '@max-md:w-9 @max-md:px-0',
				)}
				onClick={action.onClick}
				{...(action.disabled ? { disabled: true } : {})}
				{...(action.loading ? { loading: true } : {})}
				{...(action.title || iconOnly ? { title: action.title ?? action.label } : {})}
				{...(iconOnly ? { 'aria-label': action.label } : {})}
				{...(action.icon ? { icon: <Icon name={action.icon} size={15} /> } : {})}>
				{byWidth ? (
					<span className={cx('min-w-0 truncate', iconOnly && '@max-md:sr-only')}>{action.label}</span>
				) : (
					action.label
				)}
			</Button>
		);
	};
	return (
		<div className="flex shrink-0 items-center gap-2">
			{actions.primary ? button(actions.primary, 'primary') : null}
			{narrow ? null : secondary.map((action) => button(action, 'secondary'))}
			{items.length > 0 ? (
				<ActionMenu
					label={texts?.more ?? PAGE_TEXTS.more}
					items={items}
					size="md"
					{...(folded && more.length === 0 ? { className: '@3xl:hidden' } : {})}
				/>
			) : null}
		</div>
	);
}
/** @typedef {import('./page-sections.js').PageSection} PageSection */
/** @typedef {Parameters<typeof InnerNav>[0]} PageNav */
/** @typedef {import('react').ReactElement<{ selected?: string | number | null, onBack?: () => void, onSelect?: (id: any) => void, items?: any[], idOf?: (item: any) => any, loading?: boolean, texts?: Partial<import('./ListColumn.js').ListColumnTexts> }>} PageList */

/**
 * @param {{ crumbs: PageCrumb[], status?: PageStatus[], facts?: PageFact[], actions?: PageActions, info?: ReactNode,
 *   nav?: PageNav, list?: PageList, sections?: PageSection[], toolbar?: ReactNode, footer?: ReactNode, loading?: boolean,
 *   error?: string | { title?: string, message?: ReactNode, action?: ReactNode }, flush?: boolean,
 *   bodyKey?: string, skeleton?: ReactNode, linkAs?: import('react').ElementType, texts?: Partial<PageTexts & import('./unsaved.js').UnsavedTexts>,
 *   className?: string, children?: ReactNode }} props `crumbs`: every step a link, the last one the title (and the
 *   page's one heading); `status`: pills after the title; `facts`: live numbers, at most four, each a filter button
 *   (`onClick`), a link (`href`) or plain; `actions`: `{ primary, secondary (at most two), more }`; `info`: the page's
 *   description, shown from an (i); `nav`: the props of an `InnerNav` (the page's sub-pages); `list`: a `ListColumn` element, drawn in place of
 *   the navigation, the page being the picked item (set `bodyKey` to its id; the element's `selected` and `onBack` tell the
 *   page what to show on phones); `sections`: the
 *   parts of the page, all drawn at once in place of `children` (each `{ id, label, icon?, dot?, dotLabel?, body }`), with
 *   the jump list from four of them (`nav` wins when given) and one save bar for the page, which names the sections
 *   with changes (each name jumps to its section) while those sections carry a "Changed" mark in the navigation; `toolbar`: a `Toolbar`;
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
	list,
	sections,
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
	const flow = usePageSections(sections, words);
	const link = linkAs ?? shell.linkAs;
	// the sections with changes carry a mark in the navigation, in the words of the page's texts
	const rail = list ? undefined : nav ? markChanged(nav, flow.changed) : flow.nav;
	const railTexts = texts?.changed ? { changed: texts.changed } : undefined;
	// on phones a list page shows the list or the picked item, one at a time
	const picked = list?.props.selected;
	const hasPick = picked !== null && picked !== undefined;
	const listItems = list?.props.items;
	const idOf = list?.props.idOf ?? ((/** @type {any} */ item) => item?.id);
	const knownListIds = listItems && Array.isArray(listItems) ? listItems.map((item) => String(idOf(item))) : [];
	const itemMissing =
		Boolean(list) && !list?.props.loading && knownListIds.length > 0 && hasPick && !knownListIds.includes(String(picked));
	const listOnly = Boolean(list) && narrow && !hasPick;
	// a body with a key of its own that does not follow the pick stays mounted, so a pick loses no edit
	const keepsEdits = Boolean(list) && bodyKey !== undefined && bodyKey !== String(picked ?? '');
	// the Back button moves away from the picked item: with unsaved changes it asks first
	const onBack = list && narrow && hasPick ? list.props.onBack : undefined;
	const back = onBack ? (keepsEdits ? onBack : () => askLeave(onBack)) : undefined;
	const listBack = list?.props.onBack ?? (list?.props.onSelect ? () => list.props.onSelect?.(null) : undefined);
	if (loading)
		return (
			<PageSkeleton
				crumbs={crumbs}
				{...(link ? { linkAs: link } : {})}
				nav={Boolean(rail) || Boolean(list)}
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
				{back ? (
					<IconButton label={list?.props.texts?.back ?? LIST_COLUMN_TEXTS.back} onClick={back}>
						<Icon name="chevronLeft" size={16} />
					</IconButton>
				) : null}
				<div className="flex min-w-0 shrink items-center gap-1 @max-[60rem]:min-w-[10.5rem]">
					<Crumbs crumbs={crumbs} titleId={titleId} texts={words} {...(link ? { linkAs: link } : {})} />
					{info ? <InfoButton label={words.info}>{info}</InfoButton> : null}
					{status && status.length > 0 ? (
						<div className="ml-1 flex shrink-0 items-center gap-1.5">
							{status.map((pill, i) => {
								const tip = pill.title ?? (typeof pill.label === 'string' ? pill.label : undefined);
								return (
									<StatusPill
										key={i}
										status={pill.status}
										className="@max-[32rem]:gap-0 @max-[32rem]:text-[0px]"
										{...(tip ? { title: tip } : {})}>
										{pill.label}
									</StatusPill>
								);
							})}
						</div>
					) : null}
				</div>
				{facts && facts.length > 0 ? (
					<ul
						aria-label={words.facts}
						className="-m-0.5 hidden min-w-0 shrink-[8] items-center gap-1.5 overflow-hidden p-0.5 @[60rem]:flex">
						{facts.slice(0, 4).map((fact, i) => (
							<li key={i} className={cx('min-w-0', i >= 2 ? 'hidden @[72rem]:flex' : 'flex')}>
								<Fact fact={fact} {...(link ? { linkAs: link } : {})} />
							</li>
						))}
					</ul>
				) : null}
				<div className="ml-auto flex shrink-0 items-center">
					{actions ? <HeaderActions actions={actions} narrow={narrow} texts={words} byWidth /> : null}
				</div>
			</header>
			<div className={list ? PAGE.listArea : PAGE.area}>
				{list && !(narrow && hasPick) ? (
					<PickKeepsEditsContext.Provider value={keepsEdits}>{list}</PickKeepsEditsContext.Provider>
				) : null}
				{rail ? (
					<InnerNav {...(link ? { linkAs: link } : {})} {...(railTexts ? { texts: railTexts } : {})} {...rail} />
				) : null}
				{listOnly ? null : (
					<section className={PAGE.main}>
						{bar ? (
							<div data-ss-part="toolbar" className={PAGE.toolbar}>
								{bar}
							</div>
						) : null}
						<div
							ref={flow.body}
							data-ss-part="body"
							className={pageBody({ toolbar: Boolean(bar), footer: Boolean(end) })}
							{...(flush ? {} : { role: 'region', tabIndex: 0, 'aria-labelledby': titleId })}>
							<div
								key={bodyKey ?? (list ? String(picked ?? '') : undefined)}
								className={cx(flush ? PAGE.flush : PAGE.padded, 'animate-ss-enter')}>
								{failure ? (
									<ErrorState
										{...(failure.title ? { title: failure.title } : {})}
										message={failure.message}
										{...(failure.action ? { action: failure.action } : {})}
									/>
								) : itemMissing ? (
									<RemovedState
										message={words.itemRemoved}
										action={
											listBack ? (
												<Button size="sm" variant="secondary" onClick={listBack}>
													{words.back}
												</Button>
											) : null
										}
									/>
								) : sections ? (
									<PageSectionList sections={sections} scopes={flow.scopes} changed={flow.changed} note={flow.note} />
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
				)}
			</div>
			{flow.bar ? <SaveBar {...flow.bar} {...(texts ? { texts } : {})} /> : null}
		</div>
	);
}
