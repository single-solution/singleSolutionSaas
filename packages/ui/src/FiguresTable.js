'use client';
/**
 * The figures table (owner 2026-10-21 19:47, K-1e): the ONE table in the kit, only for figures. Used strictly for
 * reading and comparing numbers across many rows and several columns: usage by day and product, finance sums by month,
 * reports, tax lines, or order lines. Lists you pick from or open one at a time are always `Row`s in a `ListColumn`.
 *
 * It has:
 * - A semantic `<table>` inside a scrolling container with a sticky header row;
 * - Column kinds: text, number (right-aligned, tabular figures), money (right-aligned, tabular figures), date (formatted), status pill;
 * - Sorting: accessible column header buttons with visual arrows and `aria-sort`;
 * - Five states: loading skeleton, truly empty, no match for search/filter with Clear, failed to load with Retry, and loaded content;
 * - A total row (`totals`) when figures have a sum;
 * - On phones, columns hide or stack into figure cards so the page never scrolls sideways.
 * @module
 */
import { useMemo, useState } from 'react';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { EmptyState, StatusPill } from './display.js';
import { formatDate } from './format.js';
import { Icon } from './icons.js';
import { columnClass, FIGURES_TABLE } from './layout-metrics.js';
import { FiguresTableSkeleton } from './skeletons.js';
import { useDisplayLocale } from './time.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./layout-metrics.js').ColumnKind} ColumnKind */
/** @typedef {import('./display.js').PillStatus} PillStatus */

/**
 * @template T
 * @typedef {object} FigureColumn
 * @property {string} key the property of the row the cell shows, and the id of the column
 * @property {ReactNode} header the label shown in the table header
 * @property {ColumnKind} [kind] text (default), number, money, date or status
 * @property {(row: T) => ReactNode} [render] custom cell renderer; by default the row's value (dates formatted)
 * @property {(row: T) => { status: PillStatus, label: ReactNode, title?: string }} [pill] draws the cell as a status pill
 * @property {boolean} [sortable] clicking the header sorts by this column
 * @property {(row: T) => string | number | Date | null | undefined} [sortValue] what to sort by (default: row's value)
 * @property {'left' | 'right' | 'center'} [align] overrides the alignment of the kind
 * @property {boolean} [low] low-priority column: hidden on narrow widths
 * @property {boolean} [wrap] let long text wrap on whole words instead of single line
 * @property {boolean} [rowHeader] this cell is the row's `<th scope="row">` (first column by default)
 * @property {string} [className] extra classes for the column
 */

/**
 * @typedef {object} FiguresTableTexts
 * @property {string} empty message when there is no data
 * @property {string} loading label for the loading state
 * @property {string} total label for the summary total row
 * @property {string} noFilterMatch message when search/filter finds nothing
 * @property {(query: string) => string} noMatch message when search query finds nothing
 * @property {string} clearFilter button label to reset search/filter
 * @property {string} retry button label to try loading again
 * @property {string} couldNotLoad message when data failed to load
 * @property {(header: string) => string} sortBy accessible label for sort buttons
 */

/** The default user-facing words of the figures table. @type {Readonly<FiguresTableTexts>} */
export const FIGURES_TABLE_TEXTS = Object.freeze({
	empty: 'Nothing to show yet.',
	loading: 'Loading figures...',
	total: 'Total',
	noFilterMatch: 'No match for filter',
	/** @param {string} query */
	noMatch: (query) => `No match for "${query}"`,
	clearFilter: 'Clear filter',
	retry: 'Try again',
	couldNotLoad: 'Could not load figures.',
	/** @param {string} header */
	sortBy: (header) => `Sort by ${header}`,
});

/**
 * @template T
 * @param {T} row
 * @param {string} key
 */
const cell = (row, key) => /** @type {Record<string, unknown>} */ (row)[key];

/** The value to sort by, as something comparable. @param {unknown} value */
const comparable = (value) => (value instanceof Date ? value.getTime() : value);

/**
 * FiguresTable: the ONE table for figures.
 * @template T
 * @param {{
 *   columns: FigureColumn<T>[],
 *   rows: T[],
 *   rowKey: (row: T) => string,
 *   caption: string,
 *   totals?: Record<string, ReactNode> | ((rows: T[]) => Record<string, ReactNode>),
 *   totalsLabel?: string,
 *   sort?: { key: string, dir: 'asc' | 'desc' },
 *   onSort?: (key: string, dir: 'asc' | 'desc') => void,
 *   defaultSort?: { key: string, dir: 'asc' | 'desc' },
 *   loading?: boolean,
 *   skeletonRows?: number,
 *   empty?: ReactNode,
 *   filterQuery?: string,
 *   isFiltered?: boolean,
 *   onClearFilter?: () => void,
 *   problem?: any,
 *   onRetry?: () => void,
 *   stacked?: boolean,
 *   texts?: Partial<FiguresTableTexts>,
 *   className?: string
 * }} props
 */
export function FiguresTable({
	columns,
	rows,
	rowKey,
	caption,
	totals,
	totalsLabel,
	sort,
	onSort,
	defaultSort,
	loading = false,
	skeletonRows = 6,
	empty,
	filterQuery,
	isFiltered = false,
	onClearFilter,
	problem,
	onRetry,
	stacked = true,
	texts,
	className,
}) {
	const words = { ...FIGURES_TABLE_TEXTS, ...texts };
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

	// 1. Loading state
	if (loading) {
		return (
			<FiguresTableSkeleton
				columns={columns}
				rows={skeletonRows}
				totals={Boolean(totals)}
				label={words.loading}
				{...(className ? { className } : {})}
			/>
		);
	}

	// 2. Failed state
	if (problem) {
		const message = typeof problem === 'string' ? problem : problem?.message || problem?.title || words.couldNotLoad;
		return (
			<div className={cx(FIGURES_TABLE.scroller, 'flex flex-col items-center justify-center p-6', className)}>
				<EmptyState
					tone="danger"
					icon="alert"
					title={message}
					action={
						onRetry ? (
							<Button size="sm" variant="secondary" onClick={onRetry}>
								{words.retry}
							</Button>
						) : null
					}
				/>
			</div>
		);
	}

	// 3. No match for search or filter
	const hasFilter = isFiltered || Boolean(filterQuery);
	if (rows.length === 0 && hasFilter) {
		return (
			<div className={cx(FIGURES_TABLE.scroller, 'flex flex-col items-center justify-center p-6', className)}>
				<EmptyState
					compact
					icon={filterQuery ? 'search' : 'filter'}
					title={filterQuery ? words.noMatch(filterQuery) : words.noFilterMatch}
					action={
						onClearFilter ? (
							<Button size="sm" variant="secondary" onClick={onClearFilter}>
								{words.clearFilter}
							</Button>
						) : null
					}
				/>
			</div>
		);
	}

	// 4. Truly empty state
	if (rows.length === 0) {
		return (
			<div className={cx(FIGURES_TABLE.scroller, 'flex flex-col items-center justify-center p-6', className)}>
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

	const headerColumn = columns.some((c) => c.rowHeader) ? null : columns[0];
	const evaluatedTotals = typeof totals === 'function' ? totals(sorted) : totals;
	const totalTitle = totalsLabel ?? words.total;

	return (
		<div
			role="region"
			aria-label={caption}
			tabIndex={0}
			className={cx(
				FIGURES_TABLE.scroller,
				'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
				className,
			)}>
			{/* On phones when stacked = true: clean stacked figure rows so page never scrolls sideways */}
			{stacked ? (
				<div className="sm:hidden space-y-3 p-3" data-ss-part="figures-stacked">
					<p className="sr-only">{caption}</p>
					{sorted.map((row) => {
						const key = rowKey(row);
						const primary = headerColumn ?? columns[0];
						if (!primary) return null;
						const rest = columns.filter((col) => col !== primary);
						return (
							<div key={key} className="rounded-card border border-line-soft bg-surface p-3.5 space-y-2 shadow-xs">
								<div className="font-semibold text-fg">{cellContent(primary, row, locale)}</div>
								<div className="grid grid-cols-2 gap-2 text-xs">
									{rest.map((col) => (
										<div
											key={col.key}
											className={cx(
												'flex flex-col space-y-0.5',
												(col.kind === 'number' || col.kind === 'money' || col.align === 'right') && 'text-right',
											)}>
											<span className="text-muted">{col.header}</span>
											<span
												className={cx(
													'font-medium text-fg',
													(col.kind === 'number' || col.kind === 'money') && 'tabular-nums',
												)}>
												{cellContent(col, row, locale)}
											</span>
										</div>
									))}
								</div>
							</div>
						);
					})}
					{evaluatedTotals ? (
						<div className="rounded-card border-2 border-line-strong bg-surface-2/60 p-3.5 space-y-2 font-semibold">
							<div className="text-fg">{totalTitle}</div>
							<div className="grid grid-cols-2 gap-2 text-xs">
								{columns.slice(1).map((col) => (
									<div
										key={col.key}
										className={cx(
											'flex flex-col space-y-0.5',
											(col.kind === 'number' || col.kind === 'money' || col.align === 'right') && 'text-right',
										)}>
										<span className="text-muted">{col.header}</span>
										<span className={cx('text-fg', (col.kind === 'number' || col.kind === 'money') && 'tabular-nums')}>
											{evaluatedTotals[col.key] ?? '—'}
										</span>
									</div>
								))}
							</div>
						</div>
					) : null}
				</div>
			) : null}

			{/* Semantic <table>: hidden on phones if stacked, or shown everywhere if stacked = false */}
			<table className={cx(FIGURES_TABLE.table, stacked && 'hidden sm:table')}>
				<caption className="sr-only">{caption}</caption>
				<thead>
					<tr>
						{columns.map((column) => {
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
									className={cx(FIGURES_TABLE.th, columnClass(column))}>
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
					</tr>
				</thead>
				<tbody>
					{sorted.map((row) => {
						const key = rowKey(row);
						return (
							<tr key={key} className="hover:bg-surface-2/60 ss-motion relative border-b border-line-soft">
								{columns.map((column) => {
									const header = column.rowHeader || column === headerColumn;
									const Cell = header ? 'th' : 'td';
									return (
										<Cell
											key={column.key}
											{...(header ? { scope: 'row' } : {})}
											className={cx(FIGURES_TABLE.td, columnClass(column))}>
											{cellContent(column, row, locale)}
										</Cell>
									);
								})}
							</tr>
						);
					})}
				</tbody>
				{evaluatedTotals ? (
					<tfoot className={FIGURES_TABLE.tfoot}>
						<tr>
							{columns.map((column, i) => {
								const header = column.rowHeader || column === headerColumn;
								const Cell = header ? 'th' : 'td';
								const val = evaluatedTotals[column.key];
								return (
									<Cell
										key={column.key}
										{...(header ? { scope: 'row' } : {})}
										className={cx(FIGURES_TABLE.tf, columnClass(column))}>
										{val !== undefined ? val : i === 0 ? totalTitle : null}
									</Cell>
								);
							})}
						</tr>
					</tfoot>
				) : null}
			</table>
		</div>
	);
}

/**
 * What a cell shows.
 * @template T
 * @param {FigureColumn<T>} column
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
