/**
 * Layout and data-display components (no client state; usable from server components).
 * @module
 */
import { Fragment } from 'react';
import { cx } from './cx.js';
import { humanize } from './format.js';
import { Icon } from './icons.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'} Tone */
/**
 * Kind of thing a tile, badge or menu item stands for. It names the thing in the code; every kind takes the one indigo
 * accent (PLAN 0.6 colour rule: one accent, neutral surfaces, colour for status only), so a `kind` marks an item as
 * accented and its absence leaves it neutral.
 * @typedef {'overview' | 'merchant' | 'website' | 'product' | 'feature' | 'credit' | 'price' | 'admin' | 'settings'
 *   | 'default' | 'activity' | 'connection' | 'developer'} Kind
 */

/**
 * Text that may wrap between the parts of a domain, e-mail address or path: a soft break (`<wbr>`) after every dot,
 * `@` and slash, so `shop.example.com` wraps as `shop.example.` / `com` rather than mid-name, where it has to wrap at
 * all. Copying the text copies it unchanged.
 * @param {{ text: string }} props
 */
export function SoftBreaks({ text }) {
	// the text after each dot, `@` and slash starts a new part (no lookbehind: older Safari cannot parse it)
	const parts =
		String(text)
			.match(/[^.@/]*(?:[.@/]+|$)/g)
			?.filter(Boolean) ?? [];
	return (
		<>
			{parts.map((part, i) => (
				<Fragment key={i}>
					{i > 0 ? <wbr /> : null}
					{part}
				</Fragment>
			))}
		</>
	);
}

/** The accent tint of icon tiles, chips and empty-state icons. */
const ACCENT = 'bg-primary-soft text-primary';

/**
 * Rounded icon badge in the accent tint.
 * @param {{ icon: import('./icons.js').IconName, kind?: Kind, size?: 'sm' | 'md', className?: string }} props
 */
export function IconBadge({ icon, size = 'md', className }) {
	return (
		<span
			aria-hidden="true"
			className={cx(
				'inline-flex shrink-0 items-center justify-center',
				ACCENT,
				size === 'sm' ? 'size-8 rounded-lg' : 'size-10 rounded-xl',
				className,
			)}>
			<Icon name={icon} size={size === 'sm' ? 15 : 18} />
		</span>
	);
}

/**
 * Surface card: a soft rounded section (no border, no shadow) with a heading and a lighter one-line description.
 * @param {{ title?: ReactNode, subtitle?: ReactNode, actions?: ReactNode, children?: ReactNode, className?: string,
 *   bodyClassName?: string, as?: 'section' | 'div' | 'article', id?: string, padded?: boolean }} props
 */
export function Card({ title, subtitle, actions, children, className, bodyClassName, as = 'section', id, padded = true }) {
	const Tag = as;
	const hasHeader = Boolean(title || actions);
	return (
		<Tag
			id={id}
			className={cx('min-w-0 rounded-card bg-surface', className)}
			{...(title && typeof title === 'string' && as === 'section' ? { 'aria-label': title } : {})}>
			{title || actions ? (
				<header className="flex flex-wrap items-start justify-between gap-3 px-6 pt-5 sm:px-7 sm:pt-6">
					<div className="min-w-0">
						{title ? <h2 className="text-base font-bold tracking-tight text-fg">{title}</h2> : null}
						{subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
					</div>
					{actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
				</header>
			) : null}
			<div
				className={cx(
					padded && 'p-6 sm:p-7',
					padded && hasHeader && 'pt-4 sm:pt-5',
					!padded && hasHeader && 'pt-3',
					bodyClassName,
				)}>
				{children}
			</div>
		</Tag>
	);
}

/**
 * Page title row. `level` 2 makes the title an `h2` (the detail beside a list whose heading is the page's `h1`). The
 * actions sit beside the title while both fit on one line at their natural width; otherwise they move, as one group,
 * onto their own row under the title, so a long title is not squeezed beside them (they wrap inside the group only
 * when even that row is too narrow).
 * @param {{ title: ReactNode, subtitle?: ReactNode, actions?: ReactNode, breadcrumbs?: ReactNode, badge?: ReactNode,
 *   level?: 1 | 2 }} props
 */
export function PageHeader({ title, subtitle, actions, breadcrumbs, badge, level = 1 }) {
	const Heading = level === 2 ? 'h2' : 'h1';
	return (
		<div className="space-y-3 pb-1">
			{breadcrumbs}
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
				<div className="min-w-0 flex-auto">
					<Heading className="flex flex-wrap items-center gap-2 text-2xl font-extrabold tracking-tight text-fg">
						<span className="min-w-0 break-words">{title}</span>
						{badge}
					</Heading>
					{subtitle ? <p className="mt-1.5 text-sm text-muted">{subtitle}</p> : null}
				</div>
				{actions ? <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div> : null}
			</div>
		</div>
	);
}

/** @type {Record<Tone, string>} */
const TONES = {
	neutral: 'border-transparent bg-surface-2 text-fg',
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
 * Small pill: a status `tone`, or a chip of a `kind` of thing (the accent tint; it wins over `tone`).
 * @param {{ tone?: Tone, kind?: Kind, children: ReactNode, dot?: boolean, className?: string, title?: string }} props
 */
export function Badge({ tone = 'neutral', kind, children, dot = false, className, title }) {
	const look = kind ? 'primary' : tone;
	return (
		<span
			title={title}
			className={cx(
				'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 py-0.5 text-xs font-semibold',
				TONES[look],
				className,
			)}>
			{dot ? <span aria-hidden="true" className={cx('size-1.5 rounded-full', DOTS[look])} /> : null}
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
	neutral: { box: 'border-transparent bg-surface-2 text-fg', icon: 'info' },
	primary: { box: 'border-transparent bg-primary-soft text-on-primary-soft', icon: 'info' },
	info: { box: 'border-transparent bg-info-soft text-on-info-soft', icon: 'info' },
	success: { box: 'border-transparent bg-success-soft text-on-success-soft', icon: 'check' },
	warning: { box: 'border-transparent bg-warning-soft text-on-warning-soft', icon: 'alert' },
	danger: { box: 'border-transparent bg-danger-soft text-on-danger-soft', icon: 'alert' },
};

/**
 * Inline message box. Danger/warning callouts are announced (`role="alert"`), others are `status`. It fades in when it
 * appears (a Saved confirmation, an error).
 * @param {{ tone?: Tone, title?: ReactNode, children?: ReactNode, actions?: ReactNode, className?: string,
 *   live?: boolean }} props
 */
export function Callout({ tone = 'info', title, children, actions, className, live = true }) {
	const { box, icon } = CALLOUTS[tone];
	const role = !live ? undefined : tone === 'danger' || tone === 'warning' ? 'alert' : 'status';
	return (
		<div role={role} className={cx('flex animate-ss-enter gap-3 rounded-2xl border px-5 py-4 text-sm', box, className)}>
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
 * Empty state (nothing here yet) with an optional call to action. The icon is neutral, or in the accent tint with a
 * `kind`.
 * @param {{ title: ReactNode, description?: ReactNode, action?: ReactNode, icon?: import('./icons.js').IconName,
 *   kind?: Kind, className?: string, compact?: boolean }} props
 */
export function EmptyState({ title, description, action, icon = 'box', kind, className, compact = false }) {
	return (
		<div
			className={cx(
				'flex flex-col items-center justify-center rounded-card bg-surface-2/60 text-center',
				compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-12',
				className,
			)}>
			<span className={cx('flex size-10 items-center justify-center rounded-xl', kind ? ACCENT : 'bg-surface-3 text-muted')}>
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
			className={cx('flex flex-col items-center gap-3 rounded-card bg-surface px-6 py-10 text-center', className)}>
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
 * Loading placeholder blocks with a soft shimmer.
 * @param {{ className?: string, lines?: number, label?: string }} props
 */
export function Skeleton({ className, lines = 1, label = 'Loading' }) {
	return (
		<div role="status" aria-label={label} aria-busy="true" className="animate-ss-fade space-y-2">
			{Array.from({ length: lines }, (_, i) => (
				<div key={i} className={cx('ss-shimmer h-4 rounded-lg', i === lines - 1 && lines > 1 && 'w-2/3', className)} />
			))}
		</div>
	);
}

/**
 * One loading block (a title, a tile, a row) with the same shimmer, for skeletons shaped like the page to come.
 * @param {{ className?: string }} props
 */
export function SkeletonBlock({ className }) {
	return <div aria-hidden="true" className={cx('ss-shimmer rounded-lg', className)} />;
}

/**
 * Type size of a tile's value by the tile's width (container queries), so a figure fits on one line: up to 13
 * characters (`1,250 credits`) it is full size from a 12rem tile and one step smaller below; a longer one
 * (`12,345.678 credits`) steps down from full size below 17.5rem to the smallest step below 11.5rem. A value that is
 * not plain text (a phrase with a date, say) wraps on whole words instead.
 * @param {ReactNode} value
 */
const valueSize = (value) =>
	typeof value === 'string' || typeof value === 'number'
		? String(value).length > 13
			? 'whitespace-nowrap text-lg @[11.5rem]:text-xl @[14rem]:text-2xl @[17.5rem]:text-3xl'
			: 'whitespace-nowrap text-2xl @[12rem]:text-3xl'
		: 'text-balance text-2xl @[16rem]:text-3xl';

/**
 * Key figure: a summary tile on a neutral surface. With a `kind` its icon sits in the accent-tinted badge, without one
 * in a neutral badge (PLAN 0.6 colour rule); `tone` colours the hint by status. A new value fades in.
 *
 * The tile follows its own width (a size container), not the screen's: from 16rem the icon sits beside the label,
 * below that above it; the label wraps on whole words; a figure stays on one line and is never cut, its type a step
 * or two smaller where the tile is too narrow for it at full size (see `valueSize`). Put tiles in a
 * {@link StatGrid}, which keeps each one wide enough for its value.
 * @param {{ label: ReactNode, value: ReactNode, hint?: ReactNode, tone?: Tone, icon?: import('./icons.js').IconName,
 *   kind?: Kind, className?: string }} props
 */
export function Stat({ label, value, hint, tone = 'neutral', icon, kind, className }) {
	const hintTone =
		tone === 'danger'
			? 'text-danger'
			: tone === 'warning'
				? 'text-warning'
				: tone === 'success'
					? 'text-success'
					: 'text-muted';
	return (
		<div className={cx('@container min-w-0 rounded-card bg-surface p-5 sm:p-6', className)}>
			<div className="space-y-3">
				<div className="flex flex-col items-start gap-3 @3xs:flex-row @3xs:items-center">
					{icon ? (
						kind ? (
							<IconBadge icon={icon} kind={kind} />
						) : (
							<span
								aria-hidden="true"
								className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-3 text-muted">
								<Icon name={icon} size={18} />
							</span>
						)
					) : null}
					<span className="min-w-0 text-sm font-semibold text-pretty text-muted">{label}</span>
				</div>
				<div
					key={typeof value === 'string' || typeof value === 'number' ? String(value) : undefined}
					className={cx('animate-ss-fade font-extrabold tracking-tight text-fg tabular-nums', valueSize(value))}>
					{value}
				</div>
				{hint ? <div className={cx('text-xs font-medium text-pretty', hintTone)}>{hint}</div> : null}
			</div>
		</div>
	);
}

/**
 * Classes of a grid of summary tiles, by the width of its `@container` (not the screen's): one column, two from 28rem
 * (an odd last tile then spans the row), and every tile in one row once each gets about 13rem — three tiles from 42rem,
 * four from 56rem. More tiles stay in two columns.
 */
export const STAT_GRID =
	'grid grid-cols-1 gap-5 @md:grid-cols-2 @md:[&>:last-child:nth-child(odd)]:col-span-full ' +
	'@2xl:[&:has(>:nth-child(3):last-child)]:grid-cols-3 @2xl:[&:has(>:nth-child(3):last-child)>*]:col-span-1! ' +
	'@4xl:[&:has(>:nth-child(4):last-child)]:grid-cols-4';

/**
 * A row of summary tiles ({@link Stat}) sized by its own container (see {@link STAT_GRID}), so tiles in a narrow
 * detail pane or card drop to one or two columns while a wide page shows them side by side.
 * @param {{ children?: ReactNode, className?: string, label?: string }} props `label`: an accessible name for the group
 */
export function StatGrid({ children, className, label }) {
	return (
		<div className={cx('@container min-w-0', className)} {...(label ? { role: 'group', 'aria-label': label } : {})}>
			<div className={STAT_GRID}>{children}</div>
		</div>
	);
}

/**
 * Grid section of a page: a heading with a lighter one-line description, optional actions, then the content.
 * @param {{ title: ReactNode, description?: ReactNode, actions?: ReactNode, children?: ReactNode, id?: string,
 *   className?: string }} props `id` names the heading (`aria-labelledby`)
 */
export function Section({ title, description, actions, children, id, className }) {
	return (
		<section className={cx('min-w-0 space-y-4', className)} {...(id ? { 'aria-labelledby': id } : {})}>
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0">
					<h2 id={id} className="text-lg font-bold tracking-tight text-fg">
						{title}
					</h2>
					{description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
				</div>
				{actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
			</div>
			{children}
		</section>
	);
}

/**
 * Masonry of cards of different heights (PLAN 0.6 "use the space"): CSS columns by the width of the container — one
 * column below 42rem, two from 42rem, three from 72rem (`columns={2}` stops at two) — and every child is kept whole
 * (`break-inside: avoid`), so no card stretches to a taller neighbour. Children flow down the first column, then the
 * next, which is also the reading and tab order. Fragments are transparent: cards a component returns in a fragment are
 * items too. Rows of a list (`as="ul"`) are `li` items. With `wideAlone`, a lone card takes the whole width instead of
 * the first column (a settings section with one form).
 * @param {{ children?: ReactNode, columns?: 2 | 3, as?: 'div' | 'ul', className?: string, label?: string,
 *   wideAlone?: boolean }} props `label`: an accessible name for a list
 */
export function Masonry({ children, columns = 3, as = 'div', className, label, wideAlone = false }) {
	const Tag = as;
	return (
		<div className="@container min-w-0">
			<Tag
				aria-label={label}
				className={cx(
					'gap-5 [&>*]:mt-5 [&>*]:break-inside-avoid [&>*:first-child]:mt-0',
					columns === 3 ? 'columns-1 @2xl:columns-2 @6xl:columns-3' : 'columns-1 @2xl:columns-2',
					wideAlone && '[&:has(>:only-child)]:columns-1',
					className,
				)}>
				{children}
			</Tag>
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
								state === 'todo' && 'bg-surface-2 text-muted',
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
 * Description list of label/value pairs, in up to `columns` columns by the width of its own container: two from 28rem,
 * three from 42rem.
 * @param {{ items: Array<{ label: ReactNode, value: ReactNode }>, className?: string, columns?: 1 | 2 | 3 }} props
 */
export function KeyValueList({ items, className, columns = 2 }) {
	return (
		<div className="@container min-w-0">
			<dl
				className={cx(
					'grid grid-cols-1 gap-x-6 gap-y-4',
					columns === 2 && '@md:grid-cols-2',
					columns === 3 && '@md:grid-cols-2 @2xl:grid-cols-3',
					className,
				)}>
				{items.map((item, i) => (
					<div key={i} className="min-w-0 space-y-0.5">
						<dt className="text-xs font-semibold uppercase tracking-wider text-muted">{item.label}</dt>
						<dd className="break-words text-sm text-fg">{item.value}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
