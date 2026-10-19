// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toolbar } from '../src/Toolbar.js';
import { METRICS } from '../src/layout-metrics.js';
import { act, byText, cleanup, click, keydown, render, type } from '../src/testing.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const searchBox = (/** @type {HTMLElement} */ root) =>
	/** @type {HTMLInputElement} */ (root.querySelector('input[type="search"]'));

describe('Toolbar search', () => {
	it('waits for a pause in typing before it searches', () => {
		const onSearch = vi.fn();
		const { container } = render(<Toolbar search={{ onSearch, delay: 200 }} />);
		type(searchBox(container), 'a');
		type(searchBox(container), 'ab');
		act(() => vi.advanceTimersByTime(150));
		expect(onSearch).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(100));
		expect(onSearch).toHaveBeenCalledTimes(1);
		expect(onSearch).toHaveBeenCalledWith('ab');
	});

	it('searches at once on Enter, and clears at once with Escape or the clear button', () => {
		const onSearch = vi.fn();
		const { container } = render(<Toolbar search={{ onSearch }} />);
		type(searchBox(container), 'shoes');
		keydown(searchBox(container), 'Enter');
		expect(onSearch).toHaveBeenLastCalledWith('shoes');
		type(searchBox(container), 'bags');
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Clear search"]')));
		expect(onSearch).toHaveBeenLastCalledWith('');
		expect(searchBox(container).value).toBe('');
		type(searchBox(container), 'x');
		keydown(searchBox(container), 'Escape');
		expect(onSearch).toHaveBeenLastCalledWith('');
		expect(container.querySelector('button[aria-label="Clear search"]')).toBeNull();
	});

	it('does not repeat a search that was already sent and drops a pending one on unmount', () => {
		const onSearch = vi.fn();
		const { container, unmount } = render(<Toolbar search={{ onSearch, value: 'same' }} />);
		keydown(searchBox(container), 'Enter');
		expect(onSearch).not.toHaveBeenCalled();
		type(searchBox(container), 'later');
		unmount();
		act(() => vi.advanceTimersByTime(1000));
		expect(onSearch).not.toHaveBeenCalled();
	});

	it('follows a value that the page changes (a reset)', () => {
		const { container, rerender } = render(<Toolbar search={{ onSearch: () => {}, value: 'one' }} />);
		expect(searchBox(container).value).toBe('one');
		rerender(<Toolbar search={{ onSearch: () => {}, value: '' }} />);
		expect(searchBox(container).value).toBe('');
	});

	it('uses the words it is given', () => {
		const { container } = render(
			<Toolbar search={{ onSearch: () => {}, placeholder: 'Find a merchant', label: 'Find merchants' }} />,
		);
		expect(searchBox(container).placeholder).toBe('Find a merchant');
		expect(searchBox(container).getAttribute('aria-label')).toBe('Find merchants');
	});
});

describe('Toolbar controls', () => {
	it('toggles filter chips and shows which are on', () => {
		const onToggle = vi.fn();
		const { container } = render(
			<Toolbar
				filters={[
					{ id: 'paid', label: 'Paid', active: true, onToggle },
					{ id: 'late', label: 'Late', active: false, onToggle },
				]}
			/>,
		);
		const paid = /** @type {HTMLElement} */ (byText(container, 'Paid').closest('button'));
		expect(paid.getAttribute('aria-pressed')).toBe('true');
		expect(/** @type {HTMLElement} */ (byText(container, 'Late').closest('button')).getAttribute('aria-pressed')).toBe('false');
		click(paid);
		expect(onToggle).toHaveBeenCalled();
	});

	it('picks a filter value from a menu, with an All choice that clears it', () => {
		const onChange = vi.fn();
		const { container } = render(
			<Toolbar
				filters={[
					{
						id: 'status',
						label: 'Status',
						value: 'active',
						onChange,
						options: [
							{ value: 'active', label: 'Active' },
							{ value: 'off', label: 'Off' },
						],
					},
				]}
			/>,
		);
		const chip = /** @type {HTMLElement} */ (container.querySelector('button[aria-haspopup="menu"][aria-label="Status"]'));
		expect(chip.textContent).toContain('Active');
		click(chip);
		const items = [...container.querySelectorAll('[role="menuitemradio"]')];
		expect(items.map((el) => el.textContent)).toEqual(['All', 'Active', 'Off']);
		click(/** @type {HTMLElement} */ (items[2]));
		expect(onChange).toHaveBeenCalledWith('off');
		click(chip);
		click(/** @type {HTMLElement} */ ([...container.querySelectorAll('[role="menuitemradio"]')][0]));
		expect(onChange).toHaveBeenLastCalledWith('');
	});

	it('sorts by a menu choice and flips the order', () => {
		const onChange = vi.fn();
		const onDir = vi.fn();
		const { container } = render(
			<Toolbar
				sort={{
					value: 'name',
					dir: 'asc',
					onChange,
					onDir,
					options: [
						{ value: 'name', label: 'Name' },
						{ value: 'created', label: 'Created' },
					],
				}}
			/>,
		);
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Sort"]')));
		click(byText(container, 'Created', '[role="menuitemradio"]'));
		expect(onChange).toHaveBeenCalledWith('created');
		click(/** @type {HTMLElement} */ (container.querySelector('button[aria-label="Sort"]')));
		click(byText(container, 'Descending', '[role="menuitemradio"]'));
		expect(onDir).toHaveBeenCalledWith('desc');
	});

	it('switches the view of the same data', () => {
		const onChange = vi.fn();
		const { container } = render(
			<Toolbar
				view={{
					label: 'Layout',
					value: 'list',
					onChange,
					options: [
						{ value: 'list', label: 'List', icon: 'list' },
						{ value: 'grid', label: 'Grid', icon: 'grid' },
					],
				}}
			/>,
		);
		const group = /** @type {HTMLElement} */ (container.querySelector('[role="group"][aria-label="Layout"]'));
		const [list, grid] = /** @type {HTMLElement[]} */ ([...group.querySelectorAll('button')]);
		expect(list?.getAttribute('aria-pressed')).toBe('true');
		click(/** @type {HTMLElement} */ (grid));
		expect(onChange).toHaveBeenCalledWith('grid');
	});

	it('shows the range on the right and extra content', () => {
		const { container } = render(
			<Toolbar range="1–25 of 312" end={<button type="button">Export</button>}>
				<span>left note</span>
			</Toolbar>,
		);
		expect(container.textContent).toContain('left note');
		expect(container.textContent).toContain('1–25 of 312');
		expect(container.textContent).toContain('Export');
	});

	it('folds the filters into one Filters menu on phones', () => {
		const onToggle = vi.fn();
		const onChange = vi.fn();
		const { container } = render(
			<Toolbar
				filters={[
					{ id: 'paid', label: 'Paid', active: true, onToggle },
					{ id: 'status', label: 'Status', value: '', onChange, options: [{ value: 'on', label: 'On' }] },
				]}
			/>,
		);
		const phone = /** @type {HTMLElement} */ (container.querySelector('button[aria-label="Filters"]'));
		click(phone);
		click(byText(container, 'Paid', '[role="menuitemradio"]'));
		expect(onToggle).toHaveBeenCalled();
		click(phone);
		click(byText(container, 'On', '[role="menuitemradio"]'));
		expect(onChange).toHaveBeenCalledWith('on');
	});

	it('has a fixed height from the layout metrics', () => {
		const { container } = render(<Toolbar range="x" />);
		expect(/** @type {HTMLElement} */ (container.firstElementChild).className).toContain(METRICS.toolbar);
	});
});

describe('Toolbar select mode', () => {
	it('starts select mode from its Select button', () => {
		const onStartSelect = vi.fn();
		const { container } = render(<Toolbar onStartSelect={onStartSelect} />);
		click(byText(container, 'Select', 'button'));
		expect(onStartSelect).toHaveBeenCalled();
	});

	it('turns into the bulk bar: count, actions, select all and Done', () => {
		const onSelectAll = vi.fn();
		const onDone = vi.fn();
		const { container } = render(
			<Toolbar
				search={{ onSearch: () => {} }}
				bulk={{ count: 3, total: 10, actions: <button type="button">Suspend</button>, onSelectAll, onDone }}
			/>,
		);
		expect(container.querySelector('input[type="search"]')).toBeNull();
		expect(container.querySelector('[data-ss-bulk]')).not.toBeNull();
		expect(container.querySelector('[role="status"]')?.textContent).toBe('3 selected');
		expect(container.textContent).toContain('Suspend');
		click(byText(container, 'Select all', 'button'));
		expect(onSelectAll).toHaveBeenCalled();
		click(byText(container, 'Done', 'button'));
		expect(onDone).toHaveBeenCalled();
	});

	it('hides Select all once everything is selected, and says when nothing is', () => {
		const { container, rerender } = render(
			<Toolbar bulk={{ count: 10, total: 10, allSelected: true, onSelectAll: () => {}, onDone: () => {} }} />,
		);
		expect(container.textContent).not.toContain('Select all');
		rerender(
			<Toolbar texts={{ selected: (n) => `${n} chosen`, nothing: 'Pick rows' }} bulk={{ count: 0, onDone: () => {} }} />,
		);
		expect(container.querySelector('[role="status"]')?.textContent).toBe('Pick rows');
		rerender(<Toolbar texts={{ selected: (n) => `${n} chosen` }} bulk={{ count: 2, onDone: () => {} }} />);
		expect(container.querySelector('[role="status"]')?.textContent).toBe('2 chosen');
	});
});

describe('Toolbar loading', () => {
	it('renders a skeleton of the same height', () => {
		const { container } = render(<Toolbar loading />);
		const bar = /** @type {HTMLElement} */ (container.firstElementChild);
		expect(bar.getAttribute('aria-busy')).toBe('true');
		expect(bar.className).toContain(METRICS.toolbar);
	});
});
