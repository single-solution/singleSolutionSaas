/**
 * Mode A default renderer of the `payment_gateway` element (preview): a pay button and the payment status. The host
 * follows `state.redirectUrl` (the renderer only offers it as a link — no script navigation). Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, on, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-gw { color: var(--ss-color-text); font: var(--ss-font-body); display: grid; gap: var(--ss-space-2); }
.ss-gw__button, .ss-gw__link { background: var(--ss-color-primary); color: var(--ss-color-on-primary); border: 0; border-radius: var(--ss-radius-sm); padding: var(--ss-space-2) var(--ss-space-4); font: inherit; cursor: pointer; text-decoration: none; }
.ss-gw__button:focus-visible, .ss-gw__link:focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-gw__status { color: var(--ss-color-text-muted); }
`;

/**
 * @param {{ state: import('../headless/paymentGateway.js').GatewayState, actions: { start: (returnUrl: string) => unknown },
 *   strings: Record<string, string>, theme?: Record<string, unknown>, slots?: Record<string, any>, dom: import('./dom.js').DomLike, returnUrl?: string }} params
 */
export const render = ({ state, actions, strings, slots = {}, dom, returnUrl = '' }) => {
	const t = createTranslator(strings);
	const action =
		state.status === 'redirect' && state.redirectUrl
			? el(dom, 'a', { class: 'ss-gw__link', href: state.redirectUrl }, [t('gateway.continue')])
			: state.status === 'paid'
				? null
				: on(
						el(
							dom,
							'button',
							{ type: 'button', class: 'ss-gw__button', ...(state.status === 'starting' ? { disabled: '' } : {}) },
							[t('gateway.pay')],
						),
						'click',
						() => actions.start(returnUrl),
					);
	return el(dom, 'section', { class: 'ss-gw', role: 'region', 'aria-label': t('gateway.title') }, [
		slots.before ?? null,
		action,
		statusLine(dom, 'ss-gw', state.error ?? state.message),
		slots.after ?? null,
	]);
};
