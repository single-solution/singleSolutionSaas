'use client';
/**
 * Data table: semantic `<table>` with a caption, client-side sorting of the loaded rows (`aria-sort` on headers,
 * sort buttons are keyboard operable) and cursor pagination (`hasMore` + `onLoadMore`, the Portal's
 * `nextCursor`). Wide tables scroll horizontally inside their container on small screens.
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
 * @property {boolean} [sortable]
 * @property {(row: T) => string | number | null | undefined} [sortValue] defaults to `row[key]`
 * @property {'left' | 'right' | 'center'} [align]
 * @property {string} [className]
 * @property {boolean} [rowHeader] render this cell as the row's `<th scope="row">`
 */

/**
 * @template T
 * @param {T} row
 * @param {string} key
 */
const cell = (row, key) => /** @type {Record<string, unknown>} */ (row)[key];

/**
 * @template T
 * @param {{ columns: Column<T>[], rows: T[], rowKey: (row: T) => string, caption: string, captionHidden?: boolean,
 *   empty?: import('react').ReactNode, hasMore?: boolean, loadingMore?: boolean, onLoadMore?: () => void,
 *   defaultSort?: { key: string, direction: 'asc' | 'desc' }, className?: string, dense?: boolean }} props
 */
export function Table({
	columns,
	rows,
	rowKey,
	caption,
	captionHidden = true,
	empty,
	hasMore = false,
	loadingMore = false,
	onLoadMore,
	defaultSort,
	className,
	dense = false,
}) {
	const [sort, setSort] = useState(defaultSort ?? null);
	const sorted = useMemo(() => {
		if (!sort) return rows;
		const column = columns.find((c) => c.key === sort.key);
		if (!column) return rows;
		const valueOf = column.sortValue ?? ((/** @type {T} */ row) => /** @type {any} */ (cell(row, column.key)));
		const factor = sort.direction === 'asc' ? 1 : -1;
		return [...rows].sort((a, b) => {
			const va = valueOf(a);
			const vb = valueOf(b);
			if (va === vb) return 0;
			if (va === null || va === undefined) return 1;
			if (vb === null || vb === undefined) return -1;
			return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * factor;
		});
	}, [rows, columns, sort]);
	/** @param {string} key */
	const toggle = (key) =>
		setSort((s) => (s?.key === key ? { key, direction: s.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'asc' }));
	const pad = dense ? 'px-3 py-2' : 'px-5 py-3.5';
	/** @param {'left' | 'right' | 'center' | undefined} align */
	const alignClass = (align) => (align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left');
	return (
		<div className={cx('space-y-3', className)}>
			<div className="overflow-x-auto rounded-card bg-surface">
				<table className="w-full min-w-[32rem] border-collapse text-sm">
					<caption className={cx(captionHidden ? 'sr-only' : 'px-5 pb-1 pt-4 text-left text-sm font-semibold text-fg')}>
						{caption}
					</caption>
					<thead>
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
											pad,
											alignClass(column.align),
											'whitespace-nowrap text-xs font-semibold uppercase tracking-wider text-muted',
											column.className,
										)}>
										{column.sortable ? (
											<button
												type="button"
												onClick={() => toggle(column.key)}
												className="inline-flex items-center gap-1 rounded uppercase hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
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
										const content = column.render
											? column.render(row)
											: /** @type {import('react').ReactNode} */ (cell(row, column.key));
										const classes = cx(pad, alignClass(column.align), 'align-middle text-fg', column.className);
										return column.rowHeader ? (
											<th key={column.key} scope="row" className={cx(classes, 'font-semibold')}>
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
