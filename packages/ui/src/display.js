/**
 * Layout and data-display components (no client state; usable from server components).
 * @module
 */
import { Fragment, isValidElement } from 'react';
import { CountUp } from './CountUp.js';
import { cx } from './cx.js';
import { humanize } from './format.js';
import { Icon } from './icons.js';
import { CARD } from './layout-metrics.js';

/** @typedef {import('react').ReactNode} ReactNode */
/**
 * What a color means (theme.css): `primary` teal (the accent), `success` lime/ok green, `warning` amber,
 * `danger` rose, `attention` amber (needs you), `info` bright teal (help, tips),
 * `new` pink (new, featured); `neutral` carries no meaning.
 * @typedef {'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'attention' | 'new'} Tone
 */
/**
 * Kind of thing a tile, badge or menu item stands for. It names the thing in the code; every kind takes the one teal
 * accent (color rule: one accent, neutral surfaces, the other colors for their meaning only), so a `kind` marks an item
 * as accented and its absence leaves it neutral.
 * @typedef {'overview' | 'merchant' | 'website' | 'product' | 'feature' | 'credit' | 'price' | 'admin' | 'settings'
 *   | 'default' | 'activity' | 'connection' | 'developer'} Kind
 */

/**
 * Text that may wrap between the parts of a domain, email address or path: a soft break (`<wbr>`) after every dot,
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

/**
 * The tinted chip of each meaning: a 50 tint behind the icon in the meaning's AA shade (never a large fill).
 * @type {Record<Tone, string>}
 */
export const TINTS = Object.freeze({
	neutral: 'bg-surface-2 text-muted',
	primary: 'bg-primary-soft text-primary',
	success: 'bg-success-soft text-success',
	warning: 'bg-warning-soft text-warning',
	danger: 'bg-danger-soft text-danger',
	info: 'bg-info-soft text-info',
	attention: 'bg-attention-soft text-attention',
	new: 'bg-new-soft text-new',
});

/**
 * The look of each product of the Portal (owner 2026-10-17): its meaning color for its small icon chip and its icon.
 * A product not listed gets the accent and a box.
 * @type {Readonly<Record<string, { tone: Tone, icon: import('./icons.js').IconName }>>}
 */
const PRODUCT_LOOKS = Object.freeze({
	accounts: { tone: 'primary', icon: 'user' },
	payments: { tone: 'success', icon: 'creditCard' },
	chat: { tone: 'info', icon: 'message' },
	growth: { tone: 'attention', icon: 'trendingUp' },
	notifications: { tone: 'warning', icon: 'bell' },
	ecommerce: { tone: 'new', icon: 'bag' },
});

/**
 * The chip look of a product by its id: its meaning color and icon.
 * @param {string | null | undefined} productId
 * @returns {{ tone: Tone, icon: import('./icons.js').IconName }}
 */
export const productLook = (productId) => PRODUCT_LOOKS[String(productId ?? '')] ?? { tone: 'primary', icon: 'box' };

/**
 * Rounded icon chip: a meaning `tone` tint, the accent tint with a `kind`, neutral without either. `product` (a product
 * id) gives the product's own color and icon.
 * @param {{ icon?: import('./icons.js').IconName, kind?: Kind, tone?: Tone, product?: string, size?: 'xs' | 'sm' | 'md',
 *   className?: string }} props
 */
export function IconBadge({ icon, kind, tone, product, size = 'md', className }) {
	const look = product ? productLook(product) : null;
	const name = look?.icon ?? icon ?? 'box';
	return (
		<span
			aria-hidden="true"
			className={cx(
				'inline-flex shrink-0 items-center justify-center',
				TINTS[tone ?? look?.tone ?? (kind ? 'primary' : 'neutral')],
				size === 'xs' ? 'size-6 rounded-control' : size === 'sm' ? 'size-8 rounded-control' : 'size-9 rounded-control',
				className,
			)}>
			<Icon name={name} size={size === 'xs' ? 13 : size === 'sm' ? 15 : 17} />
		</span>
	);
}

/**
 * Initials of a name or email for an avatar: the first letters of the first two words (the part before the @ of an
 * email), upper-cased.
 * @param {string} name
 */
const initialsOfName = (name) => {
	const words = (name.split('@')[0] ?? '').split(/[\s._-]+/).filter(Boolean);
	return (words.length > 1 ? (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '') : (words[0] ?? '').slice(0, 2)).toUpperCase() || '?';
};

/**
 * A round avatar with the person's initials in the accent tint.
 * @param {{ name: string, size?: 'sm' | 'md', className?: string }} props
 */
export function Avatar({ name, size = 'md', className }) {
	return (
		<span
			aria-hidden="true"
			className={cx(
				'inline-flex shrink-0 items-center justify-center rounded-full border border-line bg-canvas font-semibold text-fg',
				size === 'sm' ? 'size-6 text-micro' : 'size-8 text-label',
				className,
			)}>
			{initialsOfName(name)}
		</span>
	);
}

/**
 * The dot of a status: the brand hue of its meaning (`accent` is the accent blue), the `label` its tooltip and the
 * screen-reader text. The same dot a `Row` draws after its title.
 * @param {{ tone: Tone | 'accent', label: string }} status
 */
const statusDot = (status) => (
	<span className="flex shrink-0 items-center" title={status.label}>
		<span aria-hidden="true" className={cx('size-2 rounded-full', DOTS[status.tone === 'accent' ? 'primary' : status.tone])} />
		<span className="sr-only">{status.label}</span>
	</span>
);

/**
 * What leads a card's title: `{ icon, tone }` draws an icon chip, `{ avatar: name }` the initials of a person or a
 * business, a node is drawn as it is.
 * @typedef {ReactNode | { avatar: string } | { icon: import('./icons.js').IconName, tone?: Tone }} CardLead
 */

/** @param {CardLead} lead */
const cardLead = (lead) => {
	if (lead === null || lead === undefined || typeof lead !== 'object' || isValidElement(lead) || Array.isArray(lead)) {
		return /** @type {ReactNode} */ (lead);
	}
	if ('avatar' in lead) return <Avatar name={lead.avatar} />;
	if ('icon' in lead) return <IconBadge icon={lead.icon} {...(lead.tone ? { tone: lead.tone } : {})} />;
	return null;
};

/**
 * The meter of a card: a thin bar that grows to its width when it appears (the theme's motion; with reduced motion it
 * fades in) and the words about it under it.
 * @param {{ percent: number, label?: ReactNode }} props
 */
function CardMeter({ percent, label }) {
	const width = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
	return (
		<div>
			<div
				role="meter"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(width)}
				{...(typeof label === 'string' ? { 'aria-label': label } : {})}
				className="h-1.5 overflow-hidden rounded-full bg-surface-2">
				<div data-ss-meter="" className="h-full animate-ss-meter rounded-full bg-primary" style={{ width: `${width}%` }} />
			</div>
			{label ? <p className="mt-1.5 text-micro text-muted tabular-nums">{label}</p> : null}
		</div>
	);
}

/**
 * Surface card, only where grouping helps (level 1: a white surface with a hairline edge on the off-white canvas): its
 * header holds the title, a one-line description and up to two actions (the rest in a More menu); whitespace, not a
 * line, parts it from the body, which is padded 20 px. Never put boxes inside a card: use rows divided by hairlines
 * (setting rows, a table).
 *
 * The rich parts are all optional (a card with none of them looks as it always did): `lead` before the title, `status`
 * a colored dot after it, `help` one muted line under it, `toggle` at the right of the title line, `meter` a thin bar
 * with its words under the body, `action` one link or button at the very bottom. A card with any of them also lifts 1 px
 * and darkens its edge on hover (not with reduced motion); a card whose `toggle` is a node with `checked={false}` (the
 * kit's `Switch`) draws its body muted.
 * @param {{ title?: ReactNode, subtitle?: ReactNode, actions?: ReactNode, children?: ReactNode, className?: string,
 *   bodyClassName?: string, as?: 'section' | 'div' | 'article', id?: string, padded?: boolean, flow?: boolean,
 *   lead?: CardLead, status?: { tone: Tone | 'accent', label: string }, help?: ReactNode, toggle?: ReactNode,
 *   meter?: { percent: number, label?: ReactNode }, action?: ReactNode }} props
 *   `flow`: a small card that takes one column of a `CardFlow` and sits beside the others (anything else in a flow takes
 *   the whole row); `meter.percent`: 0 to 100
 */
export function Card({
	title,
	subtitle,
	actions,
	children,
	className,
	bodyClassName,
	as = 'section',
	id,
	padded = true,
	flow = false,
	lead,
	status,
	help,
	toggle,
	meter,
	action,
}) {
	const Tag = as;
	const hasHeader = Boolean(title || actions || lead || status || help || toggle);
	const rich = Boolean(lead || status || help || toggle || meter || action);
	const off = isValidElement(toggle) && /** @type {{ checked?: unknown }} */ (toggle.props).checked === false;
	const leading = lead === undefined || lead === null ? null : cardLead(lead);
	const heading = title ? <h2 className="text-title font-semibold tracking-[-0.01em] text-fg">{title}</h2> : null;
	const main = (
		<div className="min-w-0 flex-1">
			{status ? (
				<div className="flex min-w-0 items-center gap-2">
					{heading}
					{statusDot(status)}
				</div>
			) : (
				heading
			)}
			{subtitle ? <p className="mt-0.5 text-help text-muted">{subtitle}</p> : null}
			{help ? <p className="mt-0.5 text-help text-pretty text-muted">{help}</p> : null}
		</div>
	);
	const content =
		(children || meter) && (meter || off) ? (
			<div className={cx(off && 'opacity-60 ss-motion')}>
				{children}
				{meter ? (
					<div className={cx(Boolean(children) && 'mt-4')}>
						<CardMeter percent={meter.percent} {...(meter.label ? { label: meter.label } : {})} />
					</div>
				) : null}
			</div>
		) : (
			children
		);
	const foot = action ? (
		<div className={cx('flex flex-wrap items-center gap-2', Boolean(content) && 'mt-4')}>{action}</div>
	) : null;
	return (
		<Tag
			id={id}
			{...(flow ? { 'data-flow': 'card' } : {})}
			className={cx(CARD.box, rich && 'ss-lift hover:border-line-strong', className)}
			{...(title && typeof title === 'string' && as === 'section' ? { 'aria-label': title } : {})}>
			{hasHeader ? (
				<header className={CARD.header}>
					{leading ? (
						<div className="flex min-w-0 flex-1 items-start gap-3">
							<span className="flex shrink-0 items-center">{leading}</span>
							{main}
						</div>
					) : (
						main
					)}
					{actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
					{toggle ? <div className="flex shrink-0 items-center">{toggle}</div> : null}
				</header>
			) : null}
			<div
				className={cx(
					padded && (hasHeader ? CARD.bodyWithHeader : CARD.body),
					!padded && hasHeader && 'pt-2',
					bodyClassName,
				)}>
				{padded ? (
					<>
						{content}
						{foot}
					</>
				) : (
					content
				)}
			</div>
			{!padded && foot ? <div className="px-5 pt-3 pb-5">{foot}</div> : null}
		</Tag>
	);
}

/** @type {Record<Tone, string>} */
const TONES = {
	neutral: 'border-transparent bg-surface-2 text-fg/75',
	primary: 'border-transparent bg-primary-soft text-on-primary-soft',
	success: 'border-transparent bg-success-soft text-on-success-soft',
	warning: 'border-transparent bg-warning-soft text-on-warning-soft',
	danger: 'border-transparent bg-danger-soft text-on-danger-soft',
	info: 'border-transparent bg-info-soft text-on-info-soft',
	attention: 'border-transparent bg-attention-soft text-on-attention-soft',
	new: 'border-transparent bg-new-soft text-on-new-soft',
};

/**
 * The status dots: the brand hue of each meaning (a dot always sits beside its words).
 * @type {Record<Tone, string>}
 */
export const DOTS = Object.freeze({
	neutral: 'bg-line-strong',
	primary: 'bg-primary',
	success: 'bg-success-solid',
	warning: 'bg-warning-solid',
	danger: 'bg-danger-solid',
	info: 'bg-info-solid',
	attention: 'bg-attention-solid',
	new: 'bg-new-solid',
});

/**
 * Small pill: a meaning `tone`, or a chip of a `kind` of thing (the accent tint; it wins over `tone`). `icon` leads it
 * instead of the dot; `onRemove` ends it with a small remove button named `removeLabel` (a tag in a list of values).
 * @param {{ tone?: Tone, kind?: Kind, children: ReactNode, dot?: boolean, icon?: import('./icons.js').IconName,
 *   className?: string, title?: string, onRemove?: () => void, removeLabel?: string }} props
 */
export function Badge({ tone = 'neutral', kind, children, dot = false, icon, className, title, onRemove, removeLabel }) {
	const look = kind ? 'primary' : tone;
	return (
		<span
			title={title}
			className={cx(
				'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-control border px-2 text-xs leading-4 font-medium',
				TONES[look],
				className,
			)}>
			{icon ? (
				<Icon name={icon} size={12} className="shrink-0" />
			) : dot ? (
				<span aria-hidden="true" className={cx('size-1.5 rounded-full', DOTS[look])} />
			) : null}
			{children}
			{onRemove ? (
				<button
					type="button"
					aria-label={removeLabel ?? 'Remove'}
					onClick={onRemove}
					className="ss-motion ss-press -mr-1 rounded-full p-0.5 opacity-70 hover:bg-surface-3 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-focus">
					<Icon name="close" size={11} />
				</button>
			) : null}
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
	missing: 'attention',
	revoked: 'neutral',
	expired: 'neutral',
	disabled: 'neutral',
});

/**
 * Status pill with a dot; the label defaults to the humanized status.
 * @param {{ status: string, label?: ReactNode, className?: string }} props
 */
export function StatusBadge({ status, label, className }) {
	return (
		<Badge tone={STATUS_TONES[status] ?? 'neutral'} dot {...(className ? { className } : {})}>
			{label ?? humanize(status)}
		</Badge>
	);
}

/**
 * A link inside text, a table cell, a header or a footer, in one look: the accent color, underlined on hover; `tone="plain"`
 * is the text color that takes the accent on hover (the name in a table row). `as` renders a router link; `external`
 * opens a new tab and marks it with an arrow. Never style a link by hand.
 * @param {Omit<import('react').AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string,
 *   as?: import('react').ElementType, tone?: 'accent' | 'plain', external?: boolean }} props
 */
export function TextLink({ href, as, tone = 'accent', external = false, className, children, ...rest }) {
	const Tag = as ?? 'a';
	return (
		<Tag
			href={href}
			{...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
			className={cx(
				tone === 'accent' ? 'font-semibold text-primary hover:underline' : 'text-fg hover:text-primary hover:underline',
				external && 'inline-flex items-center gap-1',
				className,
			)}
			{...rest}>
			{children}
			{external ? <Icon name="external" size={13} /> : null}
		</Tag>
	);
}

/**
 * A note where a value is shown that the Portal owns (the website's look, Format, business facts): what it is, where it
 * is set (`Portal › Website settings › Region and format`) and a link to that place. Teal, the color of help: it tells
 * the person where to go, it does not warn. Used on every place that shows a Portal value instead of a form.
 * @param {{ title?: ReactNode, children?: ReactNode, href?: string, linkLabel?: ReactNode, className?: string }} props
 *   `href`: the place in the Portal (an address built from the pinned Portal URL), opened in a new tab
 */
export function ManagedNote({ title, children, href, linkLabel, className }) {
	return (
		<Callout
			tone="info"
			{...(title ? { title } : {})}
			{...(className ? { className } : {})}
			{...(href
				? {
						actions: (
							<TextLink href={href} external>
								{linkLabel ?? 'Open in the Portal'}
							</TextLink>
						),
					}
				: {})}>
			{children}
		</Callout>
	);
}

/** @typedef {'active' | 'setup' | 'off' | 'error' | 'info' | 'warning' | 'new' | 'locked'} PillStatus */
/** @type {Record<PillStatus, Tone>} */
const PILL_TONES = {
	active: 'success',
	setup: 'attention',
	off: 'neutral',
	error: 'danger',
	info: 'info',
	warning: 'warning',
	new: 'new',
	locked: 'neutral',
};

/**
 * The one look of a state across the Portal and the dashboards: a pill with a dot — Active (green), Needs setup
 * (orange: it needs you), Off (neutral), an error (red), a warning (yellow), a note (teal), New (pink) or Locked (a lock:
 * only a Single Solution admin can switch it on).
 * @param {{ status: PillStatus, children: ReactNode, title?: string, className?: string }} props
 */
export function StatusPill({ status, children, title, className }) {
	return (
		<Badge
			tone={PILL_TONES[status]}
			{...(status === 'locked' ? { icon: 'lock' } : { dot: true })}
			{...(title ? { title } : {})}
			{...(className ? { className } : {})}>
			{children}
		</Badge>
	);
}

/** The soft box and the icon of each meaning (a `Callout`, a `NextStep`). @type {Record<Tone, { box: string, icon: import('./icons.js').IconName }>} */
export const CALLOUTS = {
	neutral: { box: 'bg-surface-2 text-fg', icon: 'info' },
	primary: { box: 'bg-primary-soft text-on-primary-soft', icon: 'info' },
	info: { box: 'bg-info-soft text-on-info-soft', icon: 'info' },
	success: { box: 'bg-success-soft text-on-success-soft', icon: 'check' },
	warning: { box: 'bg-warning-soft text-on-warning-soft', icon: 'alert' },
	danger: { box: 'bg-danger-soft text-on-danger-soft', icon: 'alert' },
	attention: { box: 'bg-attention-soft text-on-attention-soft', icon: 'alert' },
	new: { box: 'bg-new-soft text-on-new-soft', icon: 'sparkle' },
};

/**
 * Inline message box on its meaning's soft tint (no frame): teal for tips and help, yellow for warnings, red for
 * errors, orange for what needs the person, pink for news. Danger/warning/attention callouts are announced
 * (`role="alert"`), others are `status`. It fades in when it appears (a Saved confirmation, an error).
 * @param {{ tone?: Tone, title?: ReactNode, children?: ReactNode, actions?: ReactNode, className?: string,
 *   live?: boolean }} props
 */
export function Callout({ tone = 'info', title, children, actions, className, live = true }) {
	const { box, icon } = CALLOUTS[tone];
	const role = !live ? undefined : tone === 'danger' || tone === 'warning' || tone === 'attention' ? 'alert' : 'status';
	return (
		<div role={role} className={cx('flex animate-ss-enter gap-2.5 rounded-card px-3.5 py-2.5 text-sm', box, className)}>
			<span className="mt-0.5 shrink-0">
				<Icon name={icon} size={15} />
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
 * Empty state (nothing here yet) with an optional call to action: no frame, whitespace around it; its icon in the help
 * teal (the hint of what to do), the accent tint with a `kind`, or another meaning with `tone` (a product's color).
 * @param {{ title: ReactNode, description?: ReactNode, action?: ReactNode, icon?: import('./icons.js').IconName,
 *   kind?: Kind, tone?: Tone, className?: string, compact?: boolean }} props
 */
export function EmptyState({ title, description, action, icon = 'box', kind, tone, className, compact = false }) {
	return (
		<div
			className={cx(
				'flex flex-col items-center justify-center text-center',
				compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-12',
				className,
			)}>
			<span
				className={cx(
					'flex size-10 items-center justify-center rounded-control',
					TINTS[tone ?? (kind ? 'primary' : 'info')],
				)}>
				<Icon name={icon} size={18} />
			</span>
			<div className="max-w-sm space-y-0.5">
				<p className="text-sm font-medium text-fg">{title}</p>
				{description ? <p className="text-help text-muted">{description}</p> : null}
			</div>
			{action ? <div className="pt-1">{action}</div> : null}
		</div>
	);
}

/**
 * Error state of a page or section: clean, no frame — the red alert chip, what failed, why, and the way out (Try
 * again).
 * @param {{ title?: ReactNode, message: ReactNode, action?: ReactNode, className?: string }} props
 */
export function ErrorState({ title = 'This could not be loaded', message, action, className }) {
	return (
		<div role="alert" className={cx('flex flex-col items-center gap-3 px-6 py-12 text-center', className)}>
			<span className="flex size-10 items-center justify-center rounded-control bg-danger-soft text-danger">
				<Icon name="alert" size={18} />
			</span>
			<div className="max-w-md space-y-0.5">
				<p className="text-sm font-medium text-fg">{title}</p>
				<p className="text-help text-muted">{message}</p>
			</div>
			{action ? <div>{action}</div> : null}
		</div>
	);
}

/**
 * Shown when a deep link points to an item or record that was deleted or is not accessible.
 * @param {{ title?: ReactNode, message?: ReactNode, action?: ReactNode, className?: string }} props
 */
export function RemovedState({ title, message = 'This item was removed or you no longer have access.', action, className }) {
	return (
		<div role="status" className={cx('flex flex-col items-center gap-3 px-6 py-12 text-center', className)}>
			<span className="flex size-10 items-center justify-center rounded-control bg-surface-2 text-muted">
				<Icon name="box" size={18} />
			</span>
			<div className="max-w-md space-y-0.5">
				{title ? <p className="text-sm font-medium text-fg">{title}</p> : null}
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
				<div key={i} className={cx('ss-shimmer h-4 rounded-control', i === lines - 1 && lines > 1 && 'w-2/3', className)} />
			))}
		</div>
	);
}

/**
 * One loading block (a title, a tile, a row) with the same shimmer, for skeletons shaped like the page to come.
 * @param {{ className?: string }} props
 */
export function SkeletonBlock({ className }) {
	return <div aria-hidden="true" className={cx('ss-shimmer rounded-control', className)} />;
}

/**
 * A feature the person cannot use yet, said clearly (owner 2026-10-17): a lock, what it does, and who can switch it on
 * (`note`, e.g. "Ask your Single Solution admin to switch it on."); an optional action (contact support). `compact`
 * draws it as one row inside a list.
 * @param {{ title: ReactNode, description?: ReactNode, note?: ReactNode, action?: ReactNode, compact?: boolean,
 *   className?: string }} props
 */
export function LockedState({ title, description, note, action, compact = false, className }) {
	return (
		<div
			className={cx(
				'flex min-w-0',
				compact ? 'items-start gap-3 py-2 text-left' : 'flex-col items-center gap-3 px-6 py-12 text-center',
				className,
			)}>
			<span
				aria-hidden="true"
				className={cx(
					'flex shrink-0 items-center justify-center bg-surface-2 text-muted',
					compact ? 'size-8 rounded-control' : 'size-10 rounded-control',
				)}>
				<Icon name="lock" size={compact ? 15 : 18} />
			</span>
			<div className={cx('min-w-0 space-y-0.5', !compact && 'max-w-md')}>
				<p className="text-sm font-medium text-fg">{title}</p>
				{description ? <p className="text-help text-muted">{description}</p> : null}
				{note ? <p className="pt-0.5 text-help font-medium text-fg/80">{note}</p> : null}
			</div>
			{action ? <div className={compact ? 'ml-auto shrink-0' : ''}>{action}</div> : null}
		</div>
	);
}

/**
 * Text colors of a tile's hint and change by status (any other tone stays muted).
 * @type {Partial<Record<Tone, string>>}
 */
const STAT_TEXT = {
	danger: 'text-danger',
	warning: 'text-warning',
	success: 'text-success',
	attention: 'text-attention',
	info: 'text-info',
};

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
			? 'whitespace-nowrap text-lg @[11.5rem]:text-xl @[16rem]:text-2xl'
			: 'whitespace-nowrap text-2xl @[14rem]:text-figure'
		: 'text-balance text-xl @[16rem]:text-2xl';

/**
 * Key figure: a summary tile on a neutral surface. With a `kind` its icon sits in the accent-tinted badge, without one
 * in a neutral badge (PLAN 0.6 color rule); `tone` colors the hint by status. A new value fades in, and a numeric one
 * (a number, or a text with one number such as `1,284` or `$82`) counts from the old number to the new one (not on the
 * first draw, not with reduced motion; see {@link CountUp}).
 *
 * The tile follows its own width (a size container), not the screen's: a small icon sits beside the label, which
 * wraps on whole words; a figure stays on one line and is never cut, its type a step
 * or two smaller where the tile is too narrow for it at full size (see `valueSize`). Put tiles in a
 * {@link StatGrid}, which keeps each one wide enough for its value.
 * @param {{ label: ReactNode, value: ReactNode, hint?: ReactNode, tone?: Tone, icon?: import('./icons.js').IconName,
 *   kind?: Kind, className?: string, change?: { value: ReactNode, tone?: Tone } }} props `change`: how the figure moved
 *   (`+8%`), beside it in its tone's color
 */
export function Stat({ label, value, hint, tone = 'neutral', icon, kind, className, change }) {
	const figure = (
		<CountUp
			value={value}
			className={cx('animate-ss-fade font-display font-semibold tracking-[-0.02em] text-fg tabular-nums', valueSize(value))}
		/>
	);
	return (
		<div className={cx(CARD.tile, className)}>
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					{icon ? (
						kind ? (
							<IconBadge icon={icon} kind={kind} size="xs" />
						) : (
							<span
								aria-hidden="true"
								className="inline-flex size-6 shrink-0 items-center justify-center rounded-control bg-surface-2 text-muted">
								<Icon name={icon} size={13} />
							</span>
						)
					) : null}
					<span className="min-w-0 text-label font-medium text-pretty text-muted">{label}</span>
				</div>
				{change ? (
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
						{figure}
						<span className={cx('text-help font-medium tabular-nums', STAT_TEXT[change.tone ?? 'neutral'] ?? 'text-muted')}>
							{change.value}
						</span>
					</div>
				) : (
					figure
				)}
				{hint ? <div className={cx('text-help font-medium text-pretty', STAT_TEXT[tone] ?? 'text-muted')}>{hint}</div> : null}
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
	'grid grid-cols-1 gap-4 @md:grid-cols-2 @md:[&>:last-child:nth-child(odd)]:col-span-full ' +
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
		<section className={cx('min-w-0 space-y-3', className)} {...(id ? { 'aria-labelledby': id } : {})}>
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div className="min-w-0">
					<h2 id={id} className="text-title font-semibold tracking-[-0.01em] text-fg">
						{title}
					</h2>
					{description ? <p className="mt-0.5 text-help text-muted">{description}</p> : null}
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
 * (`break-inside: avoid`), so no card stretches to a taller neighbor. Children flow down the first column, then the
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
								state === 'done' && 'bg-success-soft text-success',
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
						<dt className="text-help font-medium text-muted">{item.label}</dt>
						<dd className="break-words text-sm text-fg">{item.value}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
