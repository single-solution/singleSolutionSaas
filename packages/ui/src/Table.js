'use client';
/**
 * Data table: semantic `<table>` with a caption (for screen readers: the card or section around it shows the title),
 * client-side sorting of the loaded rows (`aria-sort` on headers, sort buttons are keyboard operable) and cursor
 * pagination (`hasMore` + `onLoadMore`, the Portal's `nextCursor`). Cells keep their text on one line, so a column is
 * never squeezed into a word per line; a table wider than its card (a narrow pane, a phone) scrolls horizontally inside
 * the card. A column of longer text (`wrap`) wraps on whole words within a readable minimum width instead. With no rows
 * the table is just its empty message, as wide as the card (no header row to scroll past).
 * @module
 */
import { useMemo, useState } from 'react';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { Icon } from './icons.js';

/**
 * @template T
 * @typedef {object} Column
 * @property {string} key
 * @property {import('react').ReactNode} header
 * @property {(row: T) => import('react').ReactNode} [render] defaults to `row[key]`
 * @property {boolean} [sortable] sorts by `row[key]`
 * @property {'left' | 'right' | 'center'} [align]
 * @property {string} [className]
 * @property {boolean} [rowHeader] render this cell as the row's `<th scope="row">`
 * @property {boolean} [wrap] let the text wrap on whole words (at least 10rem wide); other cells keep one line
 */

/** Cell padding: a little more room in a wide card (the table's own width, not the screen's). */
const PAD = 'px-4 py-3 @4xl:px-5';

/**
 * @template T
 * @param {T} row
 * @param {string} key
 */
const cell = (row, key) => /** @type {Record<string, unknown>} */ (row)[key];

/**
 * @template T
 * @param {{ columns: Column<T>[], rows: T[], rowKey: (row: T) => string, caption: string,
 *   empty?: import('react').ReactNode, hasMore?: boolean, loadingMore?: boolean, onLoadMore?: () => void,
 *   defaultSort?: { key: string, direction: 'asc' | 'desc' }, className?: string }} props
 */
export function Table({
	columns,
	rows,
	rowKey,
	caption,
	empty,
	hasMore = false,
	loadingMore = false,
	onLoadMore,
	defaultSort,
	className,
}) {
	const [sort, setSort] = useState(defaultSort ?? null);
	const sorted = useMemo(() => {
		if (!sort || !columns.some((c) => c.key === sort.key)) return rows;
		const factor = sort.direction === 'asc' ? 1 : -1;
		return [...rows].sort((a, b) => {
			const va = cell(a, sort.key);
			const vb = cell(b, sort.key);
			if (va === vb) return 0;
			if (va === null || va === undefined) return 1;
			if (vb === null || vb === undefined) return -1;
			return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * factor;
		});
	}, [rows, columns, sort]);
	/** @param {string} key */
	const toggle = (key) =>
		setSort((s) => (s?.key === key ? { key, direction: s.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'asc' }));
	/** @param {'left' | 'right' | 'center' | undefined} align */
	const alignClass = (align) => (align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left');
	return (
		<div className={cx('@container space-y-3', className)}>
			{/* framed on the page; inside a card (which frames it already) no second frame */}
			<div className="overflow-x-auto rounded-card border border-line-soft bg-surface in-[.rounded-card]:rounded-none in-[.rounded-card]:border-0">
				<table className={cx('w-full border-collapse text-sm', sorted.length > 0 && 'min-w-[32rem]')}>
					<caption className="sr-only">{caption}</caption>
					<thead className={cx(sorted.length === 0 && 'hidden')}>
						<tr>
							{columns.map((column) => {
								const active = sort?.key === column.key;
								const ariaSort = active
									? sort.direction === 'asc'
										? 'ascending'
										: 'descending'
									: column.sortable
										? 'none'
										: undefined;
								return (
									<th
										key={column.key}
										scope="col"
										aria-sort={ariaSort}
										className={cx(
											PAD,
											alignClass(column.align),
											'whitespace-nowrap text-xs font-medium text-muted',
											column.className,
										)}>
										{column.sortable ? (
											<button
												type="button"
												onClick={() => toggle(column.key)}
												className="inline-flex items-center gap-1 rounded hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
												{column.header}
												<Icon
													name={active ? (sort.direction === 'asc' ? 'arrowUp' : 'arrowDown') : 'sort'}
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
						{sorted.length === 0 ? (
							<tr>
								<td colSpan={columns.length} className="p-3">
									{typeof empty === 'string' || empty === undefined ? (
										<p className="px-2 py-5 text-center text-sm text-muted">{empty ?? 'Nothing to show yet.'}</p>
									) : (
										empty
									)}
								</td>
							</tr>
						) : (
							sorted.map((row) => (
								<tr
									key={rowKey(row)}
									className="ss-motion animate-ss-fade border-t border-line-soft hover:bg-surface-2/60">
									{columns.map((column) => {
										const value = column.render
											? column.render(row)
											: /** @type {import('react').ReactNode} */ (cell(row, column.key));
										// cells take no min-width: the block inside keeps a wrapping column readable
										const content = column.wrap ? <span className="block min-w-40">{value}</span> : value;
										const classes = cx(
											PAD,
											alignClass(column.align),
											'align-middle text-fg',
											column.wrap ? 'text-pretty' : 'whitespace-nowrap',
											column.className,
										);
										return column.rowHeader ? (
											<th key={column.key} scope="row" className={cx(classes, 'font-medium')}>
												{content}
											</th>
										) : (
											<td key={column.key} className={classes}>
												{content}
											</td>
										);
									})}
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>
			{hasMore && onLoadMore ? (
				<div className="flex justify-center">
					<Button variant="secondary" size="sm" onClick={onLoadMore} loading={loadingMore}>
						Load more
					</Button>
				</div>
			) : null}
		</div>
	);
}
