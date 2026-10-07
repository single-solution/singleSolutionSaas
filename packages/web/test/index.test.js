import { describe, expect, it } from 'vitest';
import * as web from '../src/index.js';

describe('@ss/web entry point', () => {
	it('exports only the widget and renderer helpers', () => {
		expect(Object.keys(web).sort()).toEqual(
			[
				'ATTRIBUTES',
				'CLIENT_PROBLEMS',
				'HTML_TAGS',
				'SVG_TAGS',
				'VISUALLY_HIDDEN',
				'button',
				'createApiClient',
				'createH',
				'createStore',
				'defineWidget',
				'err',
				'focusFirst',
				'focusables',
				'formatString',
				'h',
				'isResult',
				'liveRegion',
				'mountHeadless',
				'ok',
				'parseProblem',
				'prefersReducedMotion',
				'problem',
				'reserveSpace',
				'resolveStrings',
				'safeCssValue',
				'safeUrl',
				'saveFocus',
				'slot',
				'tokens',
				'trapFocus',
				'uniqueId',
			].sort(),
		);
	});
});
