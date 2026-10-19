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
