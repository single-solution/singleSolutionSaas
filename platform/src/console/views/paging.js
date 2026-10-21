'use client';
/**
 * The pages of a list that the server hands out by cursor (`usePagedList`): the rows of the current page, the count for
 * the toolbar and the props of the footer's `Pagination`. The server's batches are smaller than a page (or not as many
 * as it): whenever the current page is not full and there is more on the server, the next batch is loaded.
 * @module
 */
import { useEffect, useRef, useState } from 'react';
import { MORE } from '../../texts/console.js';

/** Rows per page of the tables fed by the server. */
export const PAGE_SIZE = 50;

/**
 * @param {{ items: any[], cursor: string | null, loading: boolean, problem: unknown, more: () => Promise<unknown> }} list what `usePagedList` returns
 * @param {number} [size] rows per page
 */
export function useListPages(list, size = PAGE_SIZE) {
	const [pageNo, setPageNo] = useState(0);
	const { loading, problem, cursor, more, items } = list;
	const have = items.length;
	const hasMore = cursor !== null;

	// Point 154: When deleting leaves a page empty, go back to the last page that has rows
	const maxPage = Math.max(0, Math.ceil(have / size) - 1);
	const targetPage = !hasMore && pageNo > maxPage ? maxPage : pageNo;

	useEffect(() => {
		if (targetPage !== pageNo) setPageNo(targetPage);
	}, [targetPage, pageNo]);

	const effectivePage = targetPage;
	const start = effectivePage * size;
	const slice = items.slice(start, start + size);

	// Point 155: On Next, keep old rows and the bar until new rows arrive
	const prevRowsRef = useRef(/** @type {any[]} */ ([]));
	if (slice.length > 0) {
		prevRowsRef.current = slice;
	}
	const waiting = slice.length === 0 && effectivePage > 0 && (hasMore || loading);
	const rows = waiting && prevRowsRef.current.length > 0 ? prevRowsRef.current : slice;

	useEffect(() => {
		if (loading || problem || cursor === null || have >= start + size) return;
		void more();
		// `more` is new on every render; the batch to fetch is decided by these values
	}, [loading, problem, cursor, have, start, size]);

	const showPagination = have > 0 || hasMore;

	return {
		rows,
		start,
		waiting,
		/** "37", or "50+" while there is more on the server */
		count: MORE.count(have, hasMore),
		/** back to the first page (after a reload) */
		reset: () => setPageNo(0),
		/** the props of `Pagination`; none while there is nothing to page through */
		pagination:
			!showPagination || (rows.length === 0 && !hasMore)
				? null
				: {
						range: waiting
							? MORE.showing(start + 1, start + size, hasMore)
							: MORE.showing(start + 1, start + slice.length, hasMore),
						hasPrevious: effectivePage > 0,
						hasNext: start + size < have || hasMore,
						onPrevious: () => setPageNo((n) => Math.max(0, n - 1)),
						onNext: () => setPageNo((n) => n + 1),
					},
	};
}
