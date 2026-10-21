'use client';
/**
 * The list column (owner 2026-10-21: no tables, a list of things is a column of rich rows beside the page): a search box
 * (`/` focuses it) and filter chips with counts on top, under them the `Row`s, one per item, in a scrolling pane. The
 * picked row has ONE highlight that slides to it with the theme's motion; the first rows come in one after the other
 * like a table's; a very long list stays fast because rows far outside the pane are not drawn (`content-visibility`),
 * and more rows load as the end comes into view (`hasMore` and `onMore`). Pass the element as the `list` of a `Page`:
 * the page draws it where the inner navigation goes and, on phones, shows the list or the picked item, one at a time.
 *
 * It is a listbox of options: Up and Down move the focus, Home and End jump to the first and last row, Enter or Space
 * selects the focused one; the picked row is `aria-selected`. Pointing at a row for 150 ms (or focusing it) calls
 * `onPrefetch`, so the item's page can load before the click.
 * @module
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { EmptyState, SkeletonBlock } from './display.js';
import { Icon } from './icons.js';
import { LIST, STAGGER } from './layout-metrics.js';
import { Row } from './Row.js';
import { Spinner } from './Spinner.js';
import { PickKeepsEditsContext, askLeave } from './unsaved.js';

/** @typedef {Parameters<typeof Row>[0]} RowProps */
/** @typedef {{ search: string, filters: string, loading: string, more: string, back: string, clearSearch: string, clearFilter: string, noFilterMatch: string, noMatch?: (query: string) => string }} ListColumnTexts */

/** The words the list column says itself (replace them to translate). @type {Readonly<ListColumnTexts>} */
export const LIST_COLUMN_TEXTS = Object.freeze({
	search: 'Search',
	filters: 'Filter',
	loading: 'Loading',
	more: 'Loading more',
	back: 'Back to the list',
	clearSearch: 'Clear search',
	clearFilter: 'Clear filter',
	noFilterMatch: 'No match for filter',
});

/** How long the pointer rests on a row before `onPrefetch` is called (ms). */
const REST = 150;

/** How many skeleton rows a loading column draws. */
const SKELETON_ROWS = 8;

/** Whether a key press happens in a field the person is typing into. @param {EventTarget | null} target */
const typing = (target) =>
	target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * @template T
 * @param {{ label: string, items: T[], idOf: (item: T) => string | number, rowOf: (item: T) => Omit<RowProps, 'selected' | 'onSelect'>,
 *   selected?: string | number | null, onSelect?: (id: string) => void, onBack?: () => void, guard?: boolean,
 *   search?: { value: string, onChange: (value: string) => void, placeholder?: string },
 *   filters?: { value: string, onChange: (id: string) => void, options: { id: string, label: string, count?: number }[] },
 *   loading?: boolean, empty?: Parameters<typeof EmptyState>[0], hasMore?: boolean, onMore?: () => void,
 *   onPrefetch?: (item: T) => void, texts?: Partial<ListColumnTexts>, className?: string }} props `label`: the name of
 *   the list for screen readers; `rowOf`: the `Row` props of an item (the column sets `selected` and `onSelect`);
 *   `selected`: the id of the picked item; `onBack`: read by a `Page` on phones (its Back button, named by `texts.back`, shows the list again);
 *   `guard`: picking another row asks "You have unsaved changes" first while a save bar has changes (on by default, off
 *   when the `Page` around the list keeps its views mounted, so no edit is lost by picking another);
 *   `search`: a box above the rows (`/` focuses it); `filters`: chips under it, the one whose `id` is `value` on; `empty`:
 *   what to say when there are no items; `hasMore` + `onMore`: the list has more rows to load (called once each time the
 *   end comes into view)
 */
export function ListColumn({
	label,
	items,
	idOf,
	rowOf,
	selected,
	onSelect,
	guard,
	search,
	filters,
	loading = false,
	empty,
	hasMore = false,
	onMore,
	onPrefetch,
	texts,
	className,
}) {
	const words = { ...LIST_COLUMN_TEXTS, ...texts };
	const keepsEdits = useContext(PickKeepsEditsContext);
	const asks = guard ?? !keepsEdits;
	const scroller = useRef(/** @type {HTMLDivElement | null} */ (null));
	const list = useRef(/** @type {HTMLDivElement | null} */ (null));
	const slide = useRef(/** @type {HTMLSpanElement | null} */ (null));
	const field = useRef(/** @type {HTMLInputElement | null} */ (null));
	const end = useRef(/** @type {HTMLDivElement | null} */ (null));
	const resting = useRef(/** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined));
	const [placed, setPlaced] = useState(false);
	const [fresh, setFresh] = useState(true);
	const picked = selected === null || selected === undefined ? null : String(selected);
	const ids = items.map((item) => String(idOf(item)));
	const shown = !loading && items.length > 0;
	const searchable = search !== undefined;
	const query = search?.value?.trim() ?? '';
	const hasSearch = Boolean(query);
	const activeFilter =
		filters && filters.options && filters.options.length > 0
			? filters.value !== 'all' &&
				filters.value !== (filters.options.find((o) => o.id === 'all')?.id ?? filters.options[0]?.id)
			: false;
	const isFiltered = hasSearch || activeFilter;

	// the one highlight slides to the picked row
	useLayoutEffect(() => {
		const box = slide.current;
		const root = list.current;
		if (!box || !root) return;
		const row = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[role="option"]')]).find(
			(el) => el.dataset.ssId === picked,
		);
		if (!row) {
			box.style.opacity = '0';
			return;
		}
		box.style.height = `${row.offsetHeight}px`;
		box.style.transform = `translateY(${row.offsetTop}px)`;
		box.style.opacity = '1';
		setPlaced(true);
	}, [picked, items, loading]);

	// the first rows stagger in once, then the rows are plain
	useEffect(() => {
		if (!shown) return undefined;
		const timer = setTimeout(() => setFresh(false), STAGGER.rows * STAGGER.step + 400);
		return () => clearTimeout(timer);
	}, [shown]);

	// `/` jumps to the search box unless a field has the focus
	useEffect(() => {
		if (!searchable) return undefined;
		/** @param {KeyboardEvent} event */
		const onKey = (event) => {
			if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
			event.preventDefault();
			field.current?.focus();
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [searchable]);

	// the end of the list comes into view: ask for more, once per visible run (a new observer after each load, so a
	// list that is still short asks again)
	useEffect(() => {
		const sentinel = end.current;
		if (!hasMore || loading || !sentinel || typeof IntersectionObserver === 'undefined') return undefined;
		let called = false;
		const observer = new IntersectionObserver(
			(entries) => {
				const visible = entries.some((entry) => entry.isIntersecting);
				if (visible && !called) {
					called = true;
					onMore?.();
				} else if (!visible) called = false;
			},
			{ root: scroller.current, rootMargin: '120px' },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasMore, loading, items.length, onMore]);

	useEffect(() => () => clearTimeout(resting.current), []);

	/** @param {import('react').KeyboardEvent<HTMLDivElement>} event */
	const move = (event) => {
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
		const options = /** @type {HTMLElement[]} */ ([...(list.current?.querySelectorAll('[role="option"]') ?? [])]);
		if (options.length === 0) return;
		event.preventDefault();
		const at = options.findIndex((el) => el.contains(document.activeElement));
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? options.length - 1
					: Math.min(options.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)));
		options[next]?.focus();
		options[next]?.scrollIntoView?.({ block: 'nearest' });
	};

	return (
		<div data-ss-list="" className={cx(LIST.column, className)}>
			{search || (filters && filters.options.length > 0) ? (
				<div className={LIST.head}>
					{search ? (
						<div className="relative">
							<span
								aria-hidden="true"
								className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle">
								<Icon name="search" size={14} />
							</span>
							<input
								ref={field}
								type="search"
								aria-label={search.placeholder ?? words.search}
								placeholder={search.placeholder ?? words.search}
								value={search.value}
								onChange={(event) => search.onChange(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Escape') event.currentTarget.blur();
								}}
								className="h-8 w-full rounded-control border border-line bg-surface pr-2.5 pl-8 text-label text-fg placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-focus"
							/>
						</div>
					) : null}
					{filters && filters.options.length > 0 ? (
						<div role="group" aria-label={words.filters} className="ss-scroll flex gap-1.5 overflow-x-auto pb-0.5">
							{filters.options.map((option) => {
								const on = option.id === filters.value;
								return (
									<button
										key={option.id}
										type="button"
										aria-pressed={on}
										onClick={() => filters.onChange(option.id)}
										className={cx(LIST.chip, on ? LIST.chipOn : LIST.chipOff)}>
										<span>{option.label}</span>
										{option.count !== undefined ? (
											<span className="tabular-nums opacity-75">{option.count}</span>
										) : null}
									</button>
								);
							})}
						</div>
					) : null}
				</div>
			) : null}
			<div ref={scroller} data-ss-slide="" className={LIST.scroller}>
				{loading ? (
					<div role="status" aria-label={words.loading} aria-busy="true" className="animate-ss-fade">
						{Array.from({ length: SKELETON_ROWS }, (_, i) => (
							<div key={i} aria-hidden="true" className={cx('flex items-center gap-3 px-2.5', LIST.row)}>
								<SkeletonBlock className="size-8 shrink-0 rounded-full" />
								<div className="min-w-0 flex-1 space-y-1.5">
									<SkeletonBlock className="h-3.5 w-2/5" />
									<SkeletonBlock className="h-3 w-3/4" />
								</div>
								<SkeletonBlock className="h-3 w-8 shrink-0" />
							</div>
						))}
					</div>
				) : items.length === 0 ? (
					isFiltered ? (
						<EmptyState
							compact
							icon={hasSearch ? 'search' : 'filter'}
							title={
								hasSearch
									? typeof words.noMatch === 'function'
										? words.noMatch(query)
										: `No match for "${query}"`
									: (words.noFilterMatch ?? 'No match for filter')
							}
							action={
								<div className="flex flex-wrap items-center justify-center gap-2">
									{hasSearch && search ? (
										<Button size="sm" variant="secondary" onClick={() => search.onChange('')}>
											{words.clearSearch}
										</Button>
									) : null}
									{activeFilter && filters ? (
										<Button
											size="sm"
											variant="secondary"
											onClick={() => {
												const allId = filters.options.find((o) => o.id === 'all')?.id ?? filters.options[0]?.id;
												if (allId !== undefined) filters.onChange(allId);
											}}>
											{words.clearFilter}
										</Button>
									) : null}
								</div>
							}
						/>
					) : empty ? (
						<EmptyState compact {...empty} />
					) : null
				) : (
					<div ref={list} role="listbox" aria-label={label} onKeyDown={move} className="relative isolate">
						<span ref={slide} data-ss-indicator="" aria-hidden="true" className={cx(LIST.slide, placed && LIST.slideMove)}>
							<span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" />
						</span>
						{items.map((item, index) => {
							const id = ids[index] ?? '';
							const on = id === picked;
							const entering = fresh && index < STAGGER.rows;
							const look = rowOf(item);
							return (
								<Row
									key={id}
									{...look}
									role="option"
									aria-selected={on}
									tabIndex={on || (picked === null && index === 0) ? 0 : -1}
									data-ss-id={id}
									selected={on}
									onSelect={() => (asks && !on ? askLeave(() => onSelect?.(id)) : onSelect?.(id))}
									className={cx(look.className, entering && 'ss-stagger')}
									{...(entering ? { style: /** @type {import('react').CSSProperties} */ ({ '--ss-i': index }) } : {})}
									{...(onPrefetch
										? {
												onFocus: (/** @type {import('react').FocusEvent} */ event) => {
													if (event.target === event.currentTarget) onPrefetch(item);
												},
												onPointerEnter: () => {
													clearTimeout(resting.current);
													resting.current = setTimeout(() => onPrefetch(item), REST);
												},
												onPointerLeave: () => clearTimeout(resting.current),
											}
										: {})}
								/>
							);
						})}
					</div>
				)}
				{hasMore && !loading ? (
					<div ref={end} role="status" aria-label={words.more} className="flex h-10 items-center justify-center text-muted">
						<Spinner size={16} />
					</div>
				) : null}
			</div>
		</div>
	);
}
