import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.js';
import { boot } from '../src/loader.js';

describe('@ss/web entry point', () => {
	it('exports the public API', () => {
		for (const name of [
			'createClient',
			'defineElement',
			'mountHeadless',
			'createStore',
			'createElementApi',
			'ok',
			'err',
			'parseProblem',
			'h',
			'tokens',
			'slot',
			'reserveSpace',
			'prefersReducedMotion',
			'trapFocus',
			'liveRegion',
			'button',
			'matchPlacement',
			'boot',
			'createUseElement',
		])
			expect(typeof (/** @type {Record<string, unknown>} */ (sdk)[name]), name).not.toBe('undefined');
		expect(sdk).not.toHaveProperty('evaluateAudience'); // @ss/rules only via ./audience.js
	});

	it('boot tolerates a missing bundle', () => {
		const loader = boot(/** @type {any} */ ({ websiteId: 'web_x', env: 'test', window: null }));
		expect(loader.list()).toEqual([]);
		loader.destroy();
	});
});
