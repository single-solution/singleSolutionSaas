// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ListColumn } from '../src/ListColumn.js';
import { useListSelection } from '../src/list-selection.js';
import { STAGGER } from '../src/layout-metrics.js';
import { act, allByRole, byText, cleanup, click, keydown, render, type } from '../src/testing.js';

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const merchants = [
	{ id: 'acme', name: 'Acme Shop', sites: 3 },
	{ id: 'bolt', name: 'Bolt Studio', sites: 1 },
	{ id: 'cedar', name: 'Cedar Cafe', sites: 2 },
];

/** @param {typeof merchants[number]} m */
const rowOf = (m) => ({ lead: { avatar: m.name }, title: m.name, meta: `${m.sites} websites` });

/** @param {Record<string, any>} [props] what to change in the default column */
const column = (props = {}) => <ListColumn label="Merchants" items={merchants} idOf={(m) => m.id} rowOf={rowOf} {...props} />;

/** @param {HTMLElement} root */
const options = (root) => allByRole(root, 'option');

/** The pointer moves onto, or off, an element. @param {Element} el @param {boolean} over */
const point = (el, over) =>
	act(() => {
		el.dispatchEvent(new MouseEvent(over ? 'pointerover' : 'pointerout', { bubbles: true }));
	});

describe('ListColumn rows', () => {
	it('is a listbox of options, the picked one aria-selected and the one stop of the Tab key', () => {
		const { container } = render(column({ selected: 'bolt' }));
		const box = /** @type {HTMLElement} */ (container.querySelector('[role="listbox"]'));
		expect(box.getAttribute('aria-label')).toBe('Merchants');
		const rows = options(container);
		expect(rows.map((row) => row.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
		expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
		expect(rows[0]?.textContent).toContain('Acme Shop');
		expect(rows[0]?.textContent).toContain('3 websites');
	});

	it('makes the first row the Tab stop while nothing is picked', () => {
		const { container } = render(column());
		expect(options(container).map((row) => row.tabIndex)).toEqual([0, -1, -1]);
	});

	it('draws one highlight and moves it to the picked row', () => {
		const { container, rerender } = render(column({ selected: 'acme' }));
		const bar = /** @type {HTMLElement} */ (container.querySelector('[data-ss-indicator]'));
		expect(container.querySelectorAll('[data-ss-indicator]')).toHaveLength(1);
		expect(bar.style.opacity).toBe('1');
		expect(bar.style.transform).toContain('translateY');
		rerender(column({ selected: 'cedar' }));
		expect(container.querySelectorAll('[data-ss-indicator]')).toHaveLength(1);
		expect(bar.className).toContain('transition-[transform');
		expect(bar.className).toContain('duration-(--ss-motion)');
		rerender(column({ selected: 'nobody' }));
		expect(bar.style.opacity).toBe('0');
	});

	it('staggers the first rows in and then lets them stand', () => {
		vi.useFakeTimers();
		const { container } = render(column());
		const first = options(container)[0];
		expect(first?.className).toContain('ss-stagger');
		expect(first?.style.getPropertyValue('--ss-i')).toBe('0');
		act(() => {
			vi.advanceTimersByTime(STAGGER.rows * STAGGER.step + 500);
		});
		expect(options(container)[0]?.className).not.toContain('ss-stagger');
	});

	it('selects with a click, and with Enter or Space on the focused row', () => {
		const onSelect = vi.fn();
		const { container } = render(column({ onSelect }));
		const rows = options(container);
		click(/** @type {HTMLElement} */ (rows[1]));
		expect(onSelect).toHaveBeenLastCalledWith('bolt');
		keydown(/** @type {HTMLElement} */ (rows[2]), 'Enter');
		expect(onSelect).toHaveBeenLastCalledWith('cedar');
		keydown(/** @type {HTMLElement} */ (rows[0]), ' ');
		expect(onSelect).toHaveBeenLastCalledWith('acme');
		expect(onSelect).toHaveBeenCalledTimes(3);
	});

	it('moves the focus with the arrow keys, Home and End, and does not wrap', () => {
		const { container } = render(column());
		const rows = options(container);
		act(() => rows[0]?.focus());
		keydown(/** @type {HTMLElement} */ (rows[0]), 'ArrowDown');
		expect(document.activeElement).toBe(rows[1]);
		keydown(/** @type {HTMLElement} */ (rows[1]), 'ArrowDown');
		keydown(/** @type {HTMLElement} */ (rows[2]), 'ArrowDown');
		expect(document.activeElement).toBe(rows[2]);
		keydown(/** @type {HTMLElement} */ (rows[2]), 'ArrowUp');
		expect(document.activeElement).toBe(rows[1]);
		keydown(/** @type {HTMLElement} */ (rows[1]), 'Home');
		expect(document.activeElement).toBe(rows[0]);
		keydown(/** @type {HTMLElement} */ (rows[0]), 'End');
		expect(document.activeElement).toBe(rows[2]);
	});

	it('does not select a row when a key is pressed inside its trailing control', () => {
		const onSelect = vi.fn();
		const { container } = render(
			column({
				onSelect,
				rowOf: (/** @type {typeof merchants[number]} */ m) => ({
					title: m.name,
					trailing: <button type="button">Switch {m.id}</button>,
				}),
			}),
		);
		const control = /** @type {HTMLElement} */ (container.querySelector('[role="option"] button'));
		click(control);
		keydown(control, 'Enter');
		keydown(control, 'ArrowDown');
		expect(onSelect).not.toHaveBeenCalled();
	});
});

describe('ListColumn search and filters', () => {
	it('calls onChange with what is typed', () => {
		const onChange = vi.fn();
		const { container } = render(column({ search: { value: '', onChange, placeholder: 'Find a merchant' } }));
		const box = /** @type {HTMLInputElement} */ (container.querySelector('input[type="search"]'));
		expect(box.placeholder).toBe('Find a merchant');
		type(box, 'bol');
		expect(onChange).toHaveBeenCalledWith('bol');
	});

	it('focuses the search box on / unless a field has the focus', () => {
		const { container } = render(
			<>
				{column({ search: { value: '', onChange: () => {} } })}
				<input aria-label="Other" />
			</>,
		);
		const box = /** @type {HTMLInputElement} */ (container.querySelector('input[type="search"]'));
		const other = /** @type {HTMLInputElement} */ (container.querySelector('input[aria-label="Other"]'));
		act(() => other.focus());
		keydown(other, '/');
		expect(document.activeElement).toBe(other);
		act(() => other.blur());
		keydown(document, '/');
		expect(document.activeElement).toBe(box);
	});

	it('draws the filters as chips with counts and calls onChange with the id', () => {
		const onChange = vi.fn();
		const filters = {
			value: 'all',
			onChange,
			options: [
				{ id: 'all', label: 'All', count: 12 },
				{ id: 'late', label: 'Late', count: 2 },
			],
		};
		const { container } = render(column({ filters }));
		const chips = /** @type {HTMLElement[]} */ ([...container.querySelectorAll('[role="group"] button')]);
		expect(chips.map((chip) => chip.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
		expect(chips[1]?.textContent).toBe('Late2');
		click(/** @type {HTMLElement} */ (chips[1]));
		expect(onChange).toHaveBeenCalledWith('late');
	});

	it('works as a controlled search that filters the rows', () => {
		/** The caller keeps the text and the rows. */
		const Filtered = () => {
			const [query, setQuery] = useState('');
			const shown = merchants.filter((m) => m.name.toLowerCase().includes(query));
			return column({ items: shown, search: { value: query, onChange: setQuery } });
		};
		const { container } = render(<Filtered />);
		type(/** @type {HTMLElement} */ (container.querySelector('input[type="search"]')), 'bolt');
		expect(options(container)).toHaveLength(1);
		expect(options(container)[0]?.textContent).toContain('Bolt Studio');
	});
});

describe('ListColumn states', () => {
	it('draws skeleton rows in the size of the rows while loading', () => {
		const { container } = render(column({ loading: true }));
		expect(options(container)).toHaveLength(0);
		const status = /** @type {HTMLElement} */ (container.querySelector('[role="status"][aria-busy="true"]'));
		expect(status.children).toHaveLength(8);
		expect(/** @type {HTMLElement} */ (status.children[0]).className).toContain('h-14');
	});

	it('says what the list is for when it is empty', () => {
		const { container } = render(
			column({ items: [], empty: { title: 'No merchants yet', description: 'Add the first one.', icon: 'user' } }),
		);
		expect(options(container)).toHaveLength(0);
		expect(byText(container, 'No merchants yet')).not.toBeNull();
		expect(byText(container, 'Add the first one.')).not.toBeNull();
	});

	it('point 93: shows "No match for xyz" with Clear search/filter instead of normal empty state when filtered', () => {
		const onSearchChange = vi.fn();
		const onFilterChange = vi.fn();
		const empty = { title: 'No merchants yet', description: 'Add the first one.' };

		const { container, rerender } = render(
			column({
				items: [],
				empty,
				search: { value: 'xyz', onChange: onSearchChange },
			}),
		);
		expect(container.textContent).toContain('No match for "xyz"');
		expect(container.textContent).not.toContain('No merchants yet');
		const clearSearchBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Clear search');
		expect(clearSearchBtn).not.toBeUndefined();
		clearSearchBtn?.click();
		expect(onSearchChange).toHaveBeenCalledWith('');

		rerender(
			column({
				items: [],
				empty,
				filters: {
					value: 'active',
					onChange: onFilterChange,
					options: [
						{ id: 'all', label: 'All' },
						{ id: 'active', label: 'Active' },
					],
				},
			}),
		);
		expect(container.textContent).toContain('No match for filter');
		expect(container.textContent).not.toContain('No merchants yet');
		const clearFilterBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Clear filter');
		expect(clearFilterBtn).not.toBeUndefined();
		clearFilterBtn?.click();
		expect(onFilterChange).toHaveBeenCalledWith('all');

		rerender(
			column({
				items: [],
				empty,
			}),
		);
		expect(container.textContent).toContain('No merchants yet');
		expect(container.textContent).not.toContain('No match');
	});
});

describe('ListColumn loading more', () => {
	/** A fake observer that the test can fire. */
	const watch = () => {
		/** @type {Array<{ callback: (entries: Array<{ isIntersecting: boolean }>) => void, target: Element | null, options: unknown, gone: boolean }>} */
		const observers = [];
		/** @param {(entries: Array<{ isIntersecting: boolean }>) => void} callback @param {unknown} options */
		const Observer = function (callback, options) {
			const entry = { callback, target: /** @type {Element | null} */ (null), options, gone: false };
			observers.push(entry);
			return {
				/** @param {Element} target */
				observe: (target) => {
					entry.target = target;
				},
				disconnect: () => {
					entry.gone = true;
				},
			};
		};
		vi.stubGlobal('IntersectionObserver', Observer);
		return observers;
	};

	/** @param {{ callback: (entries: Array<{ isIntersecting: boolean }>) => void }} observer @param {boolean} isIntersecting */
	const show = (observer, isIntersecting) => act(() => observer.callback([{ isIntersecting }]));

	it('calls onMore once for each time the end comes into view, with a spinner row at the end', () => {
		const observers = watch();
		const onMore = vi.fn();
		const { container } = render(column({ hasMore: true, onMore }));
		const sentinel = /** @type {HTMLElement} */ (container.querySelector('[aria-label="Loading more"]'));
		expect(sentinel.querySelector('svg')).not.toBeNull();
		const observer = /** @type {NonNullable<typeof observers[number]>} */ (observers[0]);
		expect(observer.target).toBe(sentinel);
		show(observer, true);
		show(observer, true);
		expect(onMore).toHaveBeenCalledTimes(1);
		show(observer, false);
		show(observer, true);
		expect(onMore).toHaveBeenCalledTimes(2);
	});

	it('watches again after more rows came in, and stops when there is no more', () => {
		const observers = watch();
		const onMore = vi.fn();
		const { container, rerender } = render(column({ hasMore: true, onMore }));
		show(/** @type {NonNullable<typeof observers[number]>} */ (observers[0]), true);
		expect(onMore).toHaveBeenCalledTimes(1);
		rerender(column({ hasMore: true, onMore, items: [...merchants, { id: 'dune', name: 'Dune', sites: 0 }] }));
		expect(observers[0]?.gone).toBe(true);
		expect(observers).toHaveLength(2);
		rerender(column({ hasMore: false, onMore }));
		expect(container.querySelector('[aria-label="Loading more"]')).toBeNull();
		expect(observers[1]?.gone).toBe(true);
	});
});

describe('ListColumn prefetch', () => {
	it('calls onPrefetch after the pointer rests 150 ms on a row, and not when it leaves sooner', () => {
		vi.useFakeTimers();
		const onPrefetch = vi.fn();
		const { container } = render(column({ onPrefetch }));
		const row = /** @type {HTMLElement} */ (options(container)[1]);
		point(row, true);
		act(() => {
			vi.advanceTimersByTime(149);
		});
		expect(onPrefetch).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(onPrefetch).toHaveBeenCalledWith(merchants[1]);
		onPrefetch.mockClear();
		point(row, false);
		point(/** @type {HTMLElement} */ (options(container)[2]), true);
		act(() => {
			vi.advanceTimersByTime(100);
		});
		point(/** @type {HTMLElement} */ (options(container)[2]), false);
		act(() => {
			vi.advanceTimersByTime(500);
		});
		expect(onPrefetch).not.toHaveBeenCalled();
	});

	it('calls onPrefetch at once when a row gets the focus', () => {
		const onPrefetch = vi.fn();
		const { container } = render(column({ onPrefetch }));
		act(() => options(container)[2]?.focus());
		expect(onPrefetch).toHaveBeenCalledWith(merchants[2]);
	});
});

/**
 * A page that shows the picked id and a button per id.
 * @param {{ ids: Array<string | number>, param?: string, initial?: string | number | null }} props
 */
function Probe({ ids, param, initial }) {
	const [selected, select] = useListSelection({
		ids,
		...(param ? { param } : {}),
		...(initial !== undefined ? { initial } : {}),
	});
	return (
		<div>
			<output data-testid="selected">{String(selected)}</output>
			{ids.map((id) => (
				<button key={id} type="button" onClick={() => select(id)}>
					{`pick ${id}`}
				</button>
			))}
			<button type="button" onClick={() => select(null)}>
				clear
			</button>
		</div>
	);
}

/** @param {HTMLElement} root */
const shown = (root) => root.querySelector('output')?.textContent;

/** @param {HTMLElement} root @param {string} text */
const button = (root, text) =>
	/** @type {HTMLElement} */ ([...root.querySelectorAll('button')].find((el) => el.textContent === text));

/** Back or Forward: the browser has already changed the address and says so. @param {string} url */
const travel = (url) =>
	act(() => {
		window.history.replaceState(null, '', url);
		window.dispatchEvent(new PopStateEvent('popstate'));
	});

describe('useListSelection', () => {
	beforeEach(() => {
		window.history.replaceState(null, '', '/merchants');
	});

	it('reads ?id= from the address', () => {
		window.history.replaceState(null, '', '/merchants?id=bolt');
		const { container } = render(<Probe ids={['acme', 'bolt', 'cedar']} />);
		expect(shown(container)).toBe('bolt');
	});

	it('picks the first id when the address has none, or the initial one', () => {
		const { container, rerender } = render(<Probe ids={['acme', 'bolt']} />);
		expect(shown(container)).toBe('acme');
		rerender(<Probe ids={['acme', 'bolt']} initial="bolt" />);
		expect(shown(container)).toBe('bolt');
		rerender(<Probe ids={['acme', 'bolt']} initial="nobody" />);
		expect(shown(container)).toBe('acme');
		rerender(<Probe ids={['acme', 'bolt']} initial={null} />);
		expect(shown(container)).toBe('null');
	});

	it('point 295: keeps the id in the address even if not in the list (never silently picks the first id)', () => {
		window.history.replaceState(null, '', '/merchants?id=gone');
		const { container, rerender } = render(<Probe ids={[]} />);
		expect(shown(container)).toBe('gone');
		rerender(<Probe ids={['acme', 'bolt']} />);
		expect(shown(container)).toBe('gone');
	});

	it('pushes a history entry on select and keeps the rest of the address', () => {
		window.history.replaceState(null, '', '/merchants?tab=late&id=acme#top');
		const push = vi.spyOn(window.history, 'pushState');
		const { container } = render(<Probe ids={['acme', 'bolt']} />);
		click(button(container, 'pick bolt'));
		expect(push).toHaveBeenCalledTimes(1);
		expect(window.location.pathname).toBe('/merchants');
		const params = new URLSearchParams(window.location.search);
		expect(params.get('id')).toBe('bolt');
		expect(params.get('tab')).toBe('late');
		expect(window.location.hash).toBe('#top');
		expect(shown(container)).toBe('bolt');
		click(button(container, 'pick bolt'));
		expect(push).toHaveBeenCalledTimes(1);
		push.mockRestore();
	});

	it('follows Back and Forward (popstate)', () => {
		const { container } = render(<Probe ids={['acme', 'bolt', 'cedar']} />);
		click(button(container, 'pick cedar'));
		expect(shown(container)).toBe('cedar');
		travel('/merchants?id=bolt');
		expect(shown(container)).toBe('bolt');
		travel('/merchants');
		expect(shown(container)).toBe('acme');
	});

	it('uses another parameter name when asked', () => {
		window.history.replaceState(null, '', '/m?id=acme&site=two');
		const { container } = render(<Probe ids={['one', 'two']} param="site" />);
		expect(shown(container)).toBe('two');
		click(button(container, 'pick one'));
		expect(new URLSearchParams(window.location.search).get('site')).toBe('one');
		expect(new URLSearchParams(window.location.search).get('id')).toBe('acme');
	});

	it('puts the pick away with select(null) (a phone shows the list again) and comes back with Back', () => {
		window.history.replaceState(null, '', '/merchants?id=bolt');
		const { container } = render(<Probe ids={['acme', 'bolt']} />);
		click(button(container, 'clear'));
		expect(shown(container)).toBe('null');
		expect(window.location.search).toBe('');
		travel('/merchants?id=bolt');
		expect(shown(container)).toBe('bolt');
	});
});
