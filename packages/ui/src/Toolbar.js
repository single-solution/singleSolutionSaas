'use client';
/**
 * The toolbar (layout contract 2026-10-17, item 4): the ONE fixed bar above a list. Search (debounced), filter chips
 * and menus, a sort menu, a view switch, extra content and the range on the right ("1–25 of 312"). It is one line of
 * fixed height and never scrolls with the list. When rows are being selected it turns into the bulk bar (count,
 * actions, select all, Done); a table with bulk actions shows a Select button that starts select mode. On phones the
 * filters fold into one Filters menu.
 * @module
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { Icon } from './icons.js';
import { BAR } from './layout-metrics.js';
import { ActionMenu } from './Menu.js';
import { ToolbarSkeleton } from './skeletons.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {{ value: string, label: string }} ToolbarOption */
/**
 * A filter is a chip that switches on and off (`onToggle`), or a menu of `options` with one `value` ('' = all).
 * @typedef {{ id: string, label: string, active?: boolean, onToggle?: () => void }
 *   | { id: string, label: string, options: ToolbarOption[], value: string, onChange: (value: string) => void, allLabel?: string }} ToolbarFilter
 */
/**
 * @typedef {object} ToolbarSearch
 * @property {(text: string) => void} onSearch called once typing pauses for `delay` ms, at once on Enter and on clear
 * @property {string} [value] the text to show (set it to reset the box)
 * @property {string} [placeholder]
 * @property {string} [label]
 * @property {number} [delay] milliseconds (250)
 */
/** @typedef {{ options: ToolbarOption[], value: string, onChange: (value: string) => void, dir?: 'asc' | 'desc', onDir?: (dir: 'asc' | 'desc') => void, label?: string }} ToolbarSort */
/** @typedef {{ options: Array<{ value: string, label: string, icon?: import('./icons.js').IconName }>, value: string, onChange: (value: string) => void, label?: string }} ToolbarView */
/**
 * The bulk bar of select mode.
 * @typedef {object} ToolbarBulk
 * @property {number} count rows selected
 * @property {number} [total] rows that can be selected
 * @property {boolean} [allSelected]
 * @property {ReactNode} [actions] the buttons for the selected rows
 * @property {() => void} [onSelectAll]
 * @property {() => void} onDone leaves select mode
 */

/**
 * @typedef {{ search: string, clearSearch: string, filters: string, all: string, sort: string, order: string,
 *   ascending: string, descending: string, view: string, select: string, selectAll: string, done: string,
 *   nothing: string, selected: (count: number) => string }} ToolbarTexts
 */

/** The words the toolbar says itself (replace them to translate). @type {Readonly<ToolbarTexts>} */
export const TOOLBAR_TEXTS = Object.freeze({
	search: 'Search',
	clearSearch: 'Clear search',
	filters: 'Filters',
	all: 'All',
	sort: 'Sort',
	order: 'Order',
	ascending: 'Ascending',
	descending: 'Descending',
	view: 'View',
	select: 'Select',
	selectAll: 'Select all',
	done: 'Done',
	nothing: 'Select rows',
	/** @param {number} count */
	selected: (count) => `${count} selected`,
});

const CHIP =
	'ss-motion ss-press inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border px-3 text-label font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
const CHIP_ON = 'border-line bg-surface text-fg ss-hard';
const CHIP_OFF = 'border-line bg-surface text-fg/80 hover:bg-surface-2 hover:text-fg';

/**
 * The search box: types freely, tells the page once typing pauses.
 * @param {{ search: ToolbarSearch, words: ToolbarTexts }} props
 */
function SearchBox({ search, words }) {
	const { onSearch, value, placeholder, label, delay = 250 } = search;
	const [text, setText] = useState(value ?? '');
	const timer = useRef(/** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined));
	const sent = useRef(value ?? '');
	const latest = useRef(onSearch);
	latest.current = onSearch;
	useEffect(() => {
		if ((value ?? '') === sent.current) return;
		sent.current = value ?? '';
		setText(sent.current);
	}, [value]);
	useEffect(() => () => clearTimeout(timer.current), []);
	/** @param {string} next */
	const send = (next) => {
		clearTimeout(timer.current);
		if (next === sent.current) return;
		sent.current = next;
		latest.current(next);
	};
	/** @param {string} next */
	const clear = (next) => {
		setText(next);
		send(next);
	};
	const box = useRef(/** @type {HTMLInputElement | null} */ (null));
	const clearNow = useRef(clear);
	clearNow.current = clear;
	useEffect(() => {
		const input = box.current;
		if (!input) return undefined;
		/** @param {KeyboardEvent} event */
		const onEscape = (event) => {
			if (event.key !== 'Escape') return;
			// the search is the innermost open thing: a drawer or dialog around it listens on its own panel and would
			// close with it, so the search takes the key here, before it gets that far
			event.stopPropagation();
			if (input.value !== '') return clearNow.current('');
			// nothing to clear: leave the search, to the overlay around it when there is one (the next Escape closes that)
			const around = input.closest('[role="dialog"]');
			if (around instanceof HTMLElement) around.focus();
			else input.blur();
		};
		input.addEventListener('keydown', onEscape);
		return () => input.removeEventListener('keydown', onEscape);
	}, []);
	return (
		<div className="relative min-w-0 flex-1 sm:max-w-xs">
			<span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-subtle">
				<Icon name="search" size={14} />
			</span>
			<input
				ref={box}
				type="search"
				aria-label={label ?? words.search}
				placeholder={placeholder ?? words.search}
				value={text}
				onChange={(event) => {
					const next = event.target.value;
					setText(next);
					clearTimeout(timer.current);
					timer.current = setTimeout(() => send(next), delay);
				}}
				onKeyDown={(event) => {
					if (event.key === 'Enter') send(text);
				}}
				className="ss-motion h-8 w-full appearance-none rounded-control border border-line bg-surface pr-8 pl-8 text-label text-fg placeholder:text-subtle focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-search-cancel-button]:appearance-none"
			/>
			{text !== '' ? (
				<button
					type="button"
					aria-label={words.clearSearch}
					onClick={() => clear('')}
					className="ss-motion absolute inset-y-0 right-1.5 my-auto flex size-6 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-fg">
					<Icon name="close" size={13} />
				</button>
			) : null}
		</div>
	);
}

/**
 * @param {ToolbarFilter} filter
 * @param {ToolbarTexts} words
 * @returns {import('./Menu.js').MenuItem[]}
 */
const filterItems = (filter, words) =>
	'options' in filter
		? [
				{ label: filter.allLabel ?? words.all, checked: filter.value === '', onSelect: () => filter.onChange('') },
				...filter.options.map((option) => ({
					label: option.label,
					checked: option.value === filter.value,
					onSelect: () => filter.onChange(option.value),
				})),
			]
		: [{ label: filter.label, checked: Boolean(filter.active), onSelect: () => filter.onToggle?.() }];

/**
 * The bar above a list.
 * @param {{ search?: ToolbarSearch, filters?: ToolbarFilter[], sort?: ToolbarSort, view?: ToolbarView,
 *   range?: ReactNode, end?: ReactNode, children?: ReactNode, onStartSelect?: () => void, bulk?: ToolbarBulk,
 *   texts?: Partial<ToolbarTexts>, loading?: boolean, label?: string, className?: string }} props `children`
 *   sit after the filters, `end` before the range; `onStartSelect` shows the Select button; `bulk` turns the bar into
 *   the bulk bar (use `useRowSelection(...).toolbar(actions)` to get both from one place)
 */
export function Toolbar({
	search,
	filters = [],
	sort,
	view,
	range,
	end,
	children,
	onStartSelect,
	bulk,
	texts,
	loading = false,
	label,
	className,
}) {
	const words = { ...TOOLBAR_TEXTS, ...texts };
	if (loading) return <ToolbarSkeleton className={className} />;
	if (bulk) {
		return (
			<div
				data-ss-bulk=""
				{...(label ? { role: 'group', 'aria-label': label } : {})}
				className={cx(BAR, 'animate-ss-enter border border-line bg-surface text-fg ss-hard', className)}>
				<p role="status" className="min-w-0 truncate text-sm font-medium">
					{bulk.count > 0 ? words.selected(bulk.count) : words.nothing}
				</p>
				{bulk.count > 0 && bulk.actions ? <div className="flex min-w-0 items-center gap-2">{bulk.actions}</div> : null}
				<div className="ml-auto flex shrink-0 items-center gap-2">
					{bulk.onSelectAll && !bulk.allSelected ? (
						<Button size="sm" variant="ghost" onClick={bulk.onSelectAll}>
							{words.selectAll}
						</Button>
					) : null}
					<Button size="sm" variant="secondary" onClick={bulk.onDone}>
						{words.done}
					</Button>
				</div>
			</div>
		);
	}
	return (
		<div {...(label ? { role: 'group', 'aria-label': label } : {})} className={cx(BAR, 'relative z-20', className)}>
			{search ? <SearchBox search={search} words={words} /> : null}
			{filters.length > 0 ? (
				<>
					<div className="hidden items-center gap-2 sm:flex">
						{filters.map((filter) =>
							'options' in filter ? (
								<ActionMenu
									key={filter.id}
									label={filter.label}
									align="start"
									triggerClassName={cx(CHIP, filter.value ? CHIP_ON : CHIP_OFF)}
									items={filterItems(filter, words)}
									trigger={
										<>
											<span>{filter.label}</span>
											{filter.value ? (
												<span className="font-semibold">
													{filter.options.find((option) => option.value === filter.value)?.label}
												</span>
											) : null}
											<Icon name="chevronDown" size={12} />
										</>
									}
								/>
							) : (
								<button
									key={filter.id}
									type="button"
									aria-pressed={Boolean(filter.active)}
									onClick={() => filter.onToggle?.()}
									className={cx(CHIP, filter.active ? CHIP_ON : CHIP_OFF)}>
									{filter.label}
								</button>
							),
						)}
					</div>
					<ActionMenu
						label={words.filters}
						icon="filter"
						align="start"
						className="sm:hidden"
						items={filters.flatMap((filter) =>
							filterItems(filter, words).map((item) => ({
								...item,
								section: 'options' in filter ? filter.label : words.filters,
							})),
						)}
					/>
				</>
			) : null}
			{children}
			<div className="ml-auto flex shrink-0 items-center gap-2">
				{end}
				{range ? <p className="hidden text-label text-muted tabular-nums md:block">{range}</p> : null}
				{sort ? (
					<ActionMenu
						label={sort.label ?? words.sort}
						icon="sort"
						items={[
							...sort.options.map((option) => ({
								label: option.label,
								checked: option.value === sort.value,
								onSelect: () => sort.onChange(option.value),
							})),
							...(sort.onDir
								? /** @type {const} */ (['asc', 'desc']).map((dir) => ({
										label: dir === 'asc' ? words.ascending : words.descending,
										checked: sort.dir === dir,
										section: words.order,
										onSelect: () => sort.onDir?.(dir),
									}))
								: []),
						]}
					/>
				) : null}
				{view ? (
					<div
						role="group"
						aria-label={view.label ?? words.view}
						className="hidden items-center gap-0.5 rounded-control bg-surface-2 p-0.5 sm:flex">
						{view.options.map((option) => (
							<button
								key={option.value}
								type="button"
								aria-pressed={option.value === view.value}
								aria-label={option.label}
								title={option.label}
								onClick={() => view.onChange(option.value)}
								className={cx(
									'ss-motion ss-press flex size-7 items-center justify-center rounded-control focus-visible:outline-2 focus-visible:outline-focus',
									option.value === view.value ? 'bg-surface text-fg' : 'text-muted hover:text-fg',
								)}>
								{option.icon ? <Icon name={option.icon} size={14} /> : <span className="text-label">{option.label}</span>}
							</button>
						))}
					</div>
				) : null}
				{onStartSelect ? (
					<Button size="sm" variant="secondary" onClick={onStartSelect}>
						{words.select}
					</Button>
				) : null}
			</div>
		</div>
	);
}
