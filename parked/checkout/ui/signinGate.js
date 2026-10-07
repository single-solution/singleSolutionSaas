/**
 * Mode A default renderer of the `signin_gate` element: a banner asking the shopper to sign in (link to the website's
 * sign-in page with the way back) when the checkout needs an identity. Design tokens only.
 */
import { createTranslator } from '../headless/strings.js';
import { el, statusLine } from './dom.js';

/** Token-only stylesheet. */
export const styles = `
.ss-gate { color: var(--ss-color-text); background: var(--ss-color-surface); font: var(--ss-font-body); border: 1px solid var(--ss-color-border); border-radius: var(--ss-radius-md); padding: var(--ss-space-3); }
.ss-gate a { color: var(--ss-color-primary); }
.ss-gate a:focus-visible { outline: 2px solid var(--ss-color-focus); outline-offset: 2px; }
.ss-gate__status { color: var(--ss-color-text-muted); }
`;

/**
 * @param {{ state: import('../headless/signinGate.js').GateState, actions?: Record<string, unknown>,
 *   strings: Record<string, string>, theme?: Record<string, unknown>, slots?: Record<string, any>, dom: import('./dom.js').DomLike }} params
 */
export const render = ({ state, strings, slots = {}, dom }) => {
	const t = createTranslator(strings);
	const prompt = state.required && !state.signedIn;
	return el(dom, 'section', { class: 'ss-gate', role: 'region', 'aria-label': t('signin.title') }, [
		slots.before ?? null,
		statusLine(dom, 'ss-gate', state.message),
		prompt && state.signinUrl ? el(dom, 'a', { href: state.signinUrl }, [t('signin.link')]) : null,
		slots.after ?? null,
	]);
};
