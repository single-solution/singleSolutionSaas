/**
 * Website design tokens → CSS custom properties (`--ss-*`), the one source every element renderer styles from.
 * The output is tiny: a list of `[name, value]` pairs, or the same as one `:root{…}` rule a server can inline in the
 * page head (no flash of untokened content). Values are checked: no declarations, blocks, escapes or resource loads.
 */
import { int, isObject, oneOf, safeUrl, str } from './util.js';

/** Colour tokens: config key → CSS variable suffix. */
export const COLOR_TOKENS = Object.freeze({
	primary: 'primary',
	on_primary: 'on-primary',
	text: 'text',
	text_muted: 'text-muted',
	surface: 'surface',
	surface_2: 'surface-2',
	border: 'border',
	focus: 'focus',
	danger: 'danger',
	success: 'success',
	accent: 'accent',
	on_accent: 'on-accent',
});
/** Motion settings. */
export const MOTION = Object.freeze(/** @type {const} */ (['full', 'reduced', 'none']));
const UNSAFE = /[;{}<>\\"'`]|url\s*\(|expression\s*\(|@import|javascript:/i;

/**
 * A CSS value from configuration, or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export const cssValue = (value) => {
	const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : str(value, '', 120);
	return text === '' || UNSAFE.test(text) ? null : text;
};

/**
 * @param {Record<string, unknown>} config
 * @param {{ reducedMotion?: boolean }} [env]
 * @returns {Array<[string, string]>}
 */
export const themeVars = (config, { reducedMotion = false } = {}) => {
	/** @type {Array<[string, string]>} */
	const out = [];
	/** @param {string} name @param {unknown} value */
	const add = (name, value) => {
		const css = cssValue(value);
		if (css !== null) out.push([`--ss-${name}`, css]);
	};
	const colors = isObject(config.colors) ? config.colors : {};
	for (const [key, name] of Object.entries(COLOR_TOKENS)) add(`color-${name}`, colors[key]);
	const fonts = isObject(config.fonts) ? config.fonts : {};
	add('font-body', fonts.body);
	add('font-heading', fonts.heading || fonts.body);
	add('font-weight-bold', fonts.weight_bold);
	const radius = isObject(config.radius) ? config.radius : {};
	for (const size of ['sm', 'md', 'lg', 'full']) add(`radius-${size}`, radius[size]);
	const unit = int(config.space_unit, 4, 1, 16);
	for (const step of [1, 2, 3, 4, 6, 8]) add(`space-${step}`, `${unit * step}px`);
	const shadows = isObject(config.shadows) ? config.shadows : {};
	add('shadow-md', shadows.md);
	add('shadow-lg', shadows.lg);
	const motion = oneOf(config.motion, MOTION, 'full');
	const duration = motion === 'none' || (motion === 'reduced' && reducedMotion) ? 0 : int(config.motion_ms, 200, 0, 2000);
	add('motion-duration', `${motion === 'reduced' && !reducedMotion ? Math.round(duration / 2) : duration}ms`);
	add('motion-easing', config.motion_easing);
	return out;
};

/**
 * The tokens as one rule (`:root{--ss-color-primary:…;…}`) for server-side inlining.
 * @param {Record<string, unknown>} config
 * @param {string} [selector]
 */
export const themeCss = (config, selector = ':root') =>
	`${selector}{${themeVars(config)
		.map(([name, value]) => `${name}:${value}`)
		.join(';')}}`;

/**
 * Web font to load (https woff2 only) with its family name.
 * @param {Record<string, unknown>} config
 * @returns {{ family: string, url: string } | null}
 */
export const fontOf = (config) => {
	const fonts = isObject(config.fonts) ? config.fonts : {};
	const url = safeUrl(fonts.url, { src: true });
	const family = str(fonts.family, '', 60);
	return url && url.startsWith('https://') && /\.woff2(\?|$)/.test(url) && /^[\w -]+$/.test(family) ? { family, url } : null;
};
