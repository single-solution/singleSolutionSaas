/**
 * Mode A default renderer of the `attributes` element: filter facets as checkbox groups with counts, in a `sidebar`
 * (stacked) or a `bar` (inline), and a "clear" button. Design tokens only; keyboard operable (native checkboxes).
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-filters { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-filters-min-height, 3rem); }
.ss-filters--bar { display: flex; flex-wrap: wrap; gap: var(--ss-space-3); }
.ss-filters__group { border: 0; margin: 0 0 var(--ss-space-2); padding: 0; }
.ss-filters__count, .ss-filters__status { color: var(--ss-color-text-muted); }
.ss-filters input:focus-visible, .ss-filters button:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-filters__clear { background: none; border: 0; color: var(--ss-color-primary); text-decoration: underline; }
`;

/**
 * @param {{ state: import('../headless/filters.js').FiltersState, actions: { toggle: (key: string, value: string) => unknown, clear: () => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'bar' ? 'bar' : 'sidebar';
	return el(
		dom,
		'div',
		{
			class: `ss-filters ss-filters--${variant}`,
			role: 'group',
			'aria-label': t('catalog.filters.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[
			slots.before ?? null,
			...state.facets.map((facet) =>
				el(dom, 'fieldset', { class: 'ss-filters__group' }, [
					el(dom, 'legend', {}, [facet.label]),
					...facet.values.map((v) =>
						el(dom, 'label', {}, [
							on(
								el(dom, 'input', { type: 'checkbox', value: v.value, ...(v.selected ? { checked: 'checked' } : {}) }),
								'change',
								() => actions.toggle(facet.key, v.value),
							),
							` ${v.label} `,
							el(dom, 'span', { class: 'ss-filters__count' }, [`(${v.count})`]),
						]),
					),
				]),
			),
			state.count > 0
				? on(
						el(dom, 'button', { type: 'button', class: 'ss-filters__clear' }, [
							t('catalog.filters.clear', { count: state.count }),
						]),
						'click',
						() => actions.clear(),
					)
				: null,
			statusLine(dom, 'ss-filters', state.error),
			slots.after ?? null,
		],
	);
};
