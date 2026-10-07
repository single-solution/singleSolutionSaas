/**
 * Mode A default renderer of the `variants` element: one group per option with `buttons` (pressed state, unavailable
 * values marked but selectable — the core lands on the closest variant) or `selects`, then price, compare-at price and
 * availability of the selected variant. Design tokens only; keyboard operable.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-variants { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-variants-min-height, 4rem); }
.ss-variants__group { border: 0; margin: 0 0 var(--ss-space-2); padding: 0; }
.ss-variants__value { border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); background: var(--ss-color-surface);
  color: var(--ss-color-text); margin: 0 var(--ss-space-1) var(--ss-space-1) 0; padding: var(--ss-space-1) var(--ss-space-2); }
.ss-variants__value[aria-pressed="true"] { border-color: var(--ss-color-primary); outline: 1px solid var(--ss-color-primary); }
.ss-variants__value--unavailable { color: var(--ss-color-text-muted); text-decoration: line-through; }
.ss-variants__value:focus-visible, .ss-variants select:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-variants__price { font-weight: var(--ss-font-weight-bold, 700); }
.ss-variants__compare { color: var(--ss-color-text-muted); text-decoration: line-through; margin-inline-start: var(--ss-space-1); }
.ss-variants__status { color: var(--ss-color-text-muted); }
`;

/**
 * @param {{ state: import('../headless/variants.js').PickerState, actions: { select: (key: string, value: string) => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'selects' ? 'selects' : 'buttons';
	const groups = state.options.map((option) => {
		if (variant === 'selects')
			return el(dom, 'label', { class: 'ss-variants__group' }, [
				el(dom, 'span', {}, [option.label]),
				on(
					el(
						dom,
						'select',
						{ 'aria-label': option.label },
						option.values.map((v) =>
							el(dom, 'option', { value: v.value, ...(v.selected ? { selected: 'selected' } : {}) }, [
								v.available ? v.label : t('catalog.variants.unavailable_value', { value: v.label }),
							]),
						),
					),
					'change',
					(event) => actions.select(option.key, event.target.value),
				),
			]);
		return el(dom, 'fieldset', { class: 'ss-variants__group' }, [
			el(dom, 'legend', {}, [option.label]),
			...option.values.map((v) =>
				on(
					el(
						dom,
						'button',
						{
							type: 'button',
							class: `ss-variants__value${v.available ? '' : ' ss-variants__value--unavailable'}`,
							'aria-pressed': String(v.selected),
							...(v.available ? {} : { 'aria-description': t('catalog.variants.unavailable') }),
						},
						[v.label],
					),
					'click',
					() => actions.select(option.key, v.value),
				),
			),
		]);
	});
	return el(
		dom,
		'div',
		{
			class: `ss-variants ss-variants--${variant}`,
			role: 'group',
			'aria-label': t('catalog.variants.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[
			slots.before ?? null,
			...groups,
			el(dom, 'p', {}, [
				state.priceText ? el(dom, 'span', { class: 'ss-variants__price' }, [state.priceText]) : null,
				state.compareText ? el(dom, 'span', { class: 'ss-variants__compare' }, [state.compareText]) : null,
			]),
			el(
				dom,
				'p',
				{ class: 'ss-variants__status', role: 'status', 'aria-live': 'polite' },
				state.availabilityText ? [state.availabilityText] : [],
			),
			statusLine(dom, 'ss-variants', state.error),
			slots.after ?? null,
		],
	);
};
