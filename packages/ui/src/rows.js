'use client';
/**
 * Lists of things as clean rows (owner 2026-10-17: merchants, websites, products, admins, receipts): each row is an
 * icon or avatar, the name with one muted line of meta, a status pill, at most one primary action and a More menu
 * (⋯) holding everything else. Rows are divided by hairlines, never boxed in grey. `Toolbar` is the row of filters,
 * search and actions above a list or table.
 * @module
 */
import { cx } from './cx.js';
import { Avatar, IconBadge } from './display.js';
import { ActionMenu } from './Menu.js';

/** @typedef {import('react').ReactNode} ReactNode */

/**
 * The rows of a list, divided by hairlines. `inset` pads each row to the card's edge (a card with `padded={false}`),
 * with a hover tint.
 * @param {{ children?: ReactNode, inset?: boolean, label?: string, className?: string }} props
 */
export function RowList({ children, inset = false, label, className }) {
	return (
		<ul
			{...(label ? { 'aria-label': label } : {})}
			className={cx(
				'min-w-0 divide-y divide-line-soft',
				inset ? '[&>li]:px-5 [&>li]:hover:bg-surface-2/70' : '[&>li:first-child]:pt-0 [&>li:last-child]:pb-0',
				className,
			)}>
			{children}
		</ul>
	);
}

/**
 * One row of a {@link RowList}.
 * @param {{ title: ReactNode, meta?: ReactNode, icon?: import('./icons.js').IconName, kind?: import('./display.js').Kind,
 *   avatar?: string, media?: ReactNode, status?: ReactNode, action?: ReactNode,
 *   more?: import('./Menu.js').MenuItem[], moreLabel?: string, children?: ReactNode, className?: string,
 *   id?: string, wrap?: boolean }} props `icon` (accent tile with a `kind`) or `avatar` (initials of a name) or `media`
 *   lead the row; `status` is a `StatusPill`; `action` the one primary action; `more` the other actions; `children` sit
 *   under the row (its own nested rows); `wrap`: a long title wraps over lines instead of being cut short
 */
export function ListRow({
	title,
	meta,
	icon,
	kind,
	avatar,
	media,
	status,
	action,
	more,
	moreLabel = 'More actions',
	children,
	className,
	id,
	wrap = false,
}) {
	const lead =
		media ??
		(icon ? <IconBadge icon={icon} {...(kind ? { kind } : {})} size="sm" /> : avatar ? <Avatar name={avatar} /> : null);
	return (
		<li id={id} className={cx('ss-motion min-w-0 py-3', className)}>
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
				<div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
					{lead}
					<div className="min-w-0 flex-1">
						<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
							<span className={cx('min-w-0 text-sm font-medium text-fg', wrap ? 'break-words' : 'truncate')}>{title}</span>
							{status}
						</div>
						{meta ? <div className="mt-0.5 text-help break-words text-muted">{meta}</div> : null}
					</div>
				</div>
				{action || more?.length ? (
					<div className="ml-auto flex shrink-0 items-center gap-1.5">
						{action}
						{more?.length ? <ActionMenu label={moreLabel} items={more} /> : null}
					</div>
				) : null}
			</div>
			{children ? <div className="mt-3 min-w-0">{children}</div> : null}
		</li>
	);
}

/**
 * The bar above a list or table: a muted one-line `note` or filters and search on the left, actions on the right
 * (wrapping on a phone). `selection` is the soft accent bar of a bulk selection (how many are picked, what to do with
 * them).
 * @param {{ children?: ReactNode, note?: ReactNode, end?: ReactNode, className?: string, label?: string,
 *   variant?: 'plain' | 'selection' }} props
 */
export function Toolbar({ children, note, end, className, label, variant = 'plain' }) {
	return (
		<div
			{...(label ? { role: 'group', 'aria-label': label } : {})}
			className={cx(
				'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2',
				variant === 'selection' &&
					'animate-ss-enter rounded-card bg-primary-soft px-3 py-2 text-sm text-on-primary-soft',
				className,
			)}>
			{note ? <p className="min-w-0 flex-1 basis-60 text-sm text-muted">{note}</p> : null}
			{children ? <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div> : null}
			{end ? <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{end}</div> : null}
		</div>
	);
}
