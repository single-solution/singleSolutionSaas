'use client';
/**
 * Colour theme switch: the OS setting by default (`prefers-color-scheme`, see theme.css), or a stored choice.
 * `ThemeToggle` is the System / Light / Dark switch of the console header; the choice is kept in `localStorage` (when
 * storage is blocked the OS setting applies) and applied before paint by `ThemeScript` (theme-script.js).
 * @module
 */
import { useEffect, useState } from 'react';
import { cx } from './cx.js';
import { Icon } from './icons.js';
import { THEME_STORAGE_KEY } from './theme-script.js';

/** @typedef {'system' | 'light' | 'dark'} ThemeChoice */

/** @type {ReadonlyArray<{ value: ThemeChoice, label: string, icon: import('./icons.js').IconName }>} */
const CHOICES = Object.freeze([
	{ value: 'system', label: 'System', icon: 'monitor' },
	{ value: 'light', label: 'Light', icon: 'sun' },
	{ value: 'dark', label: 'Dark', icon: 'moon' },
]);

/** @returns {ThemeChoice} */
const readThemeChoice = () => {
	try {
		const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
		return stored === 'light' || stored === 'dark' ? stored : 'system';
	} catch {
		return 'system';
	}
};

/**
 * Store and apply a choice (`system` clears both the stored value and `data-theme`).
 * @param {ThemeChoice} choice
 */
const applyThemeChoice = (choice) => {
	const root = document.documentElement;
	if (choice === 'system') root.removeAttribute('data-theme');
	else root.setAttribute('data-theme', choice);
	try {
		if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
		else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
	} catch {
		// storage blocked: the choice lasts for this page only
	}
};

/**
 * @param {{ className?: string }} props
 */
export function ThemeToggle({ className }) {
	const [choice, setChoice] = useState(/** @type {ThemeChoice} */ ('system'));
	useEffect(() => setChoice(readThemeChoice()), []);
	return (
		<div role="group" aria-label="Theme" className={cx('inline-flex rounded-xl bg-surface-2 p-0.5', className)}>
			{CHOICES.map((item) => (
				<button
					key={item.value}
					type="button"
					aria-pressed={choice === item.value}
					title={`${item.label} theme`}
					onClick={() => {
						applyThemeChoice(item.value);
						setChoice(item.value);
					}}
					className={cx(
						'ss-motion ss-press rounded-lg p-1.5 focus-visible:outline-2 focus-visible:outline-focus',
						choice === item.value ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg',
					)}>
					<Icon name={item.icon} size={14} />
					<span className="sr-only">{item.label}</span>
				</button>
			))}
		</div>
	);
}
