'use client';
/**
 * Search and paging for a long list (owner 2026-10-16: no long scroll): {@link Paged} shows a search box once the list
 * is longer than a few items and one page of the matches at a time, with Previous and Next. The list itself is drawn
 * by the caller, so rows, cards and tables all get the same controls.
 * @module
 */
import { useEffect, useState } from 'react';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { Input } from './fields.js';

/** @typedef {import('react').ReactNode} ReactNode */

/** The words of {@link Paged}; a caller may pass its own (partial). */
export const PAGED_TEXTS = Object.freeze({
	search: 'Search',
	none: 'Nothing matches.',
	previous: 'Previous',
	next: 'Next',
	range: 'Showing {from}–{to} of {total}',
	pages: 'Pages',
});

/**
 * Fill `{name}` placeholders.
 * @param {string} text
 * @param {Record<string, string | number>} values
 */
export const fillRange = (text, values) =>
	text.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(values, name) ? String(values[name]) : match));

/**
 * The logic of {@link Paged} for any list: the search text narrows `items` (by `text(item)`), `rows` is the current
 * page of the matches, and `pagination` holds the props of the footer's {@link Pagination}. The page goes back to the
 * first one when the search changes and is held at the last one when the list gets shorter.
 * @template T
 * @param {T[]} items
 * @param {{ text: (item: T) => string, pageSize?: number }} options what a search matches, and the rows per page (10)
 */
export function usePaged(items, { text, pageSize = 10 }) {
	const [query, setQuery] = useState('');
	const [page, setPage] = useState(0);
	const needle = query.trim().toLowerCase();
	const found = needle ? items.filter((item) => text(item).toLowerCase().includes(needle)) : items;
	const pages = Math.max(1, Math.ceil(found.length / pageSize));
	const at = Math.min(page, pages - 1);
	useEffect(() => setPage(0), [needle]);
	const start = at * pageSize;
	return {
		query,
		setQuery,
		found,
		rows: found.slice(start, start + pageSize),
		page: at,
		setPage,
		pages,
		pageSize,
		total: found.length,
		/** the number of the first and the last row shown (0 when nothing matches) */
		from: found.length === 0 ? 0 : start + 1,
		to: Math.min(found.length, start + pageSize),
		/** the props of {@link Pagination} */
		pagination: { page: at, pageSize, total: found.length, onPage: setPage },
	};
}

/**
 * A list with search and pages: `items` are narrowed by `text(item)` (what a search matches: its name and the words
 * around it) and `children(page)` draws the items of the current page. The search box shows from `searchFrom`
 * items (8) and the pager when the matches need more than one page of `pageSize` (10).
 * @template T
 * @param {{ items: T[], text: (item: T) => string, children: (page: T[]) => ReactNode, pageSize?: number,
 *   searchFrom?: number, texts?: Partial<Record<keyof typeof PAGED_TEXTS, string>>, label?: string, className?: string }} props
 */
export function Paged({ items, text, children, pageSize = 10, searchFrom = 8, texts = {}, label, className }) {
	const words = { ...PAGED_TEXTS, ...texts };
	const paged = usePaged(items, { text, pageSize });
	const { page: at, pages, found } = paged;
	return (
		<div className={cx('min-w-0 space-y-3', className)}>
			{items.length >= searchFrom ? (
				<Input
					type="search"
					hideLabel
					label={label ?? words.search}
					placeholder={label ?? words.search}
					value={paged.query}
					onChange={(event) => paged.setQuery(event.target.value)}
					fieldClassName="max-w-sm"
				/>
			) : null}
			{found.length === 0 ? <p className="text-sm text-muted">{words.none}</p> : children(paged.rows)}
			{pages > 1 ? (
				<nav aria-label={words.pages} className="flex flex-wrap items-center gap-3">
					<p role="status" className="text-xs text-muted tabular-nums">
						{fillRange(words.range, { from: paged.from, to: paged.to, total: found.length })}
					</p>
					<div className="ml-auto flex items-center gap-2">
						<Button size="sm" variant="secondary" disabled={at === 0} onClick={() => paged.setPage(at - 1)}>
							{words.previous}
						</Button>
						<Button size="sm" variant="secondary" disabled={at >= pages - 1} onClick={() => paged.setPage(at + 1)}>
							{words.next}
						</Button>
					</div>
				</nav>
			) : null}
		</div>
	);
}
