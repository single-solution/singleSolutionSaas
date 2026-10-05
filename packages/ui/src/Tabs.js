'use client';
/**
 * Tabs. `Tabs` is the WAI-ARIA tabs pattern (roving tab index; Arrow keys, Home and End move between tabs; panels
 * are labelled by their tab). `TabNav` is a navigation bar of links styled the same (one URL per tab).
 * @module
 */
import { useId, useRef, useState } from 'react';
import { cx } from './cx.js';

/** @typedef {{ id: string, label: import('react').ReactNode, content?: import('react').ReactNode, badge?: import('react').ReactNode }} TabItem */

const TAB =
	'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ' +
	'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
const ACTIVE = 'bg-surface text-fg shadow-card';
const IDLE = 'text-muted hover:text-fg';

/**
 * @param {{ tabs: TabItem[], value?: string, defaultValue?: string, onChange?: (id: string) => void, label: string,
 *   className?: string }} props
 */
export function Tabs({ tabs, value, defaultValue, onChange, label, className }) {
	const [inner, setInner] = useState(defaultValue ?? tabs[0]?.id ?? '');
	const current = value ?? inner;
	const base = useId();
	const refs = useRef(/** @type {Record<string, HTMLButtonElement | null>} */ ({}));
	/** @param {string} id */
	const select = (id) => {
		if (value === undefined) setInner(id);
		onChange?.(id);
	};
	/** @param {import('react').KeyboardEvent<HTMLDivElement>} event */
	const onKeyDown = (event) => {
		const index = tabs.findIndex((t) => t.id === current);
		/** @type {number | null} */
		let next = null;
		if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
		else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = tabs.length - 1;
		if (next === null) return;
		event.preventDefault();
		const tab = /** @type {TabItem} */ (tabs[next]);
		select(tab.id);
		refs.current[tab.id]?.focus();
	};
	const active = tabs.find((t) => t.id === current) ?? tabs[0];
	return (
		<div className={cx('space-y-4', className)}>
			<div
				role="tablist"
				aria-label={label}
				onKeyDown={onKeyDown}
				className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-line bg-surface-2 p-1">
				{tabs.map((tab) => {
					const selected = tab.id === active?.id;
					return (
						<button
							key={tab.id}
							ref={(el) => {
								refs.current[tab.id] = el;
							}}
							type="button"
							role="tab"
							id={`${base}-tab-${tab.id}`}
							aria-selected={selected}
							aria-controls={`${base}-panel-${tab.id}`}
							tabIndex={selected ? 0 : -1}
							onClick={() => select(tab.id)}
							className={cx(TAB, selected ? ACTIVE : IDLE)}>
							{tab.label}
							{tab.badge}
						</button>
					);
				})}
			</div>
			{active ? (
				<div role="tabpanel" id={`${base}-panel-${active.id}`} aria-labelledby={`${base}-tab-${active.id}`} tabIndex={0}>
					{active.content}
				</div>
			) : null}
		</div>
	);
}

/**
 * Navigation tabs (links). `current` is the active item's href.
 * @param {{ items: Array<{ href: string, label: import('react').ReactNode }>, current: string, label: string,
 *   linkAs?: import('react').ElementType, className?: string }} props
 */
export function TabNav({ items, current, label, linkAs, className }) {
	const LinkTag = linkAs ?? 'a';
	return (
		<nav aria-label={label} className={className}>
			<ul className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-line bg-surface-2 p-1">
				{items.map((item) => {
					const selected = item.href === current;
					return (
						<li key={item.href}>
							<LinkTag
								href={item.href}
								aria-current={selected ? 'page' : undefined}
								className={cx(TAB, 'block', selected ? ACTIVE : IDLE)}>
								{item.label}
							</LinkTag>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
