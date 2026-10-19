'use client';
/**
 * The data table (layout contract 2026-10-17, item 5): the ONE way to show a list of records. A semantic `<table>`
 * inside one box that scrolls both ways under a sticky header row; the toolbar, the page header and the footer around
 * it never scroll. Columns have a kind (text, number, money, date, status pill), sort by a click on their header
 * (client-side, or by the page when `sort` is given), and low-priority columns hide on narrow widths while the table
 * scrolls sideways inside its box. A row can open a record on click, and has a last column with the row menu.
 *
 * Selection (owner 2026-10-17 23:15) is one built-in part of the row, never a checkbox column: a table with bulk
 * actions gets `useRowSelection`; its Select button in the {@link Toolbar} (or a small round check that fades in at the
 * row's left corner on hover) starts select mode, a click anywhere on a row then selects the whole row (accent tint,
 * ring and the filled check, inside the row's bounds), and the Toolbar becomes the bulk bar.
 * @module
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from './cx.js';
import { EmptyState, StatusPill } from './display.js';
import { formatDate } from './format.js';
import { Icon } from './icons.js';
import { columnClass, STAGGER, TABLE } from './layout-metrics.js';
import { ActionMenu } from './Menu.js';
import { DataTableSkeleton } from './skeletons.js';
import { useDisplayLocale } from './time.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./layout-metrics.js').ColumnKind} ColumnKind */
/** @typedef {import('./display.js').PillStatus} PillStatus */

/**
 * @template T
 * @typedef {object} DataColumn
 * @property {string} key the property of the row the cell shows, and the id of the column
 * @property {ReactNode} header
 * @property {ColumnKind} [kind] text (default), number, money, date or status
 * @property {(row: T) => ReactNode} [render] the cell; by default the row's value (a date is formatted)
 * @property {(row: T) => { status: PillStatus, label: ReactNode, title?: string }} [pill] draws the cell as a status pill
 * @property {boolean} [sortable] a click on the header sorts by this column
 * @property {(row: T) => string | number | Date | null | undefined} [sortValue] what to sort by (default: the row's value)
 * @property {'left' | 'right' | 'center'} [align] overrides the alignment of the kind
 * @property {boolean} [low] a low-priority column: hidden on narrow widths
 * @property {boolean} [wrap] let a long text wrap on whole words instead of one line
 * @property {boolean} [rowHeader] this cell is the row's `<th scope="row">` (the first column by default)
 * @property {string} [className]
 */

/**
 * @typedef {object} RowSelection what {@link useRowSelection} returns
 * @property {boolean} mode select mode is on
 * @property {(key?: string) => void} start turn select mode on (and select that row)
 * @property {() => void} done leave select mode and forget the selection
 * @property {(key: string) => void} toggle
 * @property {() => void} selectAll
 * @property {() => void} clear
 * @property {string[]} keys the keys of the selected rows (only rows that are still in the list)
 * @property {unknown[]} rows the selected rows
 * @property {number} count
 * @property {number} total
 * @property {boolean} allSelected
 * @property {(key: string) => boolean} isSelected
 * @property {(actions?: ReactNode) => { onStartSelect?: () => void, bulk?: import('./Toolbar.js').ToolbarBulk }} toolbar
 *   the Toolbar props for the current mode: the Select button, or the bulk bar with these actions
 */

/**
 * @typedef {{ empty: string, loading: string, actions: string, sortBy: (header: string) => string,
 *   selectRow: (label: string) => string, rowActions: (label: string) => string }} DataTableTexts
 */

/** The words the table says itself (replace them to translate). @type {Readonly<DataTableTexts>} */
export const DATA_TABLE_TEXTS = Object.freeze({
	empty: 'Nothing to show yet.',
	loading: 'Loading',
	actions: 'Actions',
	/** @param {string} header */
	sortBy: (header) => `Sort by ${header}`,
	/** @param {string} label */
	selectRow: (label) => `Select ${label}`,
	/** @param {string} label */
	rowActions: (label) => `Actions for ${label}`,
});

/**
 * Select rows of a table: the state shared by the {@link Toolbar} (Select button, bulk bar) and the
 * {@link DataTable} (the checks and the row tint). Records that leave the list drop out of the selection.
 * @template T
 * @param {T[]} rows the rows that can be selected (the ones on screen)
 * @param {(row: T) => string} rowKey
 * @returns {RowSelection}
 */
export function useRowSelection(rows, rowKey) {
	const [mode, setMode] = useState(false);
	const [chosen, setChosen] = useState(/** @type {Set<string>} */ (new Set()));
	const all = rows.map(rowKey);
	const keys = all.filter((key) => chosen.has(key));
	const picked = new Set(keys);
	/** @param {string} [key] */
	const start = (key) => {
		setMode(true);
		if (key !== undefined) setChosen(new Set([key]));
	};
	const done = () => {
		setMode(false);
		setChosen(new Set());
	};
	/** @param {string} key */
	const toggle = (key) =>
		setChosen((previous) => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	const selectAll = () => setChosen(new Set(all));
	const clear = () => setChosen(new Set());
	const allSelected = all.length > 0 && keys.length === all.length;
	return {
		mode,
		start,
		done,
		toggle,
		selectAll,
		clear,
		keys,
		rows: rows.filter((row) => picked.has(rowKey(row))),
		count: keys.length,
		total: all.length,
		allSelected,
		isSelected: (key) => picked.has(key),
		toolbar: (actions) =>
			mode
				? { bulk: { count: keys.length, total: all.length, allSelected, actions, onSelectAll: selectAll, onDone: done } }
				: all.length > 0
					? { onStartSelect: () => start() }
					: {},
	};
}

/**
 * @template T
 * @param {T} row
 * @param {string} key
 */
const cell = (row, key) => /** @type {Record<string, unknown>} */ (row)[key];

/** The value to sort by, as something comparable. @param {unknown} value */
const comparable = (value) => (value instanceof Date ? value.getTime() : value);

/** A row's menu button; a row with no actions shows none. @param {{ label: string, items: import('./Menu.js').MenuItem[] }} props */
function RowMenu({ label, items }) {
	return items.length > 0 ? <ActionMenu floating label={label} items={items} /> : null;
}

/** Anything in a row that has its own click: a click on it is not a click on the row. */
const OWN_CLICK = 'a, button, input, select, textarea, [role="menu"]';

/**
 * The table.
 * @template T
 * @param {{ columns: DataColumn<T>[], rows: T[], rowKey: (row: T) => string, caption: string,
 *   rowLabel?: (row: T) => string, onRowClick?: (row: T) => void, rowMenu?: (row: T) => import('./Menu.js').MenuItem[],
 *   selection?: Pick<RowSelection, 'mode' | 'isSelected'> & Partial<RowSelection>,
 *   sort?: { key: string, dir: 'asc' | 'desc' }, onSort?: (key: string, dir: 'asc' | 'desc') => void,
 *   defaultSort?: { key: string, dir: 'asc' | 'desc' }, loading?: boolean, skeletonRows?: number,
 *   empty?: ReactNode, texts?: Partial<DataTableTexts>, className?: string }} props
 *   `rowKey` is a unique key per row; `rowLabel` names a row for screen readers (the menu and the check); `sort` and
 *   `onSort` let the page sort (a list from the server) - without them the loaded rows sort here; `empty` is a text or
 *   a ready state shown instead of the table
 */
export function DataTable({
	columns,
	rows,
	rowKey,
	caption,
	rowLabel,
	onRowClick,
	rowMenu,
	selection,
	sort,
	onSort,
	defaultSort,
	loading = false,
	skeletonRows = 8,
	empty,
	texts,
	className,
}) {
	const words = { ...DATA_TABLE_TEXTS, ...texts };
	const locale = useDisplayLocale();
	const [ownSort, setOwnSort] = useState(defaultSort ?? null);
	const current = sort ?? ownSort;
	const sorted = useMemo(() => {
		if (sort || !current) return rows;
		const column = columns.find((c) => c.key === current.key);
		if (!column) return rows;
		const factor = current.dir === 'asc' ? 1 : -1;
		/** @param {T} row */
		const valueOf = (row) => comparable(column.sortValue ? column.sortValue(row) : cell(row, column.key));
		return [...rows].sort((a, b) => {
			const va = valueOf(a);
			const vb = valueOf(b);
			if (va === vb) return 0;
			// empty values stay last in both directions
			if (va === null || va === undefined) return 1;
			if (vb === null || vb === undefined) return -1;
			return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * factor;
		});
	}, [rows, columns, sort, current]);

	// the first rows come in one after the other on the first load only
	const played = useRef(false);
	const stagger = !played.current && rows.length > 0 && !loading;
	useEffect(() => {
		if (rows.length > 0 && !loading) played.current = true;
	}, [rows.length, loading]);

	if (loading) {
		return (
			<DataTableSkeleton
				columns={columns}
				rows={skeletonRows}
				selectable={Boolean(selection)}
				menu={Boolean(rowMenu)}
				label={words.loading}
				{...(className ? { className } : {})}
			/>
		);
	}
	if (rows.length === 0) {
		return (
			<div className={cx(TABLE.scroller, 'flex flex-col justify-center', className)}>
				{typeof empty === 'string' || empty === undefined ? <EmptyState title={empty ?? words.empty} /> : empty}
			</div>
		);
	}

	/** @param {string} key */
	const toggleSort = (key) => {
		const dir = current?.key === key && current.dir === 'asc' ? 'desc' : 'asc';
		if (onSort) onSort(key, dir);
		if (!sort) setOwnSort({ key, dir });
	};
	const selecting = Boolean(selection?.mode);
	const headerColumn = columns.some((c) => c.rowHeader) ? null : columns[0];
	/** @param {T} row */
	const labelOf = (row) => (rowLabel ? rowLabel(row) : String(cell(row, columns[0]?.key ?? '') ?? rowKey(row)));
	const interactive = selecting || Boolean(onRowClick);

	/**
	 * A click (or Enter) on a row.
	 * @param {T} row
	 * @param {import('react').MouseEvent | import('react').KeyboardEvent} event
	 */
	const activate = (row, event) => {
		const target = /** @type {Element} */ (event.target);
		if (selecting) {
			// the row menu keeps its own clicks; a link inside the row selects it instead of leaving
			if (target.closest('[data-ss-menu]')) return;
			if (target.closest('a')) event.preventDefault();
			selection?.toggle?.(rowKey(row));
			return;
		}
		if (event.target !== event.currentTarget && target.closest(OWN_CLICK)) return;
		onRowClick?.(row);
	};

	return (
		<div
			role="region"
			aria-label={caption}
			tabIndex={0}
			className={cx(
				TABLE.scroller,
				'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
				className,
			)}>
			<table className={TABLE.table}>
				<caption className="sr-only">{caption}</caption>
				<thead>
					<tr>
						{columns.map((column, i) => {
							const active = current?.key === column.key;
							return (
								<th
									key={column.key}
									scope="col"
									{...(active && current
										? { 'aria-sort': current.dir === 'asc' ? 'ascending' : 'descending' }
										: column.sortable
											? { 'aria-sort': 'none' }
											: {})}
									className={cx(TABLE.th, columnClass(column, Boolean(selection) && i === 0))}>
									{column.sortable ? (
										<button
											type="button"
											title={words.sortBy(typeof column.header === 'string' ? column.header : column.key)}
											onClick={() => toggleSort(column.key)}
											className="ss-motion inline-flex items-center gap-1 rounded hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
											{column.header}
											<Icon
												name={active && current ? (current.dir === 'asc' ? 'arrowUp' : 'arrowDown') : 'sort'}
												size={12}
											/>
										</button>
									) : (
										column.header
									)}
								</th>
							);
						})}
						{rowMenu ? (
							<th scope="col" className={cx(TABLE.th, TABLE.menu)}>
								<span className="sr-only">{words.actions}</span>
							</th>
						) : null}
					</tr>
				</thead>
				<tbody>
					{sorted.map((row, index) => {
						const key = rowKey(row);
						const chosen = Boolean(selection?.isSelected(key));
						const label = labelOf(row);
						const entering = stagger && index < STAGGER.rows;
						return (
							<tr
								key={key}
								{...(chosen ? { 'data-selected': '' } : {})}
								{...(interactive ? { tabIndex: 0 } : {})}
								{...(entering ? { style: /** @type {import('react').CSSProperties} */ ({ '--ss-i': index }) } : {})}
								onClick={interactive ? (event) => activate(row, event) : undefined}
								onKeyDown={
									interactive
										? (event) => {
												if (event.target !== event.currentTarget) return;
												if (event.key === 'Enter' || (selecting && event.key === ' ')) {
													event.preventDefault();
													activate(row, event);
												}
											}
										: undefined
								}
								className={cx(
									'group/row ss-motion relative focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
									interactive && 'cursor-pointer',
									chosen ? 'bg-primary-soft' : 'hover:bg-surface-2/60',
									entering && 'ss-stagger',
								)}>
								{columns.map((column, i) => {
									const header = column.rowHeader || column === headerColumn;
									const Cell = header ? 'th' : 'td';
									const first = i === 0 && Boolean(selection);
									return (
										<Cell
											key={column.key}
											{...(header ? { scope: 'row' } : {})}
											className={cx(TABLE.td, columnClass(column, first))}>
											{first ? (
												<>
													<button
														type="button"
														role="checkbox"
														aria-checked={chosen}
														aria-label={words.selectRow(label)}
														onClick={(event) => {
															event.stopPropagation();
															if (selecting) selection?.toggle?.(key);
															else selection?.start?.(key);
														}}
														className={cx(
															'ss-motion ss-press absolute top-1/2 left-3 z-[1] flex size-5 -translate-y-1/2 items-center justify-center rounded-full border focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
															chosen
																? 'border-primary bg-primary text-on-primary opacity-100'
																: 'border-line-strong bg-surface text-transparent',
															selecting || chosen ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100',
														)}>
														<Icon name="check" size={12} />
													</button>
													{chosen ? (
														<span
															aria-hidden="true"
															data-ss-ring=""
															className="pointer-events-none absolute inset-x-1.5 inset-y-0.5 animate-ss-fade rounded-lg ring-2 ring-primary/50"
														/>
													) : null}
												</>
											) : null}
											{cellContent(column, row, locale)}
										</Cell>
									);
								})}
								{rowMenu ? (
									<td data-ss-menu="" className={cx(TABLE.td, TABLE.menu)}>
										{selecting ? null : <RowMenu label={words.rowActions(label)} items={rowMenu(row)} />}
									</td>
								) : null}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

/**
 * What a cell shows.
 * @template T
 * @param {DataColumn<T>} column
 * @param {T} row
 * @param {string} locale
 * @returns {ReactNode}
 */
function cellContent(column, row, locale) {
	if (column.pill) {
		const pill = column.pill(row);
		return (
			<StatusPill status={pill.status} {...(pill.title ? { title: pill.title } : {})}>
				{pill.label}
			</StatusPill>
		);
	}
	if (column.render) return column.render(row);
	const value = cell(row, column.key);
	if (column.kind === 'date') return formatDate(/** @type {string | number | Date | null | undefined} */ (value), { locale });
	return /** @type {ReactNode} */ (value);
}
