'use client';
/**
 * A compact actions menu (PLAN 0.6 "fewer levels"): an icon button — ⋯ by default — that opens a short list of actions
 * (`role="menu"`). Headers keep their one or two main actions as buttons and put the rest here, a destructive one last
 * in danger text. Opening focuses the first action; Arrow keys, Home and End move between the actions; Escape, Tab and
 * a click outside close the menu, and Escape returns focus to the button.
 * @module
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './Button.js';
import { cx } from './cx.js';
import { Icon } from './icons.js';

/**
 * @typedef {object} MenuItem
 * @property {string} label
 * @property {() => void} onSelect
 * @property {boolean} [disabled]
 * @property {string} [hint] shown under the item (why it is disabled)
 * @property {boolean} [danger] a destructive action (danger text; list it last)
 */

/**
 * @param {{ label: string, items: MenuItem[], icon?: import('./icons.js').IconName, size?: 'sm' | 'md',
 *   className?: string }} props `label`: the button's accessible name and the menu's label
 */
export function ActionMenu({ label, items, icon = 'more', size = 'sm', className }) {
	const [open, setOpen] = useState(false);
	const root = useRef(/** @type {HTMLDivElement | null} */ (null));
	const button = useRef(/** @type {HTMLButtonElement | null} */ (null));
	const id = useId();

	/** The enabled menu items, in order. */
	const enabled = () =>
		/** @type {HTMLButtonElement[]} */ ([...(root.current?.querySelectorAll('[role="menuitem"]') ?? [])]).filter(
			(el) => !el.disabled,
		);

	useEffect(() => {
		if (!open) return undefined;
		enabled()[0]?.focus();
		/** @param {MouseEvent} event */
		const outside = (event) => {
			if (root.current && !root.current.contains(/** @type {Node} */ (event.target))) setOpen(false);
		};
		/** @param {KeyboardEvent} event */
		const escape = (event) => {
			if (event.key !== 'Escape') return;
			setOpen(false);
			button.current?.focus();
		};
		document.addEventListener('mousedown', outside);
		document.addEventListener('keydown', escape);
		return () => {
			document.removeEventListener('mousedown', outside);
			document.removeEventListener('keydown', escape);
		};
	}, [open]);

	/** @param {import('react').KeyboardEvent<HTMLDivElement>} event */
	const onKeyDown = (event) => {
		if (event.key === 'Tab') {
			setOpen(false);
			return;
		}
		const list = enabled();
		if (list.length === 0) return;
		const index = list.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
		/** @type {number | null} */
		let next = null;
		if (event.key === 'ArrowDown') next = (index + 1) % list.length;
		else if (event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = list.length - 1;
		if (next === null) return;
		event.preventDefault();
		list[next]?.focus();
	};

	return (
		<div ref={root} className={cx('relative', className)} onKeyDown={open ? onKeyDown : undefined}>
			<Button
				ref={button}
				variant="secondary"
				size={size}
				aria-label={label}
				title={label}
				className={size === 'md' ? 'w-10 !px-0' : 'w-8 !px-0'}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => setOpen((o) => !o)}>
				<Icon name={icon} size={16} />
			</Button>
			{open ? (
				<div
					id={id}
					role="menu"
					aria-label={label}
					className="absolute right-0 z-40 mt-1.5 w-64 max-w-[calc(100vw-2rem)] space-y-0.5 rounded-2xl bg-surface p-1.5 shadow-pop">
					{items.map((item, index) => (
						<div key={item.label}>
							<button
								type="button"
								role="menuitem"
								disabled={item.disabled}
								aria-describedby={item.hint ? `${id}-${index}` : undefined}
								onClick={() => {
									setOpen(false);
									item.onSelect();
								}}
								className={cx(
									'block w-full rounded-xl px-3 py-2 text-left text-sm font-semibold hover:bg-surface-2 focus:bg-surface-2',
									'focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50',
									'disabled:hover:bg-transparent',
									item.danger ? 'text-danger' : 'text-fg',
								)}>
								{item.label}
							</button>
							{item.hint ? (
								<p id={`${id}-${index}`} className="px-3 pb-1.5 text-xs text-muted">
									{item.hint}
								</p>
							) : null}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
