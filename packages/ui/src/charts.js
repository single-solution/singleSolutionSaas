/**
 * Dependency-free SVG charts. Each chart is an `img` with an accessible summary and a visually hidden data table
 * (screen readers get the numbers, not the drawing).
 * @module
 */
import { cx } from './cx.js';
import { Bar } from './display.js';

/** @typedef {{ label: string, value: number, hint?: string }} Datum */

/**
 * Vertical bar chart.
 * @param {{ data: Datum[], label: string, format?: (value: number) => string, height?: number, className?: string,
 *   emptyText?: string }} props
 */
export function BarChart({ data, label, format = String, height = 160, className, emptyText = 'No data for this period.' }) {
	if (data.length === 0) return <p className="py-6 text-center text-sm text-muted">{emptyText}</p>;
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
				<line x1="0" y1={plot} x2={width} y2={plot} stroke="var(--ss-line)" strokeWidth="1" />
				{data.map((d, i) => {
					const h = max > 0 ? Math.max(d.value > 0 ? 2 : 0, (d.value / max) * (plot - 8)) : 0;
					return (
						<g key={`${d.label}-${i}`}>
							<rect
								x={i * step + (step - barWidth) / 2}
								y={plot - h}
								width={barWidth}
								height={h}
								rx="3"
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

/**
 * Horizontal bars for shares of a total (e.g. credits per product).
 * @param {{ data: Datum[], label: string, format?: (value: number) => string, className?: string, emptyText?: string }} props
 */
export function ShareBars({ data, label, format = String, className, emptyText = 'Nothing to show yet.' }) {
	if (data.length === 0) return <p className="py-4 text-sm text-muted">{emptyText}</p>;
	const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
	return (
		<ul aria-label={label} className={cx('space-y-3', className)}>
			{data.map((d, i) => {
				const share = total > 0 ? Math.max(0, d.value) / total : 0;
				return (
					<li key={`${d.label}-${i}`} className="space-y-1">
						<div className="flex items-baseline justify-between gap-3 text-sm">
							<span className="min-w-0 truncate font-medium text-fg">{d.label}</span>
							<span className="shrink-0 tabular-nums text-muted">
								{format(d.value)}
								{d.hint ? ` · ${d.hint}` : ''}
							</span>
						</div>
						<div className="h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
							<Bar ratio={share} />
						</div>
					</li>
				);
			})}
		</ul>
	);
}
