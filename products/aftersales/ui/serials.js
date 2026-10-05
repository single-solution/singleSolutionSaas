/**
 * Mode A default renderer of the `serial_registry` element: the public warranty lookup (a labelled search form and the
 * result). Pure function of (state, actions, strings, theme, slots) building DOM through the injected `dom`; design
 * tokens only; announces results politely.
 */
import { createTranslator } from '../headless/strings.js';
import { day, el } from './dom.js';

/** @typedef {import('../headless/serials.js').SerialState} SerialState */

/** Token-only stylesheet. */
export const styles = `
.ss-serials { color: var(--ss-color-text); background: var(--ss-color-surface); border-radius: var(--ss-radius-md);
  font: var(--ss-font-body); padding: var(--ss-space-3); min-height: var(--ss-serials-min-height, 4rem); }
.ss-serials__active { color: var(--ss-color-success); }
.ss-serials__ended, .ss-serials__meta { color: var(--ss-color-text-muted); }
.ss-serials__error { color: var(--ss-color-danger); }
.ss-serials button { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border-radius: var(--ss-radius-sm); }
.ss-serials button:focus-visible, .ss-serials input:focus-visible { outline: 2px solid var(--ss-color-focus); }
`;

/**
 * @param {{ state: SerialState, actions: { setSerial: (serial: string) => unknown, lookup: () => unknown },
 *   strings: Record<string, string>, theme?: Record<string, unknown>, slots?: Record<string, any>,
 *   dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const result = state.result;
	return el(dom, 'section', { class: 'ss-serials', role: 'search', 'aria-label': t('serials.title') }, [
		slots.before ?? null,
		el(
			dom,
			'form',
			{
				onsubmit: (/** @type {any} */ event) => {
					event?.preventDefault?.();
					void actions.lookup();
				},
			},
			[
				el(dom, 'label', { for: 'ss-serials-input' }, [t('serials.label')]),
				el(dom, 'input', {
					id: 'ss-serials-input',
					value: state.serial,
					autocomplete: 'off',
					oninput: (/** @type {any} */ event) => actions.setSerial(String(event?.target?.value ?? '')),
				}),
				el(dom, 'button', { type: 'submit', ...(state.status === 'loading' ? { 'aria-disabled': 'true' } : {}) }, [
					t('serials.lookup'),
				]),
			],
		),
		el(
			dom,
			'div',
			{ role: 'status', 'aria-live': 'polite' },
			state.status === 'found' && result
				? [
						el(dom, 'h3', {}, [result.title ?? result.serial]),
						result.soldAt
							? el(dom, 'p', { class: 'ss-serials__meta' }, [t('serials.sold_on', { date: day(result.soldAt) })])
							: null,
						el(
							dom,
							'ul',
							{},
							state.cover.map((entry) =>
								el(dom, 'li', { class: entry.active ? 'ss-serials__active' : 'ss-serials__ended' }, [entry.text]),
							),
						),
					]
				: state.error
					? [el(dom, 'p', { class: 'ss-serials__error' }, [state.error])]
					: [],
		),
		slots.after ?? null,
	]);
};
