/**
 * Mode A default renderer of the `payment_manual` element: a radio group of the payment methods with availability
 * reasons and surcharges, and the bank details when bank transfer is chosen. Design tokens only; keyboard operable.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-pay { color: var(--ss-color-text); font: var(--ss-font-body); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-md); padding: var(--ss-space-3); display: grid; gap: var(--ss-space-2); }
.ss-pay__method { display: flex; gap: var(--ss-space-2); align-items: baseline; }
.ss-pay__method--off { color: var(--ss-color-text-muted); }
.ss-pay__note, .ss-pay__status { color: var(--ss-color-text-muted); }
.ss-pay input:focus-visible { outline: 2px solid var(--ss-color-focus); }
`;

/**
 * @param {{ state: import('../headless/paymentManual.js').PaymentState, actions: { select: (key: string) => unknown },
 *   strings: Record<string, string>, theme?: Record<string, unknown>, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, slots = {}, dom }) => {
	const t = createTranslator(strings);
	return el(dom, 'fieldset', { class: 'ss-pay', role: 'radiogroup', 'aria-label': t('payment.title') }, [
		el(dom, 'legend', {}, [t('payment.title')]),
		slots.before ?? null,
		...state.methods.map((method) =>
			el(dom, 'label', { class: `ss-pay__method${method.available ? '' : ' ss-pay__method--off'}` }, [
				on(
					el(dom, 'input', {
						type: 'radio',
						name: 'paymentMethod',
						value: method.key,
						...(method.key === state.selected ? { checked: '' } : {}),
						...(method.available ? {} : { disabled: '' }),
					}),
					'change',
					() => actions.select(method.key),
				),
				el(dom, 'span', {}, [method.label]),
				method.surchargeText ? el(dom, 'span', { class: 'ss-pay__note' }, [method.surchargeText]) : null,
				method.reason ? el(dom, 'span', { class: 'ss-pay__note' }, [method.reason]) : null,
			]),
		),
		state.selected === 'bank_transfer' && state.bankDetails.length > 0
			? el(
					dom,
					'dl',
					{},
					state.bankDetails.flatMap((row) => [el(dom, 'dt', {}, [row.label]), el(dom, 'dd', {}, [row.value])]),
				)
			: null,
		statusLine(dom, 'ss-pay', state.error),
		slots.after ?? null,
	]);
};
