/**
 * The fixed sizes of the layout system (layout contract 2026-10-17). Every layout component and its skeleton take their
 * sizes from here, so a skeleton is exactly as tall and as wide as the real thing and nothing jumps when data arrives.
 * @module
 */

import { cx } from './cx.js';

/** Class names of the fixed parts. Heights are fixed on purpose: bars never grow, lists scroll inside their pane. */
export const METRICS = Object.freeze({
	/** the one-line page header */
	header: 'h-14',
	/** the fixed toolbar above a list */
	toolbar: 'h-12',
	/** the sticky header row of a table */
	thead: 'h-10',
	/** one table row */
	row: 'h-12',
	/** the fixed footer of a page (pagination) */
	footer: 'h-12',
	/** one link of the inner navigation */
	navItem: 'h-8',
	/** the header and the footer of a drawer */
	drawerHeader: 'h-14',
	drawerFooter: 'h-16',
	/** left and right padding of every pane (16 px on phones) */
	gutter: 'px-4 sm:px-6',
});

/** The inner navigation panel on wide screens (about 224 px, own scroll). */
export const NAV_PANEL =
	'hidden min-h-0 w-56 shrink-0 flex-col overflow-hidden rounded-panel border border-line-soft bg-surface shadow-panel lg:flex';

/** Drawer widths: about 480 px (`md`), about 760 px (`lg`), the whole screen on phones. */
export const DRAWER_WIDTH = Object.freeze({
	md: 'sm:max-w-[30rem]',
	lg: 'sm:max-w-[47.5rem]',
});

/**
 * The parts of a drawer, shared by the real drawer and its skeleton: the dim layer (the panel floats at the right with a
 * 12 px gap, and fills the screen on phones), the panel, its one-line header, the body (the only part that scrolls) and
 * the fixed footer.
 */
export const DRAWER = Object.freeze({
	layer: 'justify-end p-0 sm:p-3',
	panel: 'flex h-full w-full flex-col border-line-soft bg-surface text-fg shadow-overlay sm:rounded-panel sm:border',
	header: `relative z-10 flex ${METRICS.drawerHeader} shrink-0 items-center gap-3 border-b border-line-soft px-4 sm:px-6`,
	body: 'ss-scroll min-h-0 flex-1 space-y-4 px-4 py-4 sm:px-6 sm:py-5',
	footer: `flex ${METRICS.drawerFooter} shrink-0 items-center justify-end gap-2 border-t border-line-soft px-4 sm:px-6`,
});

/** How many table rows come in one after the other on first load, and the gap between them (ms). */
export const STAGGER = Object.freeze({ rows: 10, step: 15 });

/** The fixed bar above a list (toolbar, bulk bar): one line, the pane's gutters. */
export const BAR = `flex min-w-0 shrink-0 items-center gap-2 ${METRICS.toolbar} ${METRICS.gutter}`;

/**
 * What a table column holds. `number` and `money` are right-aligned with equal-width digits, `date` and `status` stay
 * on one line, `text` is the default.
 * @typedef {'text' | 'number' | 'money' | 'date' | 'status'} ColumnKind
 */

/** The parts of a data table, shared by the real table and its skeleton (same rows, same cells, same sizes). */
export const TABLE = Object.freeze({
	/** the one box that scrolls (both ways); a container for the width-based column hiding */
	scroller: 'ss-scroll @container min-h-0 flex-1 overflow-auto',
	/** separate borders, so the hairlines stay with the sticky header row */
	table: 'w-full min-w-[32rem] border-separate border-spacing-0 text-sm',
	/** a header cell: sticky, opaque */
	th: `sticky top-0 z-10 border-b border-line-soft bg-surface text-xs font-medium whitespace-nowrap text-muted ${METRICS.thead}`,
	/** a body cell: one fixed-height row with a hairline under it */
	td: `border-b border-line-soft align-middle text-fg ${METRICS.row}`,
	/** room at the left of the first cell for the corner check (tables with selection) */
	gutter: 'pl-11 @3xl:pl-11',
	/** the last column with the row menu */
	menu: 'w-12 !px-2 text-right',
	/** low-priority columns hide below this container width */
	low: 'hidden @3xl:table-cell',
});

/** The parts of a figures table, shared by the real table and its skeleton. */
export const FIGURES_TABLE = Object.freeze({
	/** the one box that scrolls (both ways); a container for width-based column hiding */
	scroller: 'ss-scroll @container min-h-0 flex-1 overflow-auto',
	/** separate borders, so the hairlines stay with the sticky header row; no forced min-width so phones don't scroll horizontally */
	table: 'w-full border-separate border-spacing-0 text-sm',
	/** a header cell: sticky, opaque */
	th: `sticky top-0 z-10 border-b border-line-soft bg-surface text-xs font-medium whitespace-nowrap text-muted ${METRICS.thead}`,
	/** a body cell: one fixed-height row with a hairline under it */
	td: `border-b border-line-soft align-middle text-fg ${METRICS.row}`,
	/** a total row in the footer: prominent border above, bold text */
	tfoot: 'sticky bottom-0 z-10 border-t-2 border-line-strong bg-surface font-semibold',
	/** a total cell: matches cell height */
	tf: `border-t-2 border-line-strong bg-surface align-middle font-semibold text-fg ${METRICS.row}`,
	/** low-priority columns hide below this container width */
	low: 'hidden @3xl:table-cell',
});

/** @type {Record<'left' | 'right' | 'center', string>} */
const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' };

/**
 * The classes every cell of a column shares (its header, its cells and its skeleton cells).
 * @param {{ kind?: ColumnKind, align?: 'left' | 'right' | 'center', low?: boolean, wrap?: boolean, className?: string }} column
 * @param {boolean} [first] the first column of a table with a corner check
 */
export const columnClass = ({ kind = 'text', align, low, wrap, className }, first = false) =>
	cx(
		'px-4 @3xl:px-5',
		ALIGN[align ?? (kind === 'number' || kind === 'money' ? 'right' : 'left')],
		(kind === 'number' || kind === 'money') && 'tabular-nums',
		wrap ? 'text-pretty' : 'whitespace-nowrap',
		low && TABLE.low,
		first && TABLE.gutter,
		className,
	);

/**
 * The parts of a page (`Page` and `PageSkeleton` share them): the one-line header panel, the area under it (the inner
 * navigation beside the main panel), and in the main panel the fixed toolbar, the one scrolling body and the fixed footer.
 */
export const PAGE = Object.freeze({
	root: 'flex min-h-0 min-w-0 flex-1 flex-col gap-3 lg:gap-4',
	// a size container: the parts of the header decide by its own width (see `Page`); z-25 keeps its menus over the toolbar
	// (z-20) and under the sidebar (z-30) now that the container is a stacking context of its own
	header: `@container z-[25] flex ${METRICS.header} min-w-0 shrink-0 items-center gap-2 rounded-panel border border-line-soft bg-surface px-2 shadow-panel sm:gap-3 sm:px-4`,
	area: 'flex min-h-0 min-w-0 flex-1 flex-col gap-3 lg:flex-row lg:gap-4',
	main: 'relative flex min-h-0 min-w-0 flex-1 flex-col rounded-panel border border-line-soft bg-surface shadow-panel',
	// above the body, so the menus of its filters open over the list
	toolbar: 'relative z-20 shrink-0 rounded-t-panel border-b border-line-soft',
	footer: `relative z-10 flex shrink-0 items-center rounded-b-panel border-t border-line-soft ${METRICS.footer} ${METRICS.gutter}`,
	/** the padding of a body that is not a list */
	padded: 'flex flex-col gap-6 p-4 sm:p-6',
	/** the body of a list: the table uses all of it */
	flush: 'flex min-h-0 flex-1 flex-col',
	/** the area of a page with a list column: the column beside the main panel (one of them alone on phones) */
	listArea: 'flex min-h-0 min-w-0 flex-1 gap-3 lg:gap-4',
});

/**
 * The rich list (`Row`, `ListColumn`): a column of fixed-height rows beside the page. A row, its skeleton and the
 * highlight that slides under the picked row are all `row` tall; `content-visibility: auto` with that intrinsic size
 * keeps a very long list fast (rows far outside the pane are not drawn).
 */
export const LIST = Object.freeze({
	/** the side column: a panel like the inner navigation, 320 px wide beside the page, the whole width on phones */
	column:
		'flex min-h-0 w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-panel border border-line-soft bg-surface shadow-panel sm:w-80',
	/** the search box and the filter chips above the rows (they stay put) */
	head: 'flex shrink-0 flex-col gap-2 p-2 pb-0',
	/** the box of the rows that scrolls; `group/list` and `data-ss-slide` tell a row that the highlight is drawn for it */
	scroller: 'ss-scroll group/list min-h-0 flex-1 p-2',
	/** one row (the outer box); the intrinsic size is the row's height */
	row: 'h-14 [content-visibility:auto] [contain-intrinsic-size:auto_3.5rem]',
	/** the highlight under the picked row: one element that moves with `transform` (`slideMove` after its first place) */
	slide: 'pointer-events-none absolute inset-x-0 top-0 -z-10 rounded-md bg-primary-soft opacity-0',
	slideMove: 'transition-[transform,height,opacity] duration-(--ss-motion) ease-ss',
	/** a filter chip, off and on */
	chip: 'ss-motion ss-press inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-micro font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
	chipOff: 'bg-surface-2 text-muted hover:text-fg',
	chipOn: 'bg-primary-soft text-on-primary-soft',
});

/** The color of the one line under a row's title (and of its warning), by meaning. */
export const LIST_TONE = Object.freeze({
	success: 'text-success',
	warning: 'text-warning',
	danger: 'text-danger',
	accent: 'text-primary',
	neutral: 'text-muted',
});

/**
 * The one scrolling box of a page. Its corners follow the panel when no toolbar or footer sits above or below it.
 * @param {{ toolbar?: boolean, footer?: boolean }} has
 */
export const pageBody = ({ toolbar = false, footer = false }) =>
	cx('ss-scroll flex min-h-0 flex-1 flex-col', !toolbar && 'rounded-t-panel', !footer && 'rounded-b-panel');

/** The card and the summary tile, shared by the real ones (`Card`, `Stat`) and their skeletons. */
export const CARD = Object.freeze({
	box: 'min-w-0 rounded-card border border-line-soft bg-surface shadow-card',
	header: 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-4',
	body: 'p-5',
	bodyWithHeader: 'px-5 pt-3 pb-5',
	tile: '@container min-w-0 rounded-card border border-line-soft bg-surface px-5 py-4',
});

/**
 * The floating save bar: a strip across the page area (the space right of the sidebar, set by `AppShell` as
 * `--ss-pane-left` / `--ss-pane-right`; the whole window without a shell) that lets clicks through, with the bar
 * centred at the bottom.
 */
export const SAVE_BAR = {
	strip: 'pointer-events-none fixed bottom-4 left-[var(--ss-pane-left,0px)] right-[var(--ss-pane-right,0px)] z-40 flex justify-center px-3 transition-[left,right] duration-(--ss-motion) ease-ss',
	bar: 'pointer-events-auto flex max-w-full flex-wrap items-center gap-x-6 gap-y-2 rounded-panel border border-line-soft bg-surface py-2 pr-2 pl-4 shadow-bar',
};
