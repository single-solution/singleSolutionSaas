/**
 * Mode A renderer of `theme`: writes the design tokens on the page root through the CSSOM (`style.setProperty`,
 * allowed under a strict CSP), loads the web font with the `FontFace` API, and renders a hidden marker node. Servers
 * that can should inline `themeCss` (headless/theme.js) in the page head instead: no flash before the Loader runs.
 */
import { el, memo, reduced, setVars, windowOf } from './dom.js';

/**
 * @param {{ state: ReturnType<ReturnType<typeof import('../headless/theme.js').createTheme>['state']>,
 *   actions: ReturnType<typeof import('../headless/theme.js').createTheme>['actions'], dom: import('./dom.js').DomLike,
 *   reducedMotion?: boolean }} props
 */
export const render = ({ state, actions, dom, reducedMotion }) => {
	const win = windowOf(dom);
	const local = memo(actions);
	const vars = reduced(win, reducedMotion) ? state.reducedVars : state.vars;
	if (dom.documentElement) setVars(dom.documentElement, Object.fromEntries(vars));
	if (state.font && !local.font && typeof win?.FontFace === 'function' && /** @type {any} */ (dom).fonts?.add) {
		local.font = true;
		const face = new win.FontFace(state.font.family, `url(${JSON.stringify(state.font.url)}) format("woff2")`, {
			display: 'swap',
		});
		/** @type {any} */ (dom).fonts.add(face);
		face.load().catch(() => undefined);
	}
	return el(dom, 'div', { class: 'ss-theme', hidden: true, 'data-ss-theme': String(vars.length) });
};

export const styles = '';
