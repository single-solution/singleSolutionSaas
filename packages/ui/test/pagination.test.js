// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pagination, PaginationSkeleton } from '../src/Pagination.js';
import { usePaged, fillRange, PAGED_TEXTS } from '../src/paged.js';
import { byText, cleanup, click, render, type } from '../src/testing.js';

afterEach(cleanup);

describe('Pagination (the page footer)', () => {
	it('says which rows are shown and moves between pages', () => {
		const onPage = vi.fn();
		const { container, rerender } = render(<Pagination page={0} pageSize={25} total={312} onPage={onPage} />);
		expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('Pages');
		expect(container.querySelector('[role="status"]')?.textContent).toBe('Showing 1–25 of 312');
		expect(byText(container, 'Previous', 'button').hasAttribute('disabled')).toBe(true);
		click(byText(container, 'Next', 'button'));
		expect(onPage).toHaveBeenCalledWith(1);
		rerender(<Pagination page={12} pageSize={25} total={312} onPage={onPage} />);
		expect(container.querySelector('[role="status"]')?.textContent).toBe('Showing 301–312 of 312');
		expect(byText(container, 'Next', 'button').hasAttribute('disabled')).toBe(true);
		click(byText(container, 'Previous', 'button'));
		expect(onPage).toHaveBeenLastCalledWith(11);
	});

	it('shows one page too (the count is always there) and nothing for no rows', () => {
		const { container, rerender } = render(<Pagination page={0} pageSize={25} total={3} onPage={() => {}} />);
		expect(container.textContent).toContain('Showing 1–3 of 3');
		expect(byText(container, 'Next', 'button').hasAttribute('disabled')).toBe(true);
		rerender(<Pagination page={0} pageSize={25} total={0} onPage={() => {}} />);
		expect(container.querySelector('nav')).toBeNull();
	});

	it('works with a cursor: the page knows only whether there is a next page', () => {
		const onNext = vi.fn();
		const onPrevious = vi.fn();
		const { container } = render(<Pagination range="26–50" hasPrevious hasNext onNext={onNext} onPrevious={onPrevious} />);
		expect(container.querySelector('[role="status"]')?.textContent).toBe('26–50');
		click(byText(container, 'Next', 'button'));
		click(byText(container, 'Previous', 'button'));
		expect(onNext).toHaveBeenCalledTimes(1);
		expect(onPrevious).toHaveBeenCalledTimes(1);
	});

	it('takes its words from the caller', () => {
		const { container } = render(
			<Pagination
				page={0}
				pageSize={2}
				total={5}
				onPage={() => {}}
				texts={{ range: '{from} bis {to} von {total}', next: 'Weiter', previous: 'Zurück', pages: 'Seiten' }}
			/>,
		);
		expect(container.textContent).toContain('1 bis 2 von 5');
		expect(byText(container, 'Weiter', 'button')).toBeTruthy();
		expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('Seiten');
	});

	it('has a skeleton with the same two buttons and the count line', () => {
		const { container } = render(<PaginationSkeleton label="Loading pages" />);
		expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading pages');
		expect(container.querySelectorAll('.ss-shimmer')).toHaveLength(3);
	});
});

describe('fillRange and usePaged (the logic of Paged, for any list)', () => {
	it('fills {name} placeholders and leaves unknown ones alone', () => {
		expect(fillRange('{a} of {b} {c}', { a: 1, b: 2 })).toBe('1 of 2 {c}');
		expect(PAGED_TEXTS.range).toContain('{total}');
	});

	/** @param {{ onState?: (state: ReturnType<typeof usePaged<string>>) => void }} props */
	function List({ onState }) {
		const items = Array.from({ length: 23 }, (_, i) => `item ${i + 1}`);
		const paged = usePaged(items, { text: (item) => item, pageSize: 10 });
		onState?.(paged);
		return (
			<div>
				<input aria-label="q" value={paged.query} onChange={(event) => paged.setQuery(event.target.value)} />
				<p id="shown">{paged.rows.join(',')}</p>
				<button type="button" onClick={() => paged.setPage(paged.page + 1)}>
					more
				</button>
			</div>
		);
	}

	it('slices a page, searches the whole list and goes back to the first page when the search changes', () => {
		/** @type {ReturnType<typeof usePaged<string>> | undefined} */
		let state;
		const { container } = render(<List onState={(s) => (state = s)} />);
		expect(state?.total).toBe(23);
		expect(state?.pages).toBe(3);
		expect(state?.from).toBe(1);
		expect(state?.to).toBe(10);
		click(byText(container, 'more', 'button'));
		click(byText(container, 'more', 'button'));
		expect(state?.page).toBe(2);
		expect(state?.rows).toEqual(['item 21', 'item 22', 'item 23']);
		expect(state?.to).toBe(23);
		// a page past the end is held at the last page
		click(byText(container, 'more', 'button'));
		expect(state?.page).toBe(2);
		type(/** @type {HTMLElement} */ (container.querySelector('input')), 'item 1');
		expect(state?.page).toBe(0);
		expect(state?.total).toBe(11);
		expect(state?.pagination.page).toBe(0);
		expect(state?.pagination.total).toBe(11);
		type(/** @type {HTMLElement} */ (container.querySelector('input')), 'zzz');
		expect(state?.rows).toEqual([]);
		expect(state?.from).toBe(0);
	});
});
