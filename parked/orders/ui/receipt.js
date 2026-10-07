/**
 * Mode A default renderer of the `invoices` element: a `button` that loads the customer's receipt, or the receipt
 * `inline`, shown in a sandboxed frame (no script, no same-origin) with a print button. Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-receipt { color: var(--ss-color-text); font: var(--ss-font-body); min-height: var(--ss-receipt-min-height, 2.5rem); }
.ss-receipt__button { background: var(--ss-color-primary); border: 0; border-radius: var(--ss-radius-sm); color: var(--ss-color-on-primary); padding: var(--ss-space-1) var(--ss-space-3); }
.ss-receipt__button:focus-visible { outline: 2px solid var(--ss-color-focus); }
.ss-receipt__frame { border: 1px solid var(--ss-color-border); height: var(--ss-receipt-height, 32rem); width: 100%; }
`;

/**
 * @param {{ state: import('../headless/receipt.js').ReceiptState, actions: { load: (id: string) => unknown },
 *   strings: Record<string, string>, theme?: { variant?: string, orderId?: string }, slots?: Record<string, any>,
 *   dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, actions, strings, theme = {}, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const variant = theme.variant === 'inline' ? 'inline' : 'button';
	const frame =
		state.html !== null
			? el(dom, 'iframe', {
					class: 'ss-receipt__frame',
					title: state.title ?? t('receipt.title'),
					sandbox: 'allow-modals',
					srcdoc: state.html,
				})
			: null;
	return el(
		dom,
		'section',
		{
			class: `ss-receipt ss-receipt--${variant}`,
			role: 'region',
			'aria-label': t('receipt.title'),
			'aria-busy': String(state.status === 'loading'),
		},
		[
			slots.before ?? null,
			state.html === null && theme.orderId
				? on(el(dom, 'button', { type: 'button', class: 'ss-receipt__button' }, [t('receipt.show')]), 'click', () =>
						actions.load(/** @type {string} */ (theme.orderId)),
					)
				: null,
			frame,
			frame
				? on(el(dom, 'button', { type: 'button', class: 'ss-receipt__button' }, [t('receipt.print')]), 'click', () => {
						try {
							frame.contentWindow?.print?.();
						} catch {
							// a sandboxed frame may refuse; the browser's own print still works
						}
					})
				: null,
			statusLine(dom, 'ss-receipt', state.error),
			slots.after ?? null,
		],
	);
};
