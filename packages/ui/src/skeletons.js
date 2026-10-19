/**
 * Loading placeholders of the layout system (layout contract 2026-10-17, item 11): every component renders its own
 * skeleton, with the sizes of `layout-metrics.js` that the real component uses too, so nothing jumps when the data
 * arrives. A skeleton is one `role="status"` region (`aria-busy`), the blocks inside are decoration.
 * @module
 */
import { cx } from './cx.js';
import { SkeletonBlock } from './display.js';
import { METRICS, NAV_PANEL } from './layout-metrics.js';

/** Widths of the placeholder lines, repeated so a list does not look like a ruler. */
const WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6', 'w-2/5'];

/**
 * The inner navigation while it loads: the same panel (desktop) and the same dropdown button (phones).
 * @param {{ items?: number, label?: string, className?: string }} props
 */
export function InnerNavSkeleton({ items = 6, label = 'Loading', className }) {
	return (
		<>
			<div role="status" aria-label={label} aria-busy="true" className={cx('shrink-0 animate-ss-fade lg:hidden', className)}>
				<SkeletonBlock className="h-10 w-full" />
			</div>
			<div aria-hidden="true" className={cx(NAV_PANEL, 'animate-ss-fade', className)}>
				<div className="min-h-0 flex-1 space-y-1 p-2">
					{Array.from({ length: items }, (_, i) => (
						<div key={i} className={cx('flex items-center gap-2 px-2', METRICS.navItem)}>
							<SkeletonBlock className="size-4 shrink-0" />
							<SkeletonBlock className={cx('h-3', WIDTHS[i % WIDTHS.length])} />
						</div>
					))}
				</div>
			</div>
		</>
	);
}
