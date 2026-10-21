// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@ss/ui/testing';
import { useListPages } from '../../src/console/views/paging.js';

afterEach(cleanup);

/**
 * Harness for testing useListPages hook.
 * @param {{ list: any, size?: number, onState?: (state: any) => void }} props
 */
function PagingHarness({ list, size, onState }) {
	const res = useListPages(list, size);
	onState?.(res);
	return (
		<div>
			<div data-testid="count">{res.count}</div>
			<div data-testid="rows">{res.rows.map((r) => r.id ?? r).join(',')}</div>
			<div data-testid="has-pagination">{res.pagination ? 'yes' : 'no'}</div>
			{res.pagination ? (
				<>
					<button data-testid="prev" disabled={!res.pagination.hasPrevious} onClick={res.pagination.onPrevious}>
						Prev
					</button>
					<button data-testid="next" disabled={!res.pagination.hasNext} onClick={res.pagination.onNext}>
						Next
					</button>
					<div data-testid="range">{res.pagination.range}</div>
				</>
			) : null}
		</div>
	);
}

describe('useListPages (points 154 & 155)', () => {
	it('point 154: when deleting leaves a page empty, goes back to the last page with rows and keeps pagination intact', () => {
		/** @type {any} */
		let latest;
		const initialItems = Array.from({ length: 51 }, (_, i) => ({ id: `item-${i}` }));
		const list = {
			items: initialItems,
			cursor: null,
			loading: false,
			problem: null,
			more: vi.fn(async () => {}),
		};

		const { container, rerender } = render(<PagingHarness list={list} size={50} onState={(s) => (latest = s)} />);

		// Go to page 1 (which holds only item-50)
		act(() => {
			/** @type {HTMLElement} */ (container.querySelector('[data-testid="next"]'))?.click();
		});

		expect(latest.start).toBe(50);
		expect(latest.rows).toHaveLength(1);
		expect(latest.rows[0].id).toBe('item-50');

		// Delete the only item on page 1 (51 -> 50 items)
		const updatedList = {
			...list,
			items: initialItems.slice(0, 50),
		};

		rerender(<PagingHarness list={updatedList} size={50} onState={(s) => (latest = s)} />);

		// Point 154: When deleting leaves a page empty, go back to the last page that has rows.
		// The Previous/Next bar never disappears while other pages exist.
		expect(latest.rows).toHaveLength(50);
		expect(latest.start).toBe(0);
		expect(latest.pagination).not.toBeNull();
		expect(container.querySelector('[data-testid="has-pagination"]')?.textContent).toBe('yes');
	});

	it('point 155: on Next, keep old rows and the bar until new rows arrive (never flash empty)', () => {
		/** @type {any} */
		let latest;
		const page0Items = Array.from({ length: 50 }, (_, i) => ({ id: `item-${i}` }));
		const moreMock = vi.fn(async () => {});
		const list = {
			items: page0Items,
			cursor: 'token-for-page-1',
			loading: false,
			problem: null,
			more: moreMock,
		};

		const { container } = render(<PagingHarness list={list} size={50} onState={(s) => (latest = s)} />);

		expect(latest.rows).toHaveLength(50);
		expect(container.querySelector('[data-testid="has-pagination"]')?.textContent).toBe('yes');

		// User clicks Next while page 1 has not loaded yet
		act(() => {
			/** @type {HTMLElement} */ (container.querySelector('[data-testid="next"]'))?.click();
		});

		// Point 155: Keep old rows and the pagination bar until new rows arrive
		expect(latest.rows).toHaveLength(50);
		expect(latest.rows[0].id).toBe('item-0');
		expect(container.querySelector('[data-testid="has-pagination"]')?.textContent).toBe('yes');
		expect(latest.pagination).not.toBeNull();
	});
});
