/**
 * Dependency-free SVG charts. Each chart is an `img` with an accessible summary and a visually hidden data table
 * (screen readers get the numbers, not the drawing).
 * @module
 */
import { cx } from './cx.js';
import { Icon } from './icons.js';

/** @typedef {{ label: string, value: number, hint?: string }} Datum */

/**
 * Whether a series has nothing to draw: no points, or every value zero.
 * @param {readonly Datum[]} data
 */
export const isEmptySeries = (data) => data.every((d) => !(d.value > 0));

/**
 * Vertical bar chart. A series with nothing to draw (no points, or all zero) is a compact line of text instead.
 * @param {{ data: Datum[], label: string, format?: (value: number) => string, height?: number, className?: string,
 *   emptyText?: string }} props
 */
export function BarChart({ data, label, format = String, height = 160, className, emptyText = 'No data for this period.' }) {
	if (isEmptySeries(data))
		return (
			<p className={cx('flex items-center gap-2 text-sm text-muted', className)}>
				<Icon name="trendingUp" size={14} />
				{emptyText}
			</p>
		);
	const max = Math.max(...data.map((d) => d.value), 0);
	const width = Math.max(data.length * 28, 280);
	const barWidth = Math.max(6, Math.min(32, width / data.length - 6));
	const step = width / data.length;
	const plot = height - 24;
	return (
		<figure className={cx('space-y-2', className)}>
			<svg
				role="img"
				aria-label={`${label}: ${data.length} values, highest ${format(max)}`}
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="none"
				className="h-40 w-full text-primary">
				<line x1="0" y1={plot} x2={width} y2={plot} stroke="var(--ss-line-soft)" strokeWidth="1" />
				{data.map((d, i) => {
					const h = max > 0 ? Math.max(d.value > 0 ? 2 : 0, (d.value / max) * (plot - 8)) : 0;
					return (
						<g key={`${d.label}-${i}`}>
							<rect
								x={i * step + (step - barWidth) / 2}
								y={plot - h}
								width={barWidth}
								height={h}
								rx="4"
								fill="currentColor">
								<title>{`${d.label}: ${format(d.value)}`}</title>
							</rect>
							{data.length <= 12 ? (
								<text x={i * step + step / 2} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--ss-muted)">
									{d.label}
								</text>
							) : null}
						</g>
					);
				})}
			</svg>
			<table className="sr-only">
				<caption>{label}</caption>
				<tbody>
					{data.map((d, i) => (
						<tr key={`${d.label}-${i}`}>
							<th scope="row">{d.label}</th>
							<td>{format(d.value)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</figure>
	);
}
