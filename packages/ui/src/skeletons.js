/**
 * Loading placeholders of the layout system (layout contract 2026-10-17, item 11): every component renders its own
 * skeleton, with the sizes of `layout-metrics.js` that the real component uses too, so nothing jumps when the data
 * arrives. A skeleton is one `role="status"` region (`aria-busy`), the blocks inside are decoration.
 * @module
 */
import { cx } from './cx.js';
import { SkeletonBlock, STAT_GRID } from './display.js';
import { ROW_GRID, ROW_LABEL, ROW_LIST } from './fields.js';
import {
	BAR,
	CARD,
	columnClass,
	DRAWER,
	DRAWER_WIDTH,
	FIGURES_TABLE,
	LIST,
	METRICS,
	NAV_PANEL,
	PAGE,
	pageBody,
} from './layout-metrics.js';
import { Crumbs, ShellMenuButton } from './page-parts.js';
import { PaginationSkeleton } from './paged.js';

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
 * The figures table while it loads: the same scrolling container, sticky header row, skeleton rows with the same column
 * kinds and alignments, and an optional totals row.
 * @param {{ columns: number | SkeletonColumn[], rows?: number, totals?: boolean,
 *   label?: string, className?: string }} props
 */
export function FiguresTableSkeleton({ columns, rows = 6, totals = false, label = 'Loading', className }) {
	/** @type {SkeletonColumn[]} */
	const list = typeof columns === 'number' ? Array.from({ length: columns }, () => ({})) : columns;
	return (
		<div role="status" aria-label={label} aria-busy="true" className={cx(FIGURES_TABLE.scroller, 'animate-ss-fade', className)}>
			<table className={FIGURES_TABLE.table}>
				<thead>
					<tr>
						{list.map((column, i) => (
							<th key={i} scope="col" className={cx(FIGURES_TABLE.th, columnClass(column))}>
								{column.header ?? <SkeletonBlock className="inline-block h-3 w-14 align-middle" />}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{Array.from({ length: rows }, (_, row) => (
						<tr key={row}>
							{list.map((column, i) => (
								<td key={i} className={cx(FIGURES_TABLE.td, columnClass(column))}>
									<SkeletonBlock
										className={cx(
											CELLS[column.kind ?? 'text'],
											(column.kind ?? 'text') === 'text' && WIDTHS[(row + i) % WIDTHS.length],
										)}
									/>
								</td>
							))}
						</tr>
					))}
				</tbody>
				{totals ? (
					<tfoot className={FIGURES_TABLE.tfoot}>
						<tr>
							{list.map((column, i) => (
								<td key={i} className={cx(FIGURES_TABLE.tf, columnClass(column))}>
									<SkeletonBlock className={cx(CELLS[column.kind ?? 'text'], i === 0 && 'w-12')} />
								</td>
							))}
						</tr>
					</tfoot>
				) : null}
			</table>
		</div>
	);
}

/**
 * A list of rich rows while it loads (the real rows are `Row`s): the same fixed row height, a round lead, a title line and
 * a fact line, and a value. One `role="status"` region, so a screen reader hears one word.
 * @param {{ rows?: number, label?: string, className?: string }} props
 */
export function RowListSkeleton({ rows = 3, label = 'Loading', className }) {
	return (
		<div role="status" aria-label={label} aria-busy="true" className={cx('animate-ss-fade', className)}>
			{Array.from({ length: rows }, (_, i) => (
				<div key={i} aria-hidden="true" className={cx('flex items-center gap-3 px-2.5', LIST.row)}>
					<SkeletonBlock className="size-8 shrink-0 rounded-full" />
					<div className="min-w-0 flex-1 space-y-1.5">
						<SkeletonBlock className={cx('h-3.5', i % 2 ? 'w-1/3' : 'w-2/5')} />
						<SkeletonBlock className="h-3 w-3/4" />
					</div>
					<SkeletonBlock className="h-3 w-8 shrink-0" />
				</div>
			))}
		</div>
	);
}

/**
 * A settings card while it loads: the same box and header, and rows with the label on the left and the control on the
 * right (they stack when the card is narrow, like the real rows).
 * @param {{ rows?: number, title?: boolean, className?: string }} props `title`: draw the title and description lines
 */
export function SettingsCardSkeleton({ rows = 3, title = true, className }) {
	return (
		<div aria-hidden="true" className={cx(CARD.box, 'animate-ss-fade', className)}>
			{title ? (
				<div className={CARD.header}>
					<div className="min-w-0 flex-1 space-y-2">
						<SkeletonBlock className="h-5 w-40" />
						<SkeletonBlock className="h-3 w-64 max-w-full" />
					</div>
				</div>
			) : null}
			<div className={cx(title ? CARD.bodyWithHeader : CARD.body, '@container')}>
				<div className={ROW_LIST}>
					{Array.from({ length: rows }, (_, i) => (
						<div key={i} className={ROW_GRID}>
							<div className={ROW_LABEL}>
								<SkeletonBlock className={cx('h-4', i % 2 ? 'w-28' : 'w-36')} />
								<SkeletonBlock className="h-3 w-48 max-w-full" />
							</div>
							<SkeletonBlock className="h-9 w-full" />
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * A row of summary tiles while it loads (the real tiles are `Stat` in a `StatGrid`): the same grid, tile boxes and
 * padding, a label, a value and a hint.
 * @param {{ tiles?: number, className?: string }} props
 */
export function StatGridSkeleton({ tiles = 4, className }) {
	return (
		<div aria-hidden="true" className={cx('@container min-w-0 animate-ss-fade', className)}>
			<div className={STAT_GRID}>
				{Array.from({ length: tiles }, (_, i) => (
					<div key={i} className={CARD.tile}>
						<div className="space-y-2">
							<SkeletonBlock className="h-4 w-24" />
							<SkeletonBlock className="h-8 w-20" />
							<SkeletonBlock className="h-3 w-32" />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * A page while it loads (for a route's `loading.js`, and what {@link Page} draws for `loading`): the same one-line
 * header (the breadcrumbs when they are known, blocks for the numbers and the actions), the same inner navigation, toolbar,
 * body and footer areas as the page, the same sizes. `children` is the body's own skeleton (a `RowListSkeleton`, an
 * `OverviewSkeleton`); a few settings cards by default.
 * @param {{ crumbs?: import('./page-parts.js').PageCrumb[], linkAs?: import('react').ElementType, nav?: boolean,
 *   list?: boolean, toolbar?: boolean, footer?: boolean, flush?: boolean, label?: string, children?: import('react').ReactNode,
 *   className?: string }} props
 */
export function PageSkeleton({
	crumbs,
	linkAs,
	nav = false,
	list = false,
	toolbar = false,
	footer = false,
	flush = false,
	label = 'Loading',
	children,
	className,
}) {
	return (
		<div data-ss-page="" aria-busy="true" className={cx(PAGE.root, className)}>
			<span role="status" className="sr-only">
				{label}
			</span>
			<header data-ss-part="header" className={PAGE.header}>
				<ShellMenuButton />
				<div className="min-w-0 flex-1">
					{crumbs && crumbs.length > 0 ? (
						<Crumbs crumbs={crumbs} {...(linkAs ? { linkAs } : {})} />
					) : (
						<SkeletonBlock className="h-5 w-48 max-w-full" />
					)}
				</div>
				<SkeletonBlock className="hidden h-7 w-28 rounded-full @[60rem]:block" />
				<SkeletonBlock className="h-9 w-24" />
			</header>
			<div className={list ? PAGE.listArea : PAGE.area}>
				{list ? (
					<aside aria-hidden="true" className={cx(LIST.column, 'animate-ss-fade hidden lg:flex')}>
						<div className="p-2">
							<SkeletonBlock className="h-9 w-full rounded-control" />
						</div>
						<div className="flex-1 space-y-1 p-2">
							<RowListSkeleton rows={8} />
						</div>
					</aside>
				) : nav ? (
					<InnerNavSkeleton />
				) : null}
				<section className={PAGE.main}>
					{toolbar ? (
						<div data-ss-part="toolbar" className={PAGE.toolbar}>
							<ToolbarSkeleton />
						</div>
					) : null}
					<div data-ss-part="body" className={pageBody({ toolbar, footer })}>
						<div className={flush ? PAGE.flush : PAGE.padded}>
							{children ?? (
								<>
									<SettingsCardSkeleton />
									<SettingsCardSkeleton />
								</>
							)}
						</div>
					</div>
					{footer ? (
						<div data-ss-part="footer" className={PAGE.footer}>
							<PaginationSkeleton />
						</div>
					) : null}
				</section>
			</div>
		</div>
	);
}

/**
 * The body of a drawer while its record loads: a few settings cards, drawn at the size of the real ones.
 * @param {{ label?: string, className?: string }} props
 */
export function DrawerBodySkeleton({ label = 'Loading', className }) {
	return (
		<div role="status" aria-label={label} className={cx('space-y-4', className)}>
			<SettingsCardSkeleton rows={3} />
			<SettingsCardSkeleton rows={2} />
		</div>
	);
}

/**
 * A whole drawer while it loads: the same panel width, one-line header (a title block and the close button), scrolling
 * body and fixed footer (two buttons) as the real {@link Drawer}.
 * @param {{ size?: 'md' | 'lg', footer?: boolean, label?: string, className?: string }} props
 */
export function DrawerSkeleton({ size = 'md', footer = true, label = 'Loading', className }) {
	return (
		<div aria-busy="true" className={cx(DRAWER.panel, DRAWER_WIDTH[size], 'animate-ss-fade', className)}>
			<div data-ss-part="header" className={DRAWER.header}>
				<SkeletonBlock className="h-5 w-48 max-w-full" />
				<SkeletonBlock className="ml-auto size-8 shrink-0 rounded-control" />
			</div>
			<div data-ss-part="body" className={DRAWER.body}>
				<DrawerBodySkeleton label={label} />
			</div>
			{footer ? (
				<div data-ss-part="footer" className={DRAWER.footer}>
					<SkeletonBlock className="h-9 w-20" />
					<SkeletonBlock className="h-9 w-24" />
				</div>
			) : null}
		</div>
	);
}
