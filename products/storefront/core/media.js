/**
 * Hero media policy (ported from the proven storefront hero): images always; a background video only when the
 * visitor's conditions allow it. Save-Data, slow connections (configurable effective types), reduced motion and
 * narrow viewports keep the poster (or the image) instead, so the video is never downloaded there.
 */
import { bool, int, isObject, oneOf, safeUrl, strings } from './util.js';

/** Hero heights (reserved before media loads: no layout shift). */
export const HEIGHTS = Object.freeze(/** @type {const} */ (['sm', 'md', 'lg']));
/** Hero layouts. */
export const LAYOUTS = Object.freeze(/** @type {const} */ (['overlay', 'split', 'centered']));
const SLOW = Object.freeze(['slow-2g', '2g', '3g']);

/**
 * @param {Record<string, unknown>} config
 */
export const heroConfig = (config) => {
	const image = isObject(config.image) ? config.image : {};
	const video = isObject(config.video) ? config.video : {};
	return {
		layout: oneOf(config.layout, LAYOUTS, 'overlay'),
		height: oneOf(config.height, HEIGHTS, 'md'),
		cta: safeUrl(config.cta_href),
		secondary: safeUrl(config.secondary_href),
		image: {
			src: safeUrl(image.src, { src: true }),
			mobile: safeUrl(image.mobile_src, { src: true }),
			priority: bool(image.priority, true),
		},
		video: {
			src: safeUrl(video.src, { src: true }),
			poster: safeUrl(video.poster, { src: true }),
			autoplay: bool(video.autoplay, true),
			saveData: bool(video.respect_save_data, true),
			slow: Array.isArray(video.skip_connections) ? strings(video.skip_connections, 6, 20) : [...SLOW],
			minWidth: int(video.min_viewport_width, 0, 0, 4000),
		},
	};
};

/** @typedef {ReturnType<typeof heroConfig>} HeroConfig */

/**
 * @typedef {object} MediaEnv what the browser reports (unknown = allowed)
 * @property {boolean} [saveData]
 * @property {string} [effectiveType]
 * @property {boolean} [reducedMotion]
 * @property {number} [width] viewport width in CSS pixels
 */

/**
 * Decide the hero media for this visitor.
 * @param {HeroConfig} hero
 * @param {MediaEnv} env
 * @returns {{ video: string | null, poster: string | null, reason: 'video' | 'no_video' | 'save_data' | 'slow_connection' | 'reduced_motion' | 'viewport' | 'click' }}
 */
export const chooseMedia = (hero, env) => {
	const poster = hero.video.poster ?? hero.image.src;
	/** @param {'no_video' | 'save_data' | 'slow_connection' | 'reduced_motion' | 'viewport' | 'click'} reason */
	const still = (reason) => ({ video: null, poster, reason });
	if (!hero.video.src) return still('no_video');
	if (hero.video.saveData && env.saveData === true) return still('save_data');
	if (env.effectiveType && hero.video.slow.includes(env.effectiveType)) return still('slow_connection');
	if (env.reducedMotion === true) return still('reduced_motion');
	if (typeof env.width === 'number' && env.width < hero.video.minWidth) return still('viewport');
	if (!hero.video.autoplay) return still('click');
	return { video: hero.video.src, poster, reason: 'video' };
};
