/**
 * Mode A default renderer of the `loyalty_redeem` element: the balance, a points field bounded by the Loyalty product's
 * minimum and maximum, a "use the most" button and the value the points take off. Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-points { color: var(--ss-color-text); font: var(--ss-font-body); display: grid; gap: var(--ss-space-2); }
.ss-points input { font: inherit; color: inherit; width: 8rem; border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); padding: var(--ss-space-2); background: var(--ss-color-surface); }
.ss-points button { background: none; border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-sm); color: inherit; font: inherit; cursor: pointer; }
.ss-points :focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-points__status { color: var(--ss-color-text-muted); }
`;

/**
 * @param {{ state: import('../headless/loyaltyRedeem.js').LoyaltyState, actions: { setPoints: (n: number) => unknown, useMax: () => unknown },
 *   strings: Record<string, string>, theme?: Record<string, unknown>, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const ready = state.status === 'ready';
	return el(dom, 'section', { class: 'ss-points', role: 'region', 'aria-label': t('loyalty.title') }, [
		slots.before ?? null,
		ready
			? el(dom, 'label', { for: 'ss-points-input' }, [t('loyalty.points', { min: state.minPoints, max: state.maxPoints })])
			: null,
		ready
			? on(
					el(dom, 'input', {
						id: 'ss-points-input',
						type: 'number',
						inputmode: 'numeric',
						min: '0',
						max: String(state.maxPoints),
						step: '1',
						value: String(state.points),
					}),
					'change',
					(event) => actions.setPoints(Number(event.target?.value ?? 0)),
				)
			: null,
		ready ? on(el(dom, 'button', { type: 'button' }, [t('loyalty.use_max')]), 'click', () => actions.useMax()) : null,
		state.valueText ? el(dom, 'p', {}, [t('loyalty.value', { amount: state.valueText })]) : null,
		statusLine(dom, 'ss-points', state.message),
		slots.after ?? null,
	]);
};
