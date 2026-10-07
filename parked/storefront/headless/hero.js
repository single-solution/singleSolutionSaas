/**
 * Mode B core of `hero`: headline and calls to action (copy from the string catalog, per language), media
 * candidates, layout and reserved height. Which media this visitor gets is decided by `chooseMedia` with what the
 * browser reports (Save-Data, connection type, reduced motion, viewport): the renderer passes that in.
 */
import { chooseMedia, heroConfig } from '../core/media.js';
import { createCore, emitter, ok } from './kit.js';

export { chooseMedia };

/** @param {import('./kit.js').Options} [options] */
export const createHero = (options = {}) => {
	const hero = heroConfig(options.config ?? {});
	const emit = emitter(options.emit);
	const core = createCore({ ...hero, playing: false }, options);
	return core.expose({
		/** @param {'primary' | 'secondary'} which */
		follow: async (which) => {
			emit('action', { action: which === 'secondary' ? 'secondary_cta' : 'cta' });
			return ok(which === 'secondary' ? hero.secondary : hero.cta);
		},
		/** The visitor paused or resumed the background video. @param {boolean} playing */
		setPlaying: async (playing) => {
			core.set({ playing: playing === true });
			return ok(playing === true);
		},
	});
};
