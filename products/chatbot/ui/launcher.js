/**
 * Mode A default renderer of the `launcher`: the floating (or tab-bar) chat button, built only on
 * headless/launcher.js with design tokens. Accessible name and `aria-expanded`, unread badge announced politely, pulse
 * only without reduced motion; position follows the reading direction. Variants: `round`, `pill`.
 * @module
 */
import { createTranslator } from '../headless/strings.js';
import { el } from './notes.js';

/** @typedef {import('../headless/launcher.js').LauncherState} LauncherState */

/** Token-only stylesheet. */
export const styles = `
.ss-launcher { position: fixed; inset-block-end: var(--ss-launcher-y, 20px); inset-inline-end: var(--ss-launcher-x, 20px);
  display: inline-flex; align-items: center; gap: var(--ss-space-2); border: 0; cursor: pointer;
  background: var(--ss-color-primary); color: var(--ss-color-on-primary); box-shadow: var(--ss-shadow-md);
  border-radius: var(--ss-radius-full, 999px); font: var(--ss-font-body); z-index: var(--ss-z-overlay, 2147483000); }
.ss-launcher--start { inset-inline-end: auto; inset-inline-start: var(--ss-launcher-x, 20px); }
.ss-launcher--tab { position: static; box-shadow: none; }
.ss-launcher--small { min-block-size: 44px; min-inline-size: 44px; }
.ss-launcher--medium { min-block-size: 56px; min-inline-size: 56px; }
.ss-launcher--large { min-block-size: 64px; min-inline-size: 64px; }
.ss-launcher--pill { padding-inline: var(--ss-space-3); }
.ss-launcher__icon { display: inline-flex; justify-content: center; inline-size: 1.5rem; }
.ss-launcher__avatar { inline-size: 2rem; block-size: 2rem; border-radius: 50%; object-fit: cover; }
.ss-launcher__badge { position: absolute; inset-block-start: -4px; inset-inline-end: -4px; min-inline-size: 1.25rem;
  padding: 0 var(--ss-space-1); border-radius: var(--ss-radius-full, 999px); background: var(--ss-color-danger);
  color: var(--ss-color-on-primary); font-size: var(--ss-font-size-xs, .75rem); text-align: center; }
.ss-launcher:focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 3px; }
@media (prefers-reduced-motion: no-preference) {
  .ss-launcher--pulse { animation: ss-launcher-pulse 2.4s ease-out 3; }
  @keyframes ss-launcher-pulse { 0% { box-shadow: 0 0 0 0 var(--ss-color-primary); } 100% { box-shadow: 0 0 0 14px transparent; } }
}
`;

/** @type {Readonly<Record<string, string>>} */
const ICONS = Object.freeze({ chat: '💬', help: '?', message: '✉' });

/**
 * @param {{ state: LauncherState, actions: { toggle: () => Promise<unknown> }, strings: Record<string, string>,
 *   theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./notes.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const pill = theme.variant === 'pill' || state.showLabel;
	const classes = [
		'ss-launcher',
		`ss-launcher--${state.size}`,
		...(pill ? ['ss-launcher--pill'] : []),
		...(state.position === 'bottom_start' ? ['ss-launcher--start'] : []),
		...(state.mobileTab ? ['ss-launcher--tab'] : []),
		...(state.pulse && !state.open && state.unread > 0 ? ['ss-launcher--pulse'] : []),
	];
	const icon =
		slots.icon ??
		(state.icon === 'avatar' && state.avatarUrl
			? el(dom, 'img', { class: 'ss-launcher__avatar', src: state.avatarUrl, alt: '' })
			: el(dom, 'span', { class: 'ss-launcher__icon', 'aria-hidden': 'true' }, [
					state.open ? '×' : (ICONS[state.icon] ?? '💬'),
				]));
	const button = el(
		dom,
		'button',
		{
			type: 'button',
			class: classes.join(' '),
			'aria-label': state.badge ? `${state.label} — ${t('launcher.unread', { count: state.unread })}` : state.label,
			'aria-expanded': String(state.open),
			'aria-haspopup': 'dialog',
		},
		[
			icon,
			pill ? (slots.label ?? el(dom, 'span', {}, [t('launcher.label')])) : null,
			state.badge ? el(dom, 'span', { class: 'ss-launcher__badge', 'aria-hidden': 'true' }, [state.badge]) : null,
		],
	);
	if (!state.visible) button.setAttribute('hidden', '');
	button.addEventListener('click', () => actions.toggle());
	return button;
};
