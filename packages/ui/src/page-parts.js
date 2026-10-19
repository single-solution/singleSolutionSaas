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
/** @typedef {{ breadcrumb: string, info: string, more: string, menu: string, facts: string }} PageTexts */

/** The words a page's header says itself (replace them to translate). @type {Readonly<PageTexts>} */
export const PAGE_TEXTS = Object.freeze({
	breadcrumb: 'Breadcrumb',
	info: 'About this page',
	more: 'More actions',
	menu: 'Open navigation',
	facts: 'Key numbers',
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
			className="ss-motion ss-press shrink-0 rounded-lg p-2 text-fg hover:bg-surface-2 lg:hidden">
			<Icon name="menu" size={18} />
		</button>
	);
}

/**
 * The breadcrumbs, every step a link, and the page title (the last step) as the page's one heading. On phones only the
 * title shows.
 * @param {{ crumbs: PageCrumb[], linkAs?: import('react').ElementType, titleId?: string, texts?: Partial<PageTexts> }} props
 */
export function Crumbs({ crumbs, linkAs, titleId, texts }) {
	const LinkTag = linkAs ?? 'a';
	const last = crumbs.length - 1;
	return (
		<nav aria-label={texts?.breadcrumb ?? PAGE_TEXTS.breadcrumb} className="min-w-0">
			<ol className="flex min-w-0 items-center gap-1.5 text-sm">
				{crumbs.map((crumb, i) =>
					i === last ? (
						<li key={i} className="min-w-0 truncate">
							<h1 id={titleId} aria-current="page" className="truncate text-title font-semibold text-fg">
								{crumb.label}
							</h1>
						</li>
					) : (
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
					),
				)}
			</ol>
		</nav>
	);
}

/** The look of every fact: a small rounded chip with a muted label and the value in full color. */
const FACT =
	'inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-2 px-2.5 text-label text-muted';

/**
 * One fact of the header.
 * @param {{ fact: PageFact, linkAs?: import('react').ElementType }} props
 */
export function Fact({ fact, linkAs }) {
	const LinkTag = linkAs ?? 'a';
	const body = (
		<>
			{fact.tone ? <span aria-hidden="true" className={cx('size-1.5 shrink-0 rounded-full', DOTS[fact.tone])} /> : null}
			<span>{fact.label}</span>
			<span className="font-medium text-fg tabular-nums">{fact.value}</span>
		</>
	);
	const common = { 'data-ss-fact': '', ...(fact.title ? { title: fact.title } : {}) };
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
					fact.active ? 'bg-primary-soft text-on-primary-soft' : 'hover:bg-line-soft',
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
				className="ss-motion ss-press flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
				<Icon name="info" size={16} />
			</button>
			{open ? (
				<div
					id={id}
					className="absolute top-full left-0 z-30 mt-2 w-80 max-w-[85vw] origin-top-left animate-ss-pop rounded-card border border-line-soft bg-surface p-3 text-sm text-pretty text-muted shadow-overlay">
					{children}
				</div>
			) : null}
		</div>
	);
}

/**
 * A page action as a menu item (for phones).
 * @param {PageAction} action
 * @returns {MenuItem}
 */
const asItem = (action) => ({
	label: action.label,
	onSelect: () => {
		void action.onClick();
	},
	...(action.icon ? { icon: action.icon } : {}),
	...(action.disabled ? { disabled: true } : {}),
});

/**
 * The actions at the right of the header: the primary button, up to two secondary ones, then More. On phones the
 * secondary ones are the first items of More.
 * @param {{ actions: PageActions, narrow: boolean, texts?: Partial<PageTexts> }} props
 */
export function HeaderActions({ actions, narrow, texts }) {
	const secondary = (actions.secondary ?? []).slice(0, 2);
	const items = [...(narrow ? secondary.map(asItem) : []), ...(actions.more ?? [])];
	/** @param {PageAction} action @param {'primary' | 'secondary'} variant */
	const button = (action, variant) => (
		<Button
			key={action.label}
			variant={variant}
			// before the page is in the browser (no phone check yet) the secondary buttons already stay away on phones
			{...(variant === 'secondary' ? { className: 'max-sm:hidden' } : {})}
			onClick={action.onClick}
			{...(action.disabled ? { disabled: true } : {})}
			{...(action.loading ? { loading: true } : {})}
			{...(action.title ? { title: action.title } : {})}
			{...(action.icon ? { icon: <Icon name={action.icon} size={15} /> } : {})}>
			{action.label}
		</Button>
	);
	return (
		<div className="flex shrink-0 items-center gap-2">
			{actions.primary ? button(actions.primary, 'primary') : null}
			{narrow ? null : secondary.map((action) => button(action, 'secondary'))}
			{items.length > 0 ? <ActionMenu label={texts?.more ?? PAGE_TEXTS.more} items={items} size="md" /> : null}
		</div>
	);
}
