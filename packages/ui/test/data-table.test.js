// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable, DATA_TABLE_TEXTS, useRowSelection } from '../src/DataTable.js';
import { Toolbar } from '../src/Toolbar.js';
import { TABLE, METRICS } from '../src/layout-metrics.js';
import { DataTableSkeleton } from '../src/skeletons.js';
import { act, allByRole, byText, cleanup, click, keydown, render } from '../src/testing.js';

afterEach(cleanup);

/** @typedef {{ id: string, name: string, orders: number, total: number, status: string, joined: string | null }} Row */
/** @type {Row[]} */
const ROWS = [
	{ id: 'a', name: 'Cedar Shop', orders: 12, total: 3400, status: 'active', joined: '2026-03-01T00:00:00Z' },
	{ id: 'b', name: 'Birch Studio', orders: 3, total: 120050, status: 'setup', joined: null },
	{ id: 'c', name: 'Alder & Co', orders: 40, total: 99, status: 'off', joined: '2025-12-24T00:00:00Z' },
];

/** @type {import('../src/DataTable.js').DataColumn<Row>[]} */
const COLUMNS = [
	{ key: 'name', header: 'Name', sortable: true, rowHeader: true },
	{ key: 'orders', header: 'Orders', kind: 'number', sortable: true },
	{ key: 'total', header: 'Total', kind: 'money', sortable: true, render: (row) => `$${(row.total / 100).toFixed(2)}` },
	{ key: 'joined', header: 'Joined', kind: 'date', sortable: true, low: true },
	{
		key: 'status',
		header: 'Status',
		kind: 'status',
		pill: (row) => ({ status: /** @type {'active' | 'setup' | 'off'} */ (row.status), label: row.status }),
	},
];

const names = (/** @type {HTMLElement} */ root) =>
	[...root.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('th')?.textContent);

const table = (props = {}) => <DataTable columns={COLUMNS} rows={ROWS} rowKey={(row) => row.id} caption="Merchants" {...props} />;

describe('DataTable rendering', () => {
	it('draws a captioned table with a sticky header row and one fixed-height row per record', () => {
		const { container } = render(table());
		expect(container.querySelector('caption')?.textContent).toBe('Merchants');
		const region = /** @type {HTMLElement} */ (container.querySelector('[role="region"]'));
		expect(region.getAttribute('aria-label')).toBe('Merchants');
		expect(region.className).toContain('overflow-auto');
		const heads = [...container.querySelectorAll('thead th')];
		expect(heads.map((th) => th.textContent)).toEqual(['Name', 'Orders', 'Total', 'Joined', 'Status']);
		for (const th of heads) {
			expect(th.className).toContain('sticky');
			expect(th.className).toContain(METRICS.thead);
		}
		expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
		for (const td of container.querySelectorAll('tbody td, tbody th')) expect(td.className).toContain(METRICS.row);
		expect(container.querySelector('tbody th')?.getAttribute('scope')).toBe('row');
	});

	it('knows the column kinds: numbers and money right-aligned, dates formatted, a status as a pill', () => {
		const { container } = render(table());
		const cells = [...(container.querySelector('tbody tr')?.children ?? [])];
		expect(cells[1]?.className).toContain('text-right');
		expect(cells[1]?.className).toContain('tabular-nums');
		expect(cells[2]?.textContent).toBe('$34.00');
		expect(cells[2]?.className).toContain('text-right');
		expect(cells[3]?.textContent).toBe('Mar 1, 2026');
		expect(cells[3]?.className).toContain('text-left');
		expect(cells[4]?.textContent).toBe('active');
		expect(cells[4]?.querySelector('span')).not.toBeNull();
		const header = [...container.querySelectorAll('thead th')][1];
		expect(header?.className).toContain('text-right');
		// a missing date is a dash
		const second = [...(container.querySelectorAll('tbody tr')[1]?.children ?? [])];
		expect(second[3]?.textContent).toBe('—');
	});

	it('shows a plain value for a column without a render function, and a center alignment on request', () => {
		/** @type {import('../src/DataTable.js').DataColumn<Row>[]} */
		const columns = [
			{ key: 'name', header: 'Name' },
			{ key: 'orders', header: 'Orders', align: 'center' },
		];
		const { container } = render(<DataTable columns={columns} rows={ROWS} rowKey={(row) => row.id} caption="Plain" />);
		const cells = [...(container.querySelector('tbody tr')?.children ?? [])];
		expect(cells.map((c) => c.textContent)).toEqual(['Cedar Shop', '12']);
		expect(cells[1]?.className).toContain('text-center');
		// without a row-header column the first column is the row header
		expect(cells[0]?.tagName).toBe('TH');
	});

	it('hides low-priority columns on narrow widths and lets the table scroll sideways inside its box', () => {
		const { container } = render(table());
		const low = [...container.querySelectorAll('thead th')][3];
		expect(low?.className).toContain(TABLE.low);
		expect(container.querySelector('tbody tr')?.children[3]?.className).toContain(TABLE.low);
		expect(container.querySelector('table')?.className).toContain('min-w-[32rem]');
		expect(container.querySelector('[role="region"]')?.className).toContain('@container');
	});

	it('shows the empty state instead of a header row, and a custom one when given', () => {
		const { container, rerender } = render(table({ rows: [] }));
		expect(container.querySelector('table')).toBeNull();
		expect(container.textContent).toContain(DATA_TABLE_TEXTS.empty);
		rerender(table({ rows: [], empty: <p>No merchants yet</p> }));
		expect(container.textContent).toContain('No merchants yet');
		rerender(table({ rows: [], empty: 'Nothing here' }));
		expect(container.textContent).toContain('Nothing here');
	});

	it('staggers the first rows in once, not again on later renders', () => {
		const { container, rerender } = render(table());
		const rows = [...container.querySelectorAll('tbody tr')];
		expect(rows.every((tr) => tr.className.includes('ss-stagger'))).toBe(true);
		expect(/** @type {HTMLElement} */ (rows[2]).style.getPropertyValue('--ss-i')).toBe('2');
		rerender(table({ caption: 'Merchants again' }));
		expect([...container.querySelectorAll('tbody tr')].some((tr) => tr.className.includes('ss-stagger'))).toBe(false);
	});

	it('staggers only the first ten rows', () => {
		const many = Array.from({ length: 14 }, (_, i) => ({ ...ROWS[0], id: `r${i}`, name: `Shop ${i}` }));
		const { container } = render(table({ rows: many }));
		const rows = [...container.querySelectorAll('tbody tr')];
		expect(rows.filter((tr) => tr.className.includes('ss-stagger'))).toHaveLength(10);
	});
});

describe('DataTable sorting', () => {
	it('sorts the loaded rows by a column, ascending then descending, with aria-sort', () => {
		const { container } = render(table());
		const header = (/** @type {string} */ text) =>
			/** @type {HTMLElement} */ ([...container.querySelectorAll('thead th')].find((th) => th.textContent === text));
		expect(header('Name').getAttribute('aria-sort')).toBe('none');
		expect(header('Status').getAttribute('aria-sort')).toBeNull();
		click(/** @type {HTMLElement} */ (header('Name').querySelector('button')));
		expect(names(container)).toEqual(['Alder & Co', 'Birch Studio', 'Cedar Shop']);
		expect(header('Name').getAttribute('aria-sort')).toBe('ascending');
		click(/** @type {HTMLElement} */ (header('Name').querySelector('button')));
		expect(names(container)).toEqual(['Cedar Shop', 'Birch Studio', 'Alder & Co']);
		expect(header('Name').getAttribute('aria-sort')).toBe('descending');
		click(/** @type {HTMLElement} */ (header('Orders').querySelector('button')));
		expect(names(container)).toEqual(['Birch Studio', 'Cedar Shop', 'Alder & Co']);
	});

	it('sorts dates and keeps empty values last in both directions', () => {
		const { container } = render(table());
		const button = /** @type {HTMLElement} */ ([...container.querySelectorAll('thead th')][3]?.querySelector('button'));
		click(button);
		expect(names(container)).toEqual(['Alder & Co', 'Cedar Shop', 'Birch Studio']);
		click(button);
		expect(names(container)).toEqual(['Cedar Shop', 'Alder & Co', 'Birch Studio']);
	});

	it('uses a sort value when the cell shows something else', () => {
		/** @type {import('../src/DataTable.js').DataColumn<Row>[]} */
		const columns = [
			{ key: 'name', header: 'Name', rowHeader: true },
			{ key: 'total', header: 'Total', sortable: true, sortValue: (row) => -row.total, render: (row) => String(row.total) },
		];
		const { container } = render(<DataTable columns={columns} rows={ROWS} rowKey={(row) => row.id} caption="Sorted" />);
		click(/** @type {HTMLElement} */ (container.querySelector('thead th:nth-child(2) button')));
		expect(names(container)).toEqual(['Birch Studio', 'Cedar Shop', 'Alder & Co']);
	});

	it('starts sorted with defaultSort', () => {
		const { container } = render(table({ defaultSort: { key: 'orders', dir: 'desc' } }));
		expect(names(container)).toEqual(['Alder & Co', 'Cedar Shop', 'Birch Studio']);
	});

	it('leaves the order to the page when the sort is controlled, and tells it what was asked', () => {
		const onSort = vi.fn();
		const { container } = render(table({ sort: { key: 'name', dir: 'desc' }, onSort }));
		expect(names(container)).toEqual(['Cedar Shop', 'Birch Studio', 'Alder & Co']);
		const header = /** @type {HTMLElement} */ ([...container.querySelectorAll('thead th')][0]);
		expect(header.getAttribute('aria-sort')).toBe('descending');
		click(/** @type {HTMLElement} */ (header.querySelector('button')));
		expect(onSort).toHaveBeenCalledWith('name', 'asc');
		click(/** @type {HTMLElement} */ ([...container.querySelectorAll('thead th')][1]?.querySelector('button')));
		expect(onSort).toHaveBeenLastCalledWith('orders', 'asc');
	});
});

describe('DataTable rows', () => {
	it('opens a record on a row click and on Enter, but not from a control inside the row', () => {
		const onRowClick = vi.fn();
		const { container } = render(
			table({
				onRowClick,
				columns: [
					{
						key: 'name',
						header: 'Name',
						rowHeader: true,
						render: (/** @type {Row} */ row) => <button type="button">{row.name}</button>,
					},
				],
			}),
		);
		const row = /** @type {HTMLElement} */ (container.querySelector('tbody tr'));
		expect(row.getAttribute('tabindex')).toBe('0');
		expect(row.className).toContain('cursor-pointer');
		click(/** @type {HTMLElement} */ (row.querySelector('button')));
		expect(onRowClick).not.toHaveBeenCalled();
		click(row);
		expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
		keydown(row, 'Enter');
		expect(onRowClick).toHaveBeenCalledTimes(2);
		keydown(row, 'x');
		expect(onRowClick).toHaveBeenCalledTimes(2);
	});

	it('rows are plain and not focusable without a click action', () => {
		const { container } = render(table());
		const row = /** @type {HTMLElement} */ (container.querySelector('tbody tr'));
		expect(row.getAttribute('tabindex')).toBeNull();
		expect(row.className).not.toContain('cursor-pointer');
		click(row);
	});

	it('puts the row menu in the last column and keeps its clicks away from the row', () => {
		const onRowClick = vi.fn();
		const onEdit = vi.fn();
		const { container } = render(
			table({ onRowClick, rowMenu: (/** @type {Row} */ row) => [{ label: `Edit ${row.name}`, onSelect: onEdit }] }),
		);
		const last = /** @type {HTMLElement} */ (container.querySelector('thead th:last-child'));
		expect(last.querySelector('.sr-only')?.textContent).toBe(DATA_TABLE_TEXTS.actions);
		const button = /** @type {HTMLElement} */ (container.querySelector('tbody tr button[aria-haspopup="menu"]'));
		expect(button.getAttribute('aria-label')).toBe('Actions for Cedar Shop');
		click(button);
		expect(container.querySelector('[role="menu"]')?.className).toContain('fixed');
		click(byText(container, 'Edit Cedar Shop', 'button'));
		expect(onEdit).toHaveBeenCalledTimes(1);
		expect(onRowClick).not.toHaveBeenCalled();
	});

	it('names a row for the menu and the check with rowLabel', () => {
		const { container } = render(table({ rowLabel: (/** @type {Row} */ row) => `merchant ${row.id}`, rowMenu: () => [] }));
		expect(container.querySelector('tbody button[aria-haspopup="menu"]')?.getAttribute('aria-label')).toBe(
			'Actions for merchant a',
		);
	});
});

/** A page with a toolbar, a table and the selection between them. */
/** @param {{ onRowClick?: (row: Row) => void, onBulk?: (keys: string[]) => void }} props */
function Selectable({ onRowClick = () => {}, onBulk = () => {} }) {
	const selection = useRowSelection(ROWS, (row) => row.id);
	return (
		<>
			<Toolbar
				{...selection.toolbar(
					<button type="button" onClick={() => onBulk(selection.keys)}>
						Remove
					</button>,
				)}
			/>
			<DataTable
				columns={COLUMNS}
				rows={ROWS}
				rowKey={(row) => row.id}
				caption="Merchants"
				selection={selection}
				onRowClick={onRowClick}
			/>
		</>
	);
}

const checks = (/** @type {HTMLElement} */ root) => allByRole(root, 'checkbox');
const bodyRows = (/** @type {HTMLElement} */ root) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll('tbody tr')]);

describe('DataTable selection', () => {
	it('has no checkbox column: each row has one round check in its first cell, hidden until hover', () => {
		const { container } = render(<Selectable />);
		expect(container.querySelectorAll('thead th')).toHaveLength(COLUMNS.length);
		const [check] = checks(container);
		expect(check?.getAttribute('aria-label')).toBe('Select Cedar Shop');
		expect(check?.getAttribute('aria-checked')).toBe('false');
		expect(check?.className).toContain('opacity-0');
		expect(check?.className).toContain('group-hover/row:opacity-100');
		expect(check?.closest('td, th')).toBe(bodyRows(container)[0]?.firstElementChild);
		expect(bodyRows(container)[0]?.firstElementChild?.className).toContain(TABLE.gutter.split(' ')[0]);
	});

	it('starts select mode from the Select button, and the toolbar becomes the bulk bar', () => {
		const { container } = render(<Selectable />);
		click(byText(container, 'Select', 'button'));
		expect(container.querySelector('[data-ss-bulk]')).not.toBeNull();
		expect(container.textContent).toContain('Select rows');
		for (const check of checks(container)) expect(check.className).not.toContain('opacity-0');
		click(byText(container, 'Done', 'button'));
		expect(container.querySelector('[data-ss-bulk]')).toBeNull();
	});

	it('a click anywhere on the row selects the whole row: tint, ring and filled check; the row action is held back', () => {
		const onRowClick = vi.fn();
		const { container } = render(<Selectable onRowClick={onRowClick} />);
		click(byText(container, 'Select', 'button'));
		const row = bodyRows(container)[1];
		click(/** @type {HTMLElement} */ (row?.children[2]));
		expect(onRowClick).not.toHaveBeenCalled();
		expect(row?.getAttribute('data-selected')).toBe('');
		expect(row?.className).toContain('bg-primary-soft');
		expect(row?.querySelector('[data-ss-ring]')?.className).toContain('ring-2');
		expect(checks(container)[1]?.getAttribute('aria-checked')).toBe('true');
		expect(container.textContent).toContain('1 selected');
		click(/** @type {HTMLElement} */ (bodyRows(container)[0]));
		expect(container.textContent).toContain('2 selected');
		click(/** @type {HTMLElement} */ (row));
		expect(row?.getAttribute('data-selected')).toBeNull();
		expect(row?.querySelector('[data-ss-ring]')).toBeNull();
		expect(container.textContent).toContain('1 selected');
	});

	it('Space on a focused row toggles it in select mode; the corner check toggles without a double click', () => {
		const { container } = render(<Selectable />);
		click(byText(container, 'Select', 'button'));
		keydown(/** @type {HTMLElement} */ (bodyRows(container)[2]), ' ');
		expect(container.textContent).toContain('1 selected');
		click(/** @type {HTMLElement} */ (checks(container)[0]));
		expect(container.textContent).toContain('2 selected');
		click(/** @type {HTMLElement} */ (checks(container)[0]));
		expect(container.textContent).toContain('1 selected');
	});

	it('the corner check on hover starts select mode with that row selected', () => {
		const { container } = render(<Selectable />);
		click(/** @type {HTMLElement} */ (checks(container)[1]));
		expect(container.querySelector('[data-ss-bulk]')).not.toBeNull();
		expect(container.textContent).toContain('1 selected');
		expect(bodyRows(container)[1]?.getAttribute('data-selected')).toBe('');
	});

	it('selects all, hands the chosen records to the bulk actions and leaves with Done', () => {
		const onBulk = vi.fn();
		const { container } = render(<Selectable onBulk={onBulk} />);
		click(byText(container, 'Select', 'button'));
		click(byText(container, 'Select all', 'button'));
		expect(container.textContent).toContain('3 selected');
		expect(byText(container, 'Remove', 'button')).toBeTruthy();
		click(byText(container, 'Remove', 'button'));
		expect(onBulk).toHaveBeenCalledWith(['a', 'b', 'c']);
		expect(() => byText(container, 'Select all', 'button')).toThrow();
		click(byText(container, 'Done', 'button'));
		click(byText(container, 'Select', 'button'));
		expect(container.textContent).toContain('Select rows');
	});

	it('does not follow a link inside a row in select mode, and hides the row menu', () => {
		const onRowClick = vi.fn();
		function Page() {
			const selection = useRowSelection(ROWS, (row) => row.id);
			return (
				<>
					<Toolbar {...selection.toolbar(null)} />
					<DataTable
						columns={[
							{
								key: 'name',
								header: 'Name',
								rowHeader: true,
								render: (/** @type {Row} */ row) => <a href="#x">{row.name}</a>,
							},
						]}
						rows={ROWS}
						rowKey={(row) => row.id}
						caption="Links"
						selection={selection}
						onRowClick={onRowClick}
						rowMenu={() => [{ label: 'Edit', onSelect: () => {} }]}
					/>
				</>
			);
		}
		const { container } = render(<Page />);
		expect(container.querySelectorAll('tbody button[aria-haspopup="menu"]')).toHaveLength(3);
		click(byText(container, 'Select', 'button'));
		expect(container.querySelectorAll('tbody button[aria-haspopup="menu"]')).toHaveLength(0);
		const link = /** @type {HTMLAnchorElement} */ (container.querySelector('tbody a'));
		const event = new MouseEvent('click', { bubbles: true, cancelable: true });
		act(() => {
			link.dispatchEvent(event);
		});
		expect(event.defaultPrevented).toBe(true);
		expect(container.textContent).toContain('1 selected');
		expect(onRowClick).not.toHaveBeenCalled();
	});

	it('forgets selected records that left the list', () => {
		/** @param {{ rows: Row[] }} props */
		function Page({ rows }) {
			const selection = useRowSelection(rows, (row) => row.id);
			return (
				<>
					<Toolbar {...selection.toolbar(null)} />
					<DataTable columns={COLUMNS} rows={rows} rowKey={(row) => row.id} caption="T" selection={selection} />
				</>
			);
		}
		const { container, rerender } = render(<Page rows={ROWS} />);
		click(byText(container, 'Select', 'button'));
		click(byText(container, 'Select all', 'button'));
		expect(container.textContent).toContain('3 selected');
		rerender(<Page rows={ROWS.slice(0, 2)} />);
		expect(container.textContent).toContain('2 selected');
	});

	it('shows no Select button for an empty list', () => {
		function Page() {
			const selection = useRowSelection(/** @type {Row[]} */ ([]), (row) => row.id);
			return <Toolbar {...selection.toolbar(null)} />;
		}
		const { container } = render(<Page />);
		expect(() => byText(container, 'Select', 'button')).toThrow();
	});
});

describe('DataTable loading', () => {
	it('draws skeleton rows with the real headers and the same cell classes', () => {
		const real = render(table());
		const realHead = [...real.container.querySelectorAll('thead th')].map((th) => th.className);
		const realCell = [...(real.container.querySelector('tbody tr')?.children ?? [])].map((td) => td.className);
		cleanup();
		const { container } = render(table({ loading: true, skeletonRows: 4 }));
		const status = /** @type {HTMLElement} */ (container.querySelector('[role="status"]'));
		expect(status.getAttribute('aria-busy')).toBe('true');
		expect([...container.querySelectorAll('thead th')].map((th) => th.className)).toEqual(realHead);
		expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
			'Name',
			'Orders',
			'Total',
			'Joined',
			'Status',
		]);
		expect(container.querySelectorAll('tbody tr')).toHaveLength(4);
		const skeletonCell = [...(container.querySelector('tbody tr')?.children ?? [])].map((td) => td.className);
		// the same classes, except that a body cell of the real table also marks the first one as the row header
		expect(skeletonCell).toEqual(realCell);
		expect(container.querySelector('tbody .ss-shimmer')).not.toBeNull();
		expect(container.querySelector('caption')).toBeNull();
	});

	it('gives the skeleton the corner-check room and the menu column when the table has them', () => {
		const { container } = render(
			table({ loading: true, rowMenu: () => [], selection: { mode: false, isSelected: () => false } }),
		);
		expect(container.querySelector('tbody tr')?.firstElementChild?.className).toContain(TABLE.gutter.split(' ')[0]);
		expect(container.querySelector('thead th:last-child')?.className).toContain('w-12');
		expect(container.querySelector('tbody tr')?.lastElementChild?.className).toContain('w-12');
	});

	it('the standalone skeleton takes a number of columns when the real ones are not known yet', () => {
		const { container } = render(<DataTableSkeleton columns={4} rows={3} label="Loading merchants" />);
		expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading merchants');
		expect(container.querySelectorAll('thead th')).toHaveLength(4);
		expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
		expect(container.querySelectorAll('tbody tr:first-child td, tbody tr:first-child th')).toHaveLength(4);
	});
});
