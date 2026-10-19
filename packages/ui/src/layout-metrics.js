/**
 * The fixed sizes of the layout system (layout contract 2026-10-17). Every layout component and its skeleton take their
 * sizes from here, so a skeleton is exactly as tall and as wide as the real thing and nothing jumps when data arrives.
 * @module
 */

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
