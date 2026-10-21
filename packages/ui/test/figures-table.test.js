// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FiguresTable, FIGURES_TABLE_TEXTS } from '../src/FiguresTable.js';
import { FIGURES_TABLE, METRICS } from '../src/layout-metrics.js';
import { FiguresTableSkeleton } from '../src/skeletons.js';
import { byText, cleanup, click, render } from '../src/testing.js';

afterEach(cleanup);

/** @typedef {{ id: string, name: string, day: string, count: number, credits: number, status: string }} FigureRow */

/** @type {FigureRow[]} */
const ROWS = [
	{ id: '1', name: 'Cedar Store', day: '2026-10-20T00:00:00Z', count: 140, credits: 2800, status: 'active' },
	{ id: '2', name: 'Birch Studio', day: '2026-10-21T00:00:00Z', count: 5, credits: 100, status: 'setup' },
	{ id: '3', name: 'Alder Co', day: '2026-10-22T00:00:00Z', count: 900, credits: 18000, status: 'active' },
];

/** @type {import('../src/FiguresTable.js').FigureColumn<FigureRow>[]} */
const COLUMNS = [
	{ key: 'name', header: 'Product', sortable: true, rowHeader: true },
	{ key: 'day', header: 'Date', kind: 'date', sortable: true, low: true },
	{ key: 'count', header: 'Calls', kind: 'number', sortable: true },
	{
		key: 'credits',
		header: 'Spend',
		kind: 'money',
		sortable: true,
		render: (row) => `${(row.credits / 100).toFixed(2)} cr`,
	},
	{
		key: 'status',
		header: 'State',
		kind: 'status',
		pill: (row) => ({ status: /** @type {'active' | 'setup'} */ (row.status), label: row.status }),
	},
];

const renderTable = (props = {}) =>
	render(<FiguresTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} caption="Usage Figures" {...props} />);

describe('FiguresTable', () => {
	it('draws a semantic table with a sticky header row and accessible caption', () => {
		const { container } = renderTable();
		expect(container.querySelector('caption')?.textContent).toBe('Usage Figures');
		const region = /** @type {HTMLElement} */ (container.querySelector('[role="region"]'));
		expect(region.getAttribute('aria-label')).toBe('Usage Figures');
		expect(region.className).toContain('overflow-auto');
		const heads = [...container.querySelectorAll('thead th')];
		expect(heads.map((th) => th.textContent?.trim())).toEqual(['Product', 'Date', 'Calls', 'Spend', 'State']);
		for (const th of heads) {
			expect(th.className).toContain('sticky');
			expect(th.className).toContain(METRICS.thead);
		}
		expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
		expect(container.querySelector('tbody th')?.getAttribute('scope')).toBe('row');
	});

	it('knows column kinds: numbers and money right-aligned with tabular figures, dates formatted', () => {
		const { container } = renderTable();
		const cells = [...(container.querySelector('tbody tr')?.children ?? [])];
		// calls column is number: right-aligned, tabular-nums
		expect(cells[2]?.className).toContain('text-right');
		expect(cells[2]?.className).toContain('tabular-nums');
		expect(cells[2]?.textContent).toBe('140');
		// spend column is money: right-aligned, tabular-nums, custom render
		expect(cells[3]?.className).toContain('text-right');
		expect(cells[3]?.className).toContain('tabular-nums');
		expect(cells[3]?.textContent).toBe('28.00 cr');
		// date column is formatted
		expect(cells[1]?.textContent).toBe('Oct 20, 2026');
		// status column renders a StatusPill
		expect(cells[4]?.querySelector('span')).not.toBeNull();
		expect(cells[4]?.textContent).toBe('active');
	});

	it('low columns are marked to hide on narrow containers without forcing large min-width', () => {
		const { container } = renderTable({ stacked: false });
		const table = container.querySelector('table');
		expect(table?.className).not.toContain('min-w-[32rem]');
		const lowHead = [...container.querySelectorAll('thead th')][1];
		expect(lowHead?.className).toContain(FIGURES_TABLE.low);
	});

	it('sorts client-side by header button with visible icon and aria-sort', () => {
		const { container } = renderTable();
		const callsTh = /** @type {HTMLElement} */ ([...container.querySelectorAll('thead th')][2]);
		expect(callsTh.getAttribute('aria-sort')).toBe('none');
		const sortButton = callsTh.querySelector('button');
		expect(sortButton).not.toBeNull();
		expect(sortButton?.getAttribute('title')).toBe('Sort by Calls');

		// Click to sort ascending
		click(/** @type {HTMLElement} */ (sortButton));
		expect(callsTh.getAttribute('aria-sort')).toBe('ascending');
		let firstRowCalls = container.querySelector('tbody tr')?.children[2]?.textContent;
		expect(firstRowCalls).toBe('5');

		// Click to sort descending
		click(/** @type {HTMLElement} */ (sortButton));
		expect(callsTh.getAttribute('aria-sort')).toBe('descending');
		firstRowCalls = container.querySelector('tbody tr')?.children[2]?.textContent;
		expect(firstRowCalls).toBe('900');
	});

	it('supports controlled sorting via sort and onSort', () => {
		const onSort = vi.fn();
		const { container } = renderTable({
			sort: { key: 'count', dir: 'desc' },
			onSort,
		});
		const callsTh = /** @type {HTMLElement} */ ([...container.querySelectorAll('thead th')][2]);
		expect(callsTh.getAttribute('aria-sort')).toBe('descending');
		const button = callsTh.querySelector('button');
		click(/** @type {HTMLElement} */ (button));
		expect(onSort).toHaveBeenCalledWith('count', 'asc');
	});

	it('renders a totals row when totals prop is provided as object or function', () => {
		const totalsObject = { count: 1045, credits: '209.00 cr' };
		const { container, rerender } = renderTable({ totals: totalsObject });
		const tfoot = container.querySelector('tfoot');
		expect(tfoot).not.toBeNull();
		expect(tfoot?.className).toContain('sticky');
		const footCells = [...(tfoot?.querySelectorAll('td, th') ?? [])];
		expect(footCells[0]?.textContent).toBe('Total');
		expect(footCells[2]?.textContent).toBe('1045');
		expect(footCells[2]?.className).toContain('text-right');
		expect(footCells[3]?.textContent).toBe('209.00 cr');

		// With a function and custom label
		const totalsFn = vi.fn((/** @type {FigureRow[]} */ rows) => ({ count: rows.reduce((acc, r) => acc + r.count, 0) }));
		rerender(
			<FiguresTable
				columns={COLUMNS}
				rows={ROWS}
				rowKey={(r) => r.id}
				caption="Usage"
				totals={totalsFn}
				totalsLabel="Overall Sum"
			/>,
		);
		expect(totalsFn).toHaveBeenCalled();
		const updatedFoot = container.querySelector('tfoot');
		expect(updatedFoot?.textContent).toContain('Overall Sum');
		expect(updatedFoot?.textContent).toContain('1045');
	});

	describe('five states', () => {
		it('1. Loading: shows FiguresTableSkeleton with aria-busy', () => {
			const { container } = renderTable({ loading: true });
			expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
			expect(container.querySelector('table')).not.toBeNull();
		});

		it('2. Problem / failed: shows danger state with Retry action', () => {
			const onRetry = vi.fn();
			const { container } = renderTable({
				problem: { message: 'Database connection failed' },
				onRetry,
			});
			expect(container.textContent).toContain('Database connection failed');
			const retryBtn = byText(container, 'Try again', 'button');
			expect(retryBtn).not.toBeNull();
			click(retryBtn);
			expect(onRetry).toHaveBeenCalledTimes(1);
		});

		it('3. No match for search / filter: shows search icon and Clear button', () => {
			const onClearFilter = vi.fn();
			const { container } = renderTable({
				rows: [],
				filterQuery: 'Nonexistent',
				onClearFilter,
			});
			expect(container.textContent).toContain('No match for "Nonexistent"');
			const clearBtn = byText(container, 'Clear filter', 'button');
			expect(clearBtn).not.toBeNull();
			click(clearBtn);
			expect(onClearFilter).toHaveBeenCalledTimes(1);
		});

		it('3b. No match for filter without search query: shows noFilterMatch', () => {
			const onClearFilter = vi.fn();
			const { container } = renderTable({
				rows: [],
				isFiltered: true,
				onClearFilter,
			});
			expect(container.textContent).toContain('No match for filter');
		});

		it('4. Truly empty: shows friendly empty state', () => {
			const { container } = renderTable({ rows: [] });
			expect(container.textContent).toContain(FIGURES_TABLE_TEXTS.empty);
		});

		it('5. Loaded content: displays rows and figures', () => {
			const { container } = renderTable();
			expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
			expect(container.textContent).toContain('Cedar Store');
		});
	});

	it('renders stacked rows on phones so page never scrolls sideways', () => {
		const { container } = renderTable({
			stacked: true,
			totals: { count: 1045, credits: '209.00 cr' },
		});
		const stackedContainer = container.querySelector('[data-ss-part="figures-stacked"]');
		expect(stackedContainer).not.toBeNull();
		expect(stackedContainer?.className).toContain('sm:hidden');
		expect(stackedContainer?.textContent).toContain('Cedar Store');
		expect(stackedContainer?.textContent).toContain('Total');
		// desktop table is hidden on sm
		const table = container.querySelector('table');
		expect(table?.className).toContain('hidden');
		expect(table?.className).toContain('sm:table');
	});

	it('has no row selection checkboxes, row menus or clickable row handlers', () => {
		const { container } = renderTable();
		expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
		expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
		expect(container.querySelectorAll('[data-ss-menu]')).toHaveLength(0);
		const rows = container.querySelectorAll('tbody tr');
		for (const tr of rows) {
			expect(tr.className).not.toContain('cursor-pointer');
		}
	});
});
