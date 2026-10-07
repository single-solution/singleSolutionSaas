/**
 * Mode A default renderer of the `place_order` element: the server's totals and the place-order button (disabled while
 * placing, so it cannot double-submit; retries reuse the same Idempotency-Key anyway). Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-place { color: var(--ss-color-text); font: var(--ss-font-body); display: grid; gap: var(--ss-space-2); min-height: var(--ss-place-min-height, 4rem); }
.ss-place__rows { margin: 0; display: grid; grid-template-columns: 1fr auto; gap: var(--ss-space-1); }
.ss-place__total { font-weight: var(--ss-font-weight-bold, 700); }
.ss-place__button { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border: 0; border-radius: var(--ss-radius-sm); padding: var(--ss-space-2) var(--ss-space-4); font: inherit; cursor: pointer; }
.ss-place__button:focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-place__status { color: var(--ss-color-danger); }
`;

/**
 * @param {{ state: import('../headless/placeOrder.js').PlaceState, actions: { place: (body?: any) => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string }, slots?: Record<string, any>, dom: import('./dom.js').DomLike, body?: () => Record<string, unknown> }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom, body = () => ({}) }) => {
	const t = createTranslator(strings);
	const rows =
		theme.variant === 'button'
			? null
			: el(dom, 'dl', { class: 'ss-place__rows' }, [
					...state.rows.flatMap((row) => [el(dom, 'dt', {}, [row.label]), el(dom, 'dd', {}, [row.amount])]),
					...(state.totalText
						? [
								el(dom, 'dt', { class: 'ss-place__total' }, [t('place_order.total')]),
								el(dom, 'dd', { class: 'ss-place__total' }, [state.totalText]),
							]
						: []),
				]);
	const busy = state.status === 'placing';
	const button = on(
		el(
			dom,
			'button',
			{ type: 'button', class: 'ss-place__button', ...(busy || state.status === 'placed' ? { disabled: '' } : {}) },
			[busy ? t('place_order.placing') : t('place_order.place')],
		),
		'click',
		() => actions.place(body()),
	);
	return el(
		dom,
		'section',
		{ class: 'ss-place', role: 'region', 'aria-label': t('place_order.title'), 'aria-busy': String(busy) },
		[slots.before ?? null, rows, button, statusLine(dom, 'ss-place', state.error), slots.after ?? null],
	);
};
