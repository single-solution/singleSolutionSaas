'use client';
/**
 * The rich row (owner 2026-10-21): the ONE row every list is made of, in every app. Left a lead (an avatar of a name, an
 * icon chip, or any node), then the title with a status dot after it, and under it one line of facts, cut with an
 * ellipsis (or a warning in its color in place of the facts); right a value (top, medium weight) and a time (bottom,
 * muted), and at the very end an optional control such as a switch. Clicking the row selects it (`onSelect`) or opens
 * its `href` (a link through the shell's `linkAs`, drawn as a stretched link so the whole row is the target); a click or
 * a key inside `trailing` never selects it. It is a fixed-height box, so a skeleton row and the highlight of a
 * `ListColumn` have the same size.
 * @module
 */
import { Fragment, isValidElement } from 'react';
import { cx } from './cx.js';
import { Avatar, DOTS, IconBadge } from './display.js';
import { LIST, LIST_TONE } from './layout-metrics.js';
import { useShell } from './shell-state.js';
import { UNSAVED_TEXTS } from './unsaved.js';

/** @typedef {import('react').ReactNode} ReactNode */
/** @typedef {import('./display.js').Tone} Tone */
/** @typedef {'success' | 'warning' | 'danger' | 'accent' | 'neutral'} RowTone */
/**
 * What leads a row: `{ avatar: name }` draws the initials of a person or a business, `{ icon, tone }` an icon chip, a
 * node is drawn as it is.
 * @typedef {ReactNode | { avatar: string } | { icon: import('./icons.js').IconName, tone?: Tone }} RowLead
 */
/** The attributes the row's outer box passes on (a `ListColumn` sets `role`, `aria-selected`, `tabIndex`, hover and focus). */
/** @typedef {Omit<import('react').ComponentPropsWithRef<'div'>, 'title' | 'children' | 'className' | 'onSelect' | 'onClick' | 'onKeyDown'>} RowBoxProps */

/** @type {Record<RowTone, Tone>} */
const DOT_TONES = { success: 'success', warning: 'warning', danger: 'danger', accent: 'primary', neutral: 'neutral' };

/** The lead of a row. @param {RowLead} lead */
export const leadOf = (lead) => {
	if (lead === null || lead === undefined || typeof lead !== 'object' || isValidElement(lead) || Array.isArray(lead)) {
		return /** @type {ReactNode} */ (lead);
	}
	if ('avatar' in lead) return <Avatar name={lead.avatar} />;
	if ('icon' in lead) return <IconBadge icon={lead.icon} {...(lead.tone ? { tone: lead.tone } : {})} />;
	return null;
};

/**
 * @param {RowBoxProps & { lead?: RowLead, title: ReactNode, status?: { tone: RowTone, label: string },
 *   meta?: ReactNode | ReactNode[], warning?: { tone?: RowTone, text: string }, value?: ReactNode, time?: ReactNode,
 *   trailing?: ReactNode, href?: string, onSelect?: () => void, selected?: boolean, disabled?: boolean,
 *   changed?: boolean, texts?: Partial<Pick<import('./unsaved.js').UnsavedTexts, 'changed'>>,
 *   linkAs?: import('react').ElementType, className?: string }} props `status`: a colored dot after the title, its
 *   `label` the tooltip and the screen-reader text; `meta`: one line (an array is joined with " · "); `warning`: shown in
 *   place of `meta`, in its color; `trailing`: a control (a switch); `href` or `onSelect` makes the row a link or a
 *   button, `selected` its picked look; `changed`: the item has unsaved changes (the word "Changed" after the title, so
 *   it is not told by colour alone)
 */
export function Row({
	lead,
	title,
	status,
	meta,
	warning,
	value,
	time,
	trailing,
	href,
	onSelect,
	selected = false,
	disabled = false,
	changed = false,
	texts,
	linkAs,
	className,
	...box
}) {
	const shell = useShell();
	const LinkTag = linkAs ?? shell.linkAs ?? 'a';
	const tone = warning ? LIST_TONE[warning.tone ?? 'warning'] : LIST_TONE.neutral;
	const metaItems = warning ? [] : [meta].flat().filter((m) => m !== null && m !== undefined && m !== false && m !== '');
	// a link row is made of a stretched link; a plain row is the target itself
	const button = !href && onSelect !== undefined;
	const live = !disabled && (href !== undefined || onSelect !== undefined);
	const leading = lead === undefined ? null : leadOf(lead);
	const text = typeof title === 'string' ? title : undefined;
	const name = (
		<span className="truncate text-label font-medium text-fg" {...(text ? { title: text } : {})}>
			{title}
		</span>
	);
	return (
		<div
			data-ss-row=""
			{...(selected ? { 'data-selected': '' } : {})}
			{...(button ? { role: 'button', tabIndex: disabled ? -1 : 0 } : {})}
			{...(disabled ? { 'aria-disabled': true } : {})}
			{...box}
			onClick={
				live
					? (event) => {
							const target = /** @type {HTMLElement | null} */ (event.target);
							if (target?.closest('a, button, input, select, textarea')) return;
							onSelect?.();
						}
					: undefined
			}
			onKeyDown={
				button && live
					? (event) => {
							if (event.target !== event.currentTarget) return;
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								onSelect?.();
							}
						}
					: undefined
			}
			className={cx(
				'ss-motion relative flex w-full min-w-0 items-center gap-3 rounded-control px-2.5 text-left',
				LIST.row,
				live && 'ss-press cursor-pointer',
				button
					? 'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus'
					: 'has-[a:focus-visible]:outline-2 has-[a:focus-visible]:-outline-offset-2 has-[a:focus-visible]:outline-focus',
				selected
					? 'border border-line bg-surface ss-hard group-data-[ss-slide]/list:border-transparent group-data-[ss-slide]/list:bg-transparent group-data-[ss-slide]/list:shadow-none'
					: live && 'hover:bg-surface-2',
				disabled && 'cursor-not-allowed opacity-50',
				className,
			)}>
			{leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-1.5">
					{href && !disabled ? (
						<LinkTag
							href={href}
							className="flex min-w-0 outline-none after:absolute after:inset-0 after:content-['']"
							{...(selected ? { 'aria-current': 'page' } : {})}>
							{name}
						</LinkTag>
					) : (
						name
					)}
					{changed ? (
						<span
							data-ss-changed=""
							className="shrink-0 rounded-full bg-attention-soft px-1.5 text-micro font-medium text-on-attention-soft">
							{texts?.changed ?? UNSAVED_TEXTS.changed}
						</span>
					) : null}
					{status ? (
						<span className="flex shrink-0 items-center" title={status.label}>
							<span aria-hidden="true" className={cx('size-2 rounded-full', DOTS[DOT_TONES[status.tone]])} />
							<span className="sr-only">{status.label}</span>
						</span>
					) : null}
				</div>
				{warning ? (
					<p className={cx('truncate text-micro', tone)} data-ss-warning="">
						{warning.text}
					</p>
				) : metaItems.length > 0 ? (
					<p className={cx('truncate text-micro', tone)}>
						{metaItems.map((item, idx) => (
							<Fragment key={idx}>
								{idx > 0 ? ' · ' : null}
								{item}
							</Fragment>
						))}
					</p>
				) : null}
			</div>
			{value !== undefined || time !== undefined ? (
				<div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
					{value !== undefined && value !== null ? (
						<span className="text-label font-medium text-fg tabular-nums">{value}</span>
					) : null}
					{time !== undefined && time !== null ? <span className="text-micro text-muted tabular-nums">{time}</span> : null}
				</div>
			) : null}
			{trailing ? (
				<div
					data-ss-row-trailing=""
					className="relative z-10 flex shrink-0 items-center"
					onClick={(event) => event.stopPropagation()}
					onKeyDown={(event) => event.stopPropagation()}>
					{trailing}
				</div>
			) : null}
		</div>
	);
}
