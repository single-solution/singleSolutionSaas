'use client';
/**
 * The inner navigation (layout contract 2026-10-17, item 3): the ONE way to move between the sub-pages of a page, on
 * every level. Groups with small labels; items with an icon, a count, an attention dot or a lock; a search box from
 * more than ten items; an optional footer (setup progress, a help link) that stays put. The current item is a
 * whole-row highlight with an accent bar, one marker that slides (with `transform`) to the next item. On phones the
 * same items sit in a dropdown at the top of the body.
 *
 * It works with the address: give items an `href` (a router link through `linkAs`, or `#id` with `useHashSection`) and
 * every sub-page is its own URL, so the browser's Back button works; or give `onSelect` and keep the choice in state.
 * @module
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { cx } from './cx.js';
import { DOTS } from './display.js';
import { Icon } from './icons.js';
import { METRICS, NAV_PANEL } from './layout-metrics.js';
import { InnerNavSkeleton } from './skeletons.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./display.js').Tone} Tone */
/**
 * One sub-page. `count` is a number or short text at the right; `dot` an attention dot (named for screen readers by
 * `dotLabel`); `locked` shows a lock (the page is still opened: it explains what the feature does). With `href` the
 * item is a link, without it a button. `onSelect` of the item runs before the shared one of the nav.
 * @typedef {object} InnerNavItem
 * @property {string} id
 * @property {ReactNode} label
 * @property {import('./icons.js').IconName} [icon]
 * @property {number | string} [count]
 * @property {Tone} [dot]
 * @property {string} [dotLabel]
 * @property {boolean} [locked]
 * @property {string} [href]
 * @property {(id: string) => void} [onSelect]
 */
/** @typedef {{ label?: string, items: InnerNavItem[] }} InnerNavGroup */

/** The words the navigation says itself (replace them to translate). */
export const INNER_NAV_TEXTS = Object.freeze({ search: 'Search', none: 'No match', locked: 'Locked' });

/** The plain text of a label, for searching. @param {ReactNode} label */
const textOf = (label) => (typeof label === 'string' || typeof label === 'number' ? String(label) : '');

/**
 * @param {{ groups?: InnerNavGroup[], items?: InnerNavItem[], value: string,
 *   onSelect?: (id: string, item: InnerNavItem) => void, label?: string, footer?: ReactNode,
 *   linkAs?: import('react').ElementType, searchFrom?: number, texts?: Partial<typeof INNER_NAV_TEXTS>,
 *   loading?: boolean, className?: string }} props `items` is one group without a label; `value` the id of the current
 *   item; `searchFrom` the number of items from which the search box shows (more than 10 by default)
 */
export function InnerNav({
	groups,
	items,
	value,
	onSelect,
	label = 'Sections',
	footer,
	linkAs,
	searchFrom = 10,
	texts,
	loading = false,
	className,
}) {
	const words = { ...INNER_NAV_TEXTS, ...texts };
	const LinkTag = linkAs ?? 'a';
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [placed, setPlaced] = useState(false);
	const menuId = useId();
	const list = useRef(/** @type {HTMLDivElement | null} */ (null));
	const marker = useRef(/** @type {HTMLSpanElement | null} */ (null));
	const all = groups ?? [{ items: items ?? [] }];
	const leaves = all.flatMap((group) => group.items);
	const current = leaves.find((item) => item.id === value) ?? leaves[0];
	const needle = query.trim().toLowerCase();
	const shown = all
		.map((group) => ({
			...group,
			items: needle ? group.items.filter((item) => textOf(item.label).toLowerCase().includes(needle)) : group.items,
		}))
		.filter((group) => group.items.length > 0);

	useLayoutEffect(() => {
		const box = marker.current;
		const root = list.current;
		if (!box || !root) return;
		const row = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-ss-nav-item]')]).find(
			(el) => el.dataset.ssNavItem === current?.id,
		);
		if (!row) {
			box.style.opacity = '0';
			return;
		}
		box.style.height = `${row.offsetHeight}px`;
		box.style.transform = `translateY(${row.offsetTop}px)`;
		box.style.opacity = '1';
		setPlaced(true);
	}, [current?.id, needle, loading, shown.length]);

	useEffect(() => {
		if (!open) return undefined;
		/** @param {KeyboardEvent} event */
		const escape = (event) => {
			if (event.key === 'Escape') setOpen(false);
		};
		document.addEventListener('keydown', escape);
		return () => document.removeEventListener('keydown', escape);
	}, [open]);

	if (loading) return <InnerNavSkeleton className={className} />;

	/** @param {InnerNavItem} item */
	const choose = (item) => {
		item.onSelect?.(item.id);
		onSelect?.(item.id, item);
		setOpen(false);
	};

	/** @param {InnerNavItem} item */
	const row = (item) => {
		const on = item.id === current?.id;
		const Tag = item.href ? LinkTag : 'button';
		return (
			<Tag
				{...(item.href ? { href: item.href } : { type: 'button' })}
				data-ss-nav-item={item.id}
				aria-current={on ? (item.href ? 'page' : 'true') : undefined}
				onClick={() => choose(item)}
				className={cx(
					'ss-motion ss-press flex w-full items-center gap-2 rounded-md px-2 text-left text-label focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
					METRICS.navItem,
					on
						? cx('font-medium text-on-primary-soft', placed ? 'bg-transparent' : 'bg-primary-soft')
						: 'font-medium text-fg/75 hover:bg-surface-2 hover:text-fg',
				)}>
				{item.icon ? (
					<span aria-hidden="true" className={cx('ss-motion shrink-0', on ? 'text-primary' : 'text-muted')}>
						<Icon name={item.icon} size={15} />
					</span>
				) : null}
				<span className="min-w-0 flex-1 truncate">{item.label}</span>
				{item.dot ? (
					<span className="flex shrink-0 items-center" {...(item.dotLabel ? { title: item.dotLabel } : {})}>
						<span aria-hidden="true" className={cx('size-1.5 rounded-full', DOTS[item.dot])} />
						{item.dotLabel ? <span className="sr-only">{item.dotLabel}</span> : null}
					</span>
				) : null}
				{item.locked ? (
					<span className="shrink-0 text-subtle">
						<Icon name="lock" size={12} title={words.locked} />
					</span>
				) : null}
				{item.count !== undefined ? (
					<span className="shrink-0 text-micro font-medium text-muted tabular-nums">{item.count}</span>
				) : null}
			</Tag>
		);
	};

	/** The groups with their small labels. */
	const groupsView = (
		<>
			{shown.map((group, index) => (
				<div key={group.label ?? index} className="space-y-0.5">
					{group.label ? (
						<p className="px-2 pt-1 pb-1 text-micro font-semibold tracking-[0.06em] text-muted uppercase">{group.label}</p>
					) : null}
					<ul className="space-y-px">
						{group.items.map((item) => (
							<li key={item.id}>{row(item)}</li>
						))}
					</ul>
				</div>
			))}
			{needle && shown.length === 0 ? <p className="px-2 py-1 text-sm text-muted">{words.none}</p> : null}
		</>
	);

	const search =
		leaves.length > searchFrom ? (
			<input
				type="search"
				aria-label={words.search}
				placeholder={words.search}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				className="h-8 w-full rounded-control border border-line bg-surface px-2.5 text-label text-fg placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-focus"
			/>
		) : null;

	return (
		<>
			<div className={cx('relative shrink-0 lg:hidden', className)}>
				<button
					type="button"
					aria-haspopup="true"
					aria-expanded={open}
					aria-controls={menuId}
					onClick={() => setOpen((o) => !o)}
					className="ss-motion ss-press flex h-10 w-full items-center gap-2.5 rounded-control border border-line-soft bg-surface px-3 text-sm font-medium text-fg">
					{current?.icon ? (
						<span aria-hidden="true" className="text-primary">
							<Icon name={current.icon} size={16} />
						</span>
					) : null}
					<span className="min-w-0 flex-1 truncate text-left">{current?.label}</span>
					<span aria-hidden="true" className={cx('ss-motion text-muted', open && 'rotate-180')}>
						<Icon name="chevronDown" size={16} />
					</span>
				</button>
				{open ? (
					<div
						id={menuId}
						data-ss-inner-menu=""
						className="ss-scroll absolute inset-x-0 top-full z-30 mt-2 max-h-[60vh] animate-ss-pop space-y-2 rounded-card border border-line-soft bg-surface p-2 shadow-overlay">
						<nav aria-label={label} className="space-y-3">
							{search}
							{groupsView}
						</nav>
						{footer ? <div className="border-t border-line-soft pt-2">{footer}</div> : null}
					</div>
				) : null}
			</div>
			<div className={cx(NAV_PANEL, className)}>
				{search ? <div className="shrink-0 p-2 pb-0">{search}</div> : null}
				<nav aria-label={label} className="ss-scroll min-h-0 flex-1 p-2">
					<div ref={list} className="relative isolate space-y-3">
						<span
							ref={marker}
							data-ss-indicator=""
							aria-hidden="true"
							className={cx(
								'pointer-events-none absolute inset-x-0 top-0 -z-10 rounded-md bg-primary-soft opacity-0',
								placed && 'transition-[transform,height,opacity] duration-(--dur) ease-ss',
							)}>
							<span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />
						</span>
						{groupsView}
					</div>
				</nav>
				{footer ? <div className="shrink-0 border-t border-line-soft p-3">{footer}</div> : null}
			</div>
		</>
	);
}
