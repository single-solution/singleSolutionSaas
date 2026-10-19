'use client';
/**
 * The pages of a list that the server hands out by cursor (`usePagedList`): the rows of the current page, the count for
 * the toolbar and the props of the footer's `Pagination`. Going on loads the next batch when the page needs it.
 * @module
 */
import { useState } from 'react';
import { MORE } from '../../texts/console.js';

/** Rows per page of the tables fed by the server. */
export const PAGE_SIZE = 50;

/**
 * @param {{ items: any[], cursor: string | null, more: () => Promise<unknown> }} list what `usePagedList` returns
 * @param {number} [size] rows per page
 */
export function useListPages(list, size = PAGE_SIZE) {
	const [pageNo, setPageNo] = useState(0);
	const start = pageNo * size;
	const rows = list.items.slice(start, start + size);
	const hasMore = list.cursor !== null;
	return {
		rows,
		start,
		/** "37", or "50+" while there is more on the server */
		count: MORE.count(list.items.length, hasMore),
		/** back to the first page (after a reload) */
		reset: () => setPageNo(0),
		/** the props of `Pagination`; none while there is nothing to page through */
		pagination:
			rows.length === 0
				? null
				: {
						range: MORE.showing(start + 1, start + rows.length, hasMore),
						hasPrevious: pageNo > 0,
						hasNext: start + size < list.items.length || hasMore,
						onPrevious: () => setPageNo((n) => Math.max(0, n - 1)),
						onNext: async () => {
							if (start + size >= list.items.length) await list.more();
							setPageNo((n) => n + 1);
						},
					},
	};
}
