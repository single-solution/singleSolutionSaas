/**
 * Mode B core of `theme`: the website's design tokens as CSS custom properties (`--ss-*`) — for every visitor and for
 * visitors who ask for reduced motion — and the web font to load. `themeCss` is the same output as one `:root{…}` rule for servers that inline it in the page
 * head, which avoids any flash before the Loader runs.
 */
import { fontOf, themeCss, themeVars } from '../core/theme.js';
import { createCore } from './kit.js';

export { themeCss, themeVars };

/** @param {import('./kit.js').Options} [options] */
export const createTheme = (options = {}) => {
	const config = options.config ?? {};
	const core = createCore(
		{ vars: themeVars(config), reducedVars: themeVars(config, { reducedMotion: true }), font: fontOf(config) },
		options,
	);
	return core.expose({});
};
