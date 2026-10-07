/**
 * Layout and data-display components (no client state; usable from server components).
 * @module
 */
import { cx } from './cx.js';
import { humanize } from './format.js';
import { Icon } from './icons.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'} Tone */

/**
 * Surface card (rounded island with a hairline border).
 * @param {{ title?: ReactNode, subtitle?: ReactNode, actions?: ReactNode, children?: ReactNode, className?: string,
 *   bodyClassName?: string, as?: 'section' | 'div' | 'article', id?: string, padded?: boolean }} props
 */
export function Card({ title, subtitle, actions, children, className, bodyClassName, as = 'section', id, padded = true }) {
	const Tag = as;
	return (
		<Tag
			id={id}
			className={cx('min-w-0 rounded-card border border-line bg-surface shadow-card', className)}
			{...(title && typeof title === 'string' && as === 'section' ? { 'aria-label': title } : {})}>
			{title || actions ? (
				<header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
					<div className="min-w-0">
						{title ? <h2 className="text-sm font-bold text-fg">{title}</h2> : null}
						{subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
					</div>
					{actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
				</header>
			) : null}
			<div className={cx(padded && 'p-5', bodyClassName)}>{children}</div>
		</Tag>
	);
}

/**
 * Page title row.
 * @param {{ title: ReactNode, subtitle?: ReactNode, actions?: ReactNode, breadcrumbs?: ReactNode, badge?: ReactNode }} props
 */
export function PageHeader({ title, subtitle, actions, breadcrumbs, badge }) {
	return (
		<div className="space-y-2 pb-2">
			{breadcrumbs}
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div className="min-w-0">
					<h1 className="flex flex-wrap items-center gap-2 text-xl font-bold tracking-tight text-fg">
						<span className="break-words">{title}</span>
						{badge}
					</h1>
					{subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
				</div>
				{actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
			</div>
		</div>
	);
}

/** @type {Record<Tone, string>} */
const TONES = {
	neutral: 'border-line bg-surface-2 text-fg',
	primary: 'border-transparent bg-primary-soft text-on-primary-soft',
	success: 'border-transparent bg-success-soft text-on-success-soft',
	warning: 'border-transparent bg-warning-soft text-on-warning-soft',
	danger: 'border-transparent bg-danger-soft text-on-danger-soft',
	info: 'border-transparent bg-info-soft text-on-info-soft',
};

/** @type {Record<Tone, string>} */
const DOTS = {
	neutral: 'bg-line-strong',
	primary: 'bg-primary',
	success: 'bg-success',
	warning: 'bg-warning',
	danger: 'bg-danger',
	info: 'bg-primary',
};

/**
 * Small pill.
 * @param {{ tone?: Tone, children: ReactNode, dot?: boolean, className?: string, title?: string }} props
 */
export function Badge({ tone = 'neutral', children, dot = false, className, title }) {
	return (
		<span
			title={title}
			className={cx(
				'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 py-0.5 text-xs font-semibold',
				TONES[tone],
				className,
			)}>
			{dot ? <span aria-hidden="true" className={cx('size-1.5 rounded-full', DOTS[tone])} /> : null}
			{children}
		</span>
	);
}

/** Tone of well-known statuses across the Portal. */
const STATUS_TONES = /** @type {Record<string, Tone>} */ ({
	active: 'success',
	low_balance: 'warning',
	grace: 'warning',
	stopped: 'danger',
	suspended: 'danger',
	removed: 'neutral',
	connected: 'success',
	enabled: 'success',
	pending: 'info',
	failed: 'danger',
	missing: 'warning',
	revoked: 'neutral',
	expired: 'neutral',
	disabled: 'neutral',
});

/**
 * Status pill with a dot; the label defaults to the humanised status.
 * @param {{ status: string, label?: ReactNode, className?: string }} props
 */
export function StatusBadge({ status, label, className }) {
	return (
		<Badge tone={STATUS_TONES[status] ?? 'neutral'} dot {...(className ? { className } : {})}>
			{label ?? humanize(status)}
		</Badge>
	);
}

/** @type {Record<Tone, { box: string, icon: import('./icons.js').IconName }>} */
const CALLOUTS = {
	neutral: { box: 'border-line bg-surface-2 text-fg', icon: 'info' },
	primary: { box: 'border-transparent bg-primary-soft text-on-primary-soft', icon: 'info' },
	info: { box: 'border-transparent bg-info-soft text-on-info-soft', icon: 'info' },
	success: { box: 'border-transparent bg-success-soft text-on-success-soft', icon: 'check' },
	warning: { box: 'border-transparent bg-warning-soft text-on-warning-soft', icon: 'alert' },
	danger: { box: 'border-transparent bg-danger-soft text-on-danger-soft', icon: 'alert' },
};

/**
 * Inline message box. Danger/warning callouts are announced (`role="alert"`), others are `status`.
 * @param {{ tone?: Tone, title?: ReactNode, children?: ReactNode, actions?: ReactNode, className?: string,
 *   live?: boolean }} props
 */
export function Callout({ tone = 'info', title, children, actions, className, live = true }) {
	const { box, icon } = CALLOUTS[tone];
	const role = !live ? undefined : tone === 'danger' || tone === 'warning' ? 'alert' : 'status';
	return (
		<div role={role} className={cx('flex gap-3 rounded-xl border px-4 py-3 text-sm', box, className)}>
			<span className="mt-0.5 shrink-0">
				<Icon name={icon} size={16} />
			</span>
			<div className="min-w-0 flex-1 space-y-1">
				{title ? <p className="font-semibold">{title}</p> : null}
				{children ? <div className="break-words">{children}</div> : null}
				{actions ? <div className="flex flex-wrap gap-2 pt-1">{actions}</div> : null}
			</div>
		</div>
	);
}

/**
 * Empty state (nothing here yet) with an optional call to action.
 * @param {{ title: ReactNode, description?: ReactNode, action?: ReactNode, icon?: import('./icons.js').IconName,
 *   className?: string, compact?: boolean }} props
 */
export function EmptyState({ title, description, action, icon = 'box', className, compact = false }) {
	return (
		<div
			className={cx(
				'flex flex-col items-center justify-center rounded-card border border-dashed border-line text-center',
				compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-12',
				className,
			)}>
			<span className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-on-primary-soft">
				<Icon name={icon} size={18} />
			</span>
			<div className="max-w-md space-y-1">
				<p className="text-sm font-semibold text-fg">{title}</p>
				{description ? <p className="text-sm text-muted">{description}</p> : null}
			</div>
			{action ? <div className="pt-1">{action}</div> : null}
		</div>
	);
}

/**
 * Error state of a page or section.
 * @param {{ title?: ReactNode, message: ReactNode, action?: ReactNode, className?: string }} props
 */
export function ErrorState({ title = 'This could not be loaded', message, action, className }) {
	return (
		<div
			role="alert"
			className={cx(
				'flex flex-col items-center gap-3 rounded-card border border-line bg-surface px-6 py-10 text-center',
				className,
			)}>
			<span className="flex size-10 items-center justify-center rounded-xl bg-danger-soft text-on-danger-soft">
				<Icon name="alert" size={18} />
			</span>
			<div className="max-w-md space-y-1">
				<p className="text-sm font-semibold text-fg">{title}</p>
				<p className="text-sm text-muted">{message}</p>
			</div>
			{action ? <div>{action}</div> : null}
		</div>
	);
}

/**
 * Loading placeholder blocks.
 * @param {{ className?: string, lines?: number, label?: string }} props
 */
export function Skeleton({ className, lines = 1, label = 'Loading' }) {
	return (
		<div role="status" aria-label={label} aria-busy="true" className="space-y-2">
			{Array.from({ length: lines }, (_, i) => (
				<div
					key={i}
					className={cx('h-4 animate-pulse rounded-lg bg-surface-2', i === lines - 1 && lines > 1 && 'w-2/3', className)}
				/>
			))}
		</div>
	);
}

/**
 * Key figure.
 * @param {{ label: ReactNode, value: ReactNode, hint?: ReactNode, tone?: Tone, icon?: import('./icons.js').IconName,
 *   className?: string }} props
 */
export function Stat({ label, value, hint, tone = 'neutral', icon, className }) {
	const hintTone =
		tone === 'danger'
			? 'text-danger'
			: tone === 'warning'
				? 'text-warning'
				: tone === 'success'
					? 'text-success'
					: 'text-muted';
	return (
		<div className={cx('min-w-0 space-y-1.5 rounded-card border border-line bg-surface p-5 shadow-card', className)}>
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</span>
				{icon ? (
					<span className="text-muted">
						<Icon name={icon} size={16} />
					</span>
				) : null}
			</div>
			<div className="truncate text-2xl font-extrabold tracking-tight text-fg tabular-nums">{value}</div>
			{hint ? <div className={cx('text-xs font-medium', hintTone)}>{hint}</div> : null}
		</div>
	);
}

/**
 * Horizontal meter (`role="meter"`): usage against a maximum.
 * @param {{ label: ReactNode, value: number, max: number, valueText?: string, hint?: ReactNode,
 *   tone?: 'auto' | Tone, className?: string }} props `auto` turns warning above 80 % and danger above 95 %.
 */
export function Meter({ label, value, max, valueText, hint, tone = 'auto', className }) {
	const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
	const resolved = tone === 'auto' ? (ratio >= 0.95 ? 'danger' : ratio >= 0.8 ? 'warning' : 'primary') : tone;
	const bar =
		resolved === 'danger'
			? 'fill-danger'
			: resolved === 'warning'
				? 'fill-warning'
				: resolved === 'success'
					? 'fill-success'
					: 'fill-primary';
	const text = valueText ?? `${Math.round(ratio * 100)} %`;
	return (
		<div className={cx('space-y-1.5', className)}>
			<div className="flex items-baseline justify-between gap-2 text-sm">
				<span className="font-medium text-fg">{label}</span>
				<span className="tabular-nums text-muted">{text}</span>
			</div>
			<div
				role="meter"
				aria-label={typeof label === 'string' ? label : undefined}
				aria-valuemin={0}
				aria-valuemax={max}
				aria-valuenow={Math.min(value, max)}
				aria-valuetext={text}
				className="h-2 overflow-hidden rounded-full bg-surface-2">
				<Bar ratio={ratio} className={bar} />
			</div>
			{hint ? <p className="text-xs text-muted">{hint}</p> : null}
		</div>
	);
}

/**
 * Filled share of a track, drawn in SVG (no inline `style`, which the Portal's CSP forbids).
 * @param {{ ratio: number, className?: string }} props
 */
export function Bar({ ratio, className = 'fill-primary' }) {
	const width = Math.round(Math.min(1, Math.max(0, ratio)) * 1000) / 10;
	return (
		<svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false" className="block h-full w-full">
			<rect x="0" y="0" width={width} height="8" className={className} />
		</svg>
	);
}

/**
 * Ordered steps of a flow (`aria-current="step"` on the active one).
 * @param {{ steps: Array<{ id: string, label: ReactNode, description?: ReactNode }>, current: string, className?: string }} props
 */
export function Stepper({ steps, current, className }) {
	const index = Math.max(
		0,
		steps.findIndex((s) => s.id === current),
	);
	return (
		<ol className={cx('flex flex-col gap-3 sm:flex-row sm:gap-6', className)}>
			{steps.map((step, i) => {
				const state = i < index ? 'done' : i === index ? 'current' : 'todo';
				return (
					<li key={step.id} className="flex items-start gap-3" aria-current={state === 'current' ? 'step' : undefined}>
						<span
							className={cx(
								'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
								state === 'done' && 'bg-success-soft text-on-success-soft',
								state === 'current' && 'bg-primary text-on-primary',
								state === 'todo' && 'border border-line bg-surface text-muted',
							)}>
							{state === 'done' ? <Icon name="check" size={14} title="Done" /> : i + 1}
						</span>
						<span className="min-w-0">
							<span className={cx('block text-sm font-semibold', state === 'todo' ? 'text-muted' : 'text-fg')}>
								{step.label}
							</span>
							{step.description ? <span className="block text-xs text-muted">{step.description}</span> : null}
						</span>
					</li>
				);
			})}
		</ol>
	);
}

/**
 * Breadcrumb trail; the last item is the current page.
 * @param {{ items: Array<{ label: ReactNode, href?: string }>, linkAs?: import('react').ElementType, className?: string }} props
 */
export function Breadcrumbs({ items, linkAs, className }) {
	const LinkTag = linkAs ?? 'a';
	return (
		<nav aria-label="Breadcrumb" className={className}>
			<ol className="flex flex-wrap items-center gap-1 text-xs text-muted">
				{items.map((item, i) => {
					const last = i === items.length - 1;
					return (
						<li key={i} className="flex items-center gap-1">
							{item.href && !last ? (
								<LinkTag href={item.href} className="rounded font-medium hover:text-fg hover:underline">
									{item.label}
								</LinkTag>
							) : (
								<span aria-current={last ? 'page' : undefined} className={cx(last && 'font-semibold text-fg')}>
									{item.label}
								</span>
							)}
							{last ? null : <Icon name="chevronRight" size={12} />}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

/**
 * Description list of label/value pairs.
 * @param {{ items: Array<{ label: ReactNode, value: ReactNode }>, className?: string, columns?: 1 | 2 | 3 }} props
 */
export function KeyValueList({ items, className, columns = 2 }) {
	return (
		<dl
			className={cx(
				'grid gap-x-6 gap-y-4',
				columns === 1 ? 'grid-cols-1' : columns === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3',
				className,
			)}>
			{items.map((item, i) => (
				<div key={i} className="min-w-0 space-y-0.5">
					<dt className="text-xs font-semibold uppercase tracking-wider text-muted">{item.label}</dt>
					<dd className="break-words text-sm text-fg">{item.value}</dd>
				</div>
			))}
		</dl>
	);
}
