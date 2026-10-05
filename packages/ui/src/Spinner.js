import { cx } from './cx.js';

/**
 * Indeterminate spinner (decorative unless `label` is given).
 * @param {{ size?: number, label?: string, className?: string }} props
 */
export function Spinner({ size = 16, label, className }) {
	return (
		<span
			className={cx('inline-flex items-center gap-2', className)}
			{...(label ? { role: 'status' } : { 'aria-hidden': true })}>
			<svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" fill="none" aria-hidden="true">
				<circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
				<path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
			</svg>
			{label ? <span className="text-sm text-muted">{label}</span> : null}
		</span>
	);
}
