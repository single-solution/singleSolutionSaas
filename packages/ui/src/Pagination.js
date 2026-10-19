'use client';
/**
 * The footer pagination (layout contract 2026-10-17, item 6): the range ("Showing 1–25 of 312") on the left,
 * Previous and Next on the right, in the fixed footer of a {@link Page}. It uses the words and the range text of
 * {@link Paged}; for a list that is all loaded, `usePaged(...).pagination` holds its props. A list from a server with
 * a cursor (no known total) gives `range`, `hasPrevious`, `hasNext` and the two handlers instead.
 * @module
 */
import { Button } from './Button.js';
import { cx } from './cx.js';
import { SkeletonBlock } from './display.js';
import { fillRange, PAGED_TEXTS } from './paged.js';

/**
 * @param {{ page?: number, pageSize?: number, total?: number, onPage?: (page: number) => void,
 *   range?: import('react').ReactNode, hasPrevious?: boolean, hasNext?: boolean, onPrevious?: () => void,
 *   onNext?: () => void, texts?: Partial<Record<keyof typeof PAGED_TEXTS, string>>, className?: string }} props
 *   `page` is the number of the page from 0; with `total` and `onPage` the range and the buttons follow; with
 *   `range`, `hasPrevious`, `hasNext`, `onPrevious` and `onNext` the page keeps the cursor itself
 */
export function Pagination({
	page = 0,
	pageSize = 25,
	total,
	onPage,
	range,
	hasPrevious,
	hasNext,
	onPrevious,
	onNext,
	texts,
	className,
}) {
	const words = { ...PAGED_TEXTS, ...texts };
	if (total === 0) return null;
	const counted = total !== undefined;
	const shown = counted
		? fillRange(words.range, { from: page * pageSize + 1, to: Math.min(total, (page + 1) * pageSize), total })
		: range;
	const canPrevious = counted ? page > 0 : Boolean(hasPrevious);
	const canNext = counted ? (page + 1) * pageSize < total : Boolean(hasNext);
	return (
		<nav aria-label={words.pages} className={cx('flex min-w-0 flex-1 items-center gap-3', className)}>
			<p role="status" className="min-w-0 truncate text-label text-muted tabular-nums">
				{shown}
			</p>
			<div className="ml-auto flex shrink-0 items-center gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={!canPrevious}
					onClick={() => (counted ? onPage?.(page - 1) : onPrevious?.())}>
					{words.previous}
				</Button>
				<Button size="sm" variant="secondary" disabled={!canNext} onClick={() => (counted ? onPage?.(page + 1) : onNext?.())}>
					{words.next}
				</Button>
			</div>
		</nav>
	);
}

/**
 * The footer pagination while it loads: the count line and the two buttons.
 * @param {{ label?: string, className?: string }} props
 */
export function PaginationSkeleton({ label = 'Loading', className }) {
	return (
		<div role="status" aria-label={label} aria-busy="true" className={cx('flex min-w-0 flex-1 items-center gap-3', className)}>
			<SkeletonBlock className="h-3 w-36" />
			<div className="ml-auto flex shrink-0 items-center gap-2">
				<SkeletonBlock className="h-8 w-20" />
				<SkeletonBlock className="h-8 w-16" />
			</div>
		</div>
	);
}
