/**
 * Dependency-free SVG charts. Each chart is an `img` with an accessible summary and a visually hidden data table
 * (screen readers get the numbers, not the drawing).
 * @module
 */
import { cx } from './cx.js';
import { Bar } from './display.js';
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

/**
 * The solid hero card of an overview (PLAN 0.6): the most important number large, a few details under it, and a
 * bar chart of the last days inside the card.
 * @param {{ label: string, value: import('react').ReactNode, icon?: import('./icons.js').IconName,
 *   details?: Array<{ label: import('react').ReactNode, value: import('react').ReactNode }>,
 *   chart: { label: string, data: Datum[], format?: (value: number) => string, emptyText?: string },
 *   children?: import('react').ReactNode, className?: string }} props
 */
export function HeroCard({ label, value, icon = 'wallet', details = [], chart, children, className }) {
	return (
		<section
			aria-label={label}
			className={cx(
				'grid min-w-0 gap-6 rounded-card bg-hero p-6 text-on-hero sm:p-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-10',
				className,
			)}>
			<div className="flex min-w-0 flex-col gap-5">
				<div className="flex items-center gap-3">
					<span
						aria-hidden="true"
						className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-hero-track">
						<Icon name={icon} size={18} />
					</span>
					<span className="text-sm font-semibold text-on-hero-muted">{label}</span>
				</div>
				<div
					key={typeof value === 'string' || typeof value === 'number' ? String(value) : undefined}
					className="animate-ss-fade break-words text-4xl font-extrabold tracking-tight tabular-nums sm:text-5xl">
					{value}
				</div>
				{details.length > 0 ? (
					<dl className="grid grid-cols-2 gap-4">
						{details.map((d, i) => (
							<div key={i} className="min-w-0 rounded-2xl bg-hero-track px-4 py-3">
								<dt className="text-xs font-semibold text-on-hero">{d.label}</dt>
								<dd className="mt-1 truncate text-base font-bold tabular-nums">{d.value}</dd>
							</div>
						))}
					</dl>
				) : null}
				{children}
			</div>
			<HeroBars {...chart} />
		</section>
	);
}

/**
 * Bars of the hero card (light bars on the solid colour, a soft track behind each bar).
 * @param {{ label: string, data: Datum[], format?: (value: number) => string, emptyText?: string }} props
 */
function HeroBars({ label, data, format = String, emptyText = 'No data for this period.' }) {
	const max = Math.max(...data.map((d) => d.value), 0);
	const step = 12;
	const width = Math.max(data.length, 1) * step;
	const height = 120;
	return (
		<figure className="flex min-w-0 flex-col justify-end gap-2">
			<figcaption className="text-xs font-semibold text-on-hero-muted">{label}</figcaption>
			{data.length === 0 ? (
				<p className="py-10 text-sm text-on-hero-muted">{emptyText}</p>
			) : (
				<>
					<svg
						role="img"
						aria-label={`${label}: ${data.length} values, highest ${format(max)}`}
						viewBox={`0 0 ${width} ${height}`}
						preserveAspectRatio="none"
						className="h-36 w-full sm:h-44">
						{data.map((d, i) => {
							const h = max > 0 ? Math.max(d.value > 0 ? 3 : 0, (d.value / max) * height) : 0;
							return (
								<g key={`${d.label}-${i}`}>
									<rect x={i * step + 2} y="0" width={step - 4} height={height} rx="3" fill="var(--ss-hero-track)" />
									<rect x={i * step + 2} y={height - h} width={step - 4} height={h} rx="3" fill="var(--ss-hero-bar)">
										<title>{`${d.hint ?? d.label}: ${format(d.value)}`}</title>
									</rect>
								</g>
							);
						})}
					</svg>
					<div aria-hidden="true" className="flex justify-between text-[11px] font-semibold text-on-hero-muted">
						<span>{data[0]?.label}</span>
						<span>{data[data.length - 1]?.label}</span>
					</div>
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
				</>
			)}
		</figure>
	);
}
