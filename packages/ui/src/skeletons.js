/**
 * Loading placeholders of the layout system (layout contract 2026-10-17, item 11): every component renders its own
 * skeleton, with the sizes of `layout-metrics.js` that the real component uses too, so nothing jumps when the data
 * arrives. A skeleton is one `role="status"` region (`aria-busy`), the blocks inside are decoration.
 * @module
 */
import { cx } from './cx.js';
import { SkeletonBlock } from './display.js';
import { BAR, columnClass, METRICS, NAV_PANEL, TABLE } from './layout-metrics.js';

/** Widths of the placeholder lines, repeated so a list does not look like a ruler. */
const WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6', 'w-2/5'];

/**
 * The inner navigation while it loads: the same panel (desktop) and the same dropdown button (phones).
 * @param {{ items?: number, label?: string, className?: string }} props
 */
export function InnerNavSkeleton({ items = 6, label = 'Loading', className }) {
	return (
		<>
			<div role="status" aria-label={label} aria-busy="true" className={cx('shrink-0 animate-ss-fade lg:hidden', className)}>
				<SkeletonBlock className="h-10 w-full" />
			</div>
			<div aria-hidden="true" className={cx(NAV_PANEL, 'animate-ss-fade', className)}>
				<div className="min-h-0 flex-1 space-y-1 p-2">
					{Array.from({ length: items }, (_, i) => (
						<div key={i} className={cx('flex items-center gap-2 px-2', METRICS.navItem)}>
							<SkeletonBlock className="size-4 shrink-0" />
							<SkeletonBlock className={cx('h-3', WIDTHS[i % WIDTHS.length])} />
						</div>
					))}
				</div>
			</div>
		</>
	);
}

/**
 * The toolbar while it loads: the same fixed bar, a search box and two chips on the left, the range on the right.
 * @param {{ label?: string, className?: string }} props
 */
export function ToolbarSkeleton({ label = 'Loading', className }) {
	return (
		<div role="status" aria-label={label} aria-busy="true" className={cx(BAR, 'animate-ss-fade', className)}>
			<SkeletonBlock className="h-8 w-48 max-w-full" />
			<SkeletonBlock className="hidden h-8 w-20 rounded-full sm:block" />
			<SkeletonBlock className="hidden h-8 w-24 rounded-full sm:block" />
			<SkeletonBlock className="ml-auto hidden h-4 w-24 md:block" />
		</div>
	);
}

/**
 * @typedef {object} SkeletonColumn
 * @property {import('react').ReactNode} [header]
 * @property {import('./layout-metrics.js').ColumnKind} [kind]
 * @property {'left' | 'right' | 'center'} [align]
 * @property {boolean} [low]
 * @property {boolean} [wrap]
 * @property {string} [className]
 */

/** What a placeholder cell of each column kind looks like. @type {Record<import('./layout-metrics.js').ColumnKind, string>} */
const CELLS = {
	text: 'h-3',
	number: 'ml-auto h-3 w-12',
	money: 'ml-auto h-3 w-16',
	date: 'h-3 w-20',
	status: 'h-5 w-16 rounded-full',
};

/**
 * The data table while it loads: the same scrolling box, the same header row (with the real column names when they
 * are known) and skeleton rows with the same columns, cell classes and heights as the real rows.
 * @param {{ columns: number | SkeletonColumn[], rows?: number, selectable?: boolean, menu?: boolean,
 *   label?: string, className?: string }} props `selectable` keeps the room for the corner check, `menu` the last
 *   column of the row menu
 */
export function DataTableSkeleton({ columns, rows = 8, selectable = false, menu = false, label = 'Loading', className }) {
	/** @type {SkeletonColumn[]} */
	const list = typeof columns === 'number' ? Array.from({ length: columns }, () => ({})) : columns;
	return (
		<div role="status" aria-label={label} aria-busy="true" className={cx(TABLE.scroller, 'animate-ss-fade', className)}>
			<table className={TABLE.table}>
				<thead>
					<tr>
						{list.map((column, i) => (
							<th key={i} scope="col" className={cx(TABLE.th, columnClass(column, selectable && i === 0))}>
								{column.header ?? <SkeletonBlock className="inline-block h-3 w-14 align-middle" />}
							</th>
						))}
						{menu ? <th scope="col" className={cx(TABLE.th, TABLE.menu)} /> : null}
					</tr>
				</thead>
				<tbody>
					{Array.from({ length: rows }, (_, row) => (
						<tr key={row}>
							{list.map((column, i) => (
								<td key={i} className={cx(TABLE.td, columnClass(column, selectable && i === 0))}>
									<SkeletonBlock
										className={cx(
											CELLS[column.kind ?? 'text'],
											(column.kind ?? 'text') === 'text' && WIDTHS[(row + i) % WIDTHS.length],
										)}
									/>
								</td>
							))}
							{menu ? <td className={cx(TABLE.td, TABLE.menu)} /> : null}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
