'use client';
/**
 * The parts of a {@link Page} header: the breadcrumbs with the title, a key number (fact), the (i) with the page's
 * description and the actions with their More menu. `PageSkeleton` draws the same breadcrumbs and menu button, so a page
 * that loads looks like the page that has loaded.
 * @module
 */
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { DOTS } from './display.js';
import { Icon } from './icons.js';
import { ActionMenu } from './Menu.js';
import { useShell } from './shell-state.js';

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
 * The breadcrumbs, every step a link, and the page title (the last step) as the page's one heading. The title never
 * shrinks (it cuts its own text with an ellipsis and keeps the full text as a tooltip); the earlier steps show only
 * where the header (a size container) is at least 40rem wide, and cut their own text before the title does.
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
	// a fact that was cut keeps its full text as a tooltip
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
 * The (i) beside the title: the page's old description in a small popover (Escape or a click elsewhere closes it).
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
 * A page action as a menu item (for narrow headers); `className` is the container-query class that hides the row where
 * the action is a button.
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
 * The actions at the right of the header: the primary button, up to two secondary ones, then More. On phones the
 * secondary ones are the first items of More. With `byWidth` (the {@link Page} header, a size container) the width of
 * the header decides, not the window: below 48rem the secondary buttons hide and their rows show in More (More itself
 * shows below 48rem even when it holds nothing else); below 28rem a primary action that has an icon shows the icon only
 * (its label is the `aria-label` and the tooltip). Button labels cut their own text at 14rem.
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
					byWidth
						? 'max-w-[14rem]'
						: // before the page is in the browser (no phone check yet) the secondary buttons already stay away on phones
							variant === 'secondary' && 'max-sm:hidden',
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
