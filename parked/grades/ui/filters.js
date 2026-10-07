/**
 * Mode A default renderer of the `filters` element: tier toggle buttons (aria-pressed) with item counts and a clear
 * button. Variants: `chips` (inline toggles) and `list` (a vertical group for sidebars). The website's listing reacts
 * to the headless `filters.changed` event or reads the matching item ids.
 */
import { createTranslator } from '../headless/strings.js';
import { el, paint, statusLine } from './dom.js';

/** Token-only stylesheet; the Loader adopts it once per page (CSP-safe). */
export const styles = `
.ss-grades-badge__dot { width: 0.5em; height: 0.5em; border-radius: 50%; background: var(--ss-grades-tier, var(--ss-color-primary)); }
.ss-grades-muted { color: var(--ss-color-text-muted); }
.ss-grades-error { color: var(--ss-color-danger); }
.ss-grades-filters { color: var(--ss-color-text); font: var(--ss-font-body); border: 0; margin: 0; padding: 0; min-height: var(--ss-grades-filters-min-height, 2rem); }
.ss-grades-filters__options { display: flex; flex-wrap: wrap; gap: var(--ss-space-1); }
.ss-grades-filters--list .ss-grades-filters__options { flex-direction: column; align-items: flex-start; }
.ss-grades-filters__option { display: inline-flex; align-items: center; gap: var(--ss-space-1); background: var(--ss-color-surface);
  color: var(--ss-color-text); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); padding: var(--ss-space-1) var(--ss-space-2); cursor: pointer; }
.ss-grades-filters__option[aria-pressed="true"] { border-color: var(--ss-grades-tier, var(--ss-color-primary));
  background: color-mix(in srgb, var(--ss-grades-tier, var(--ss-color-primary)) 14%, var(--ss-color-surface)); font-weight: var(--ss-font-weight-bold, 700); }
.ss-grades-filters__option:focus-visible, .ss-grades-filters__clear:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-grades-filters__clear { background: none; border: 0; color: var(--ss-color-primary); text-decoration: underline; cursor: pointer; }
@media (prefers-reduced-motion: reduce) { .ss-grades-filters * { transition: none; } }
`;

/**
 * @param {{ state: import('../headless/filters.js').FiltersState, actions: { toggle: (key: string) => unknown, clear: () => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'list' ? 'list' : 'chips';
	const options = state.options.map((option) => {
		const button = paint(
			el(
				dom,
				'button',
				{
					type: 'button',
					class: 'ss-grades-filters__option',
					'aria-pressed': String(option.selected),
					'data-tier': option.key,
				},
				[
					el(dom, 'span', { class: 'ss-grades-badge__dot', 'aria-hidden': 'true' }),
					option.label,
					option.countText === null ? null : el(dom, 'span', { class: 'ss-grades-muted' }, [`(${option.countText})`]),
				],
			),
			option.color,
		);
		button.addEventListener('click', () => actions.toggle(option.key));
		return button;
	});
	const clear =
		state.selected.length > 0
			? el(dom, 'button', { type: 'button', class: 'ss-grades-filters__clear' }, [t('filters.clear')])
			: null;
	clear?.addEventListener('click', () => actions.clear());
	return el(
		dom,
		'fieldset',
		{ class: `ss-grades-filters ss-grades-filters--${variant}`, 'aria-busy': String(state.status === 'loading') },
		[
			el(dom, 'legend', {}, [t('filters.title')]),
			slots.before ?? null,
			options.length > 0
				? el(dom, 'div', { class: 'ss-grades-filters__options', role: 'group', 'aria-label': t('filters.title') }, options)
				: (slots.empty ?? el(dom, 'p', { class: 'ss-grades-muted' }, [t('filters.empty')])),
			clear,
			statusLine(dom, state.error),
			slots.after ?? null,
		],
	);
};
