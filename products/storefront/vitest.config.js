import { defineUnitConfig } from '@ss/config/vitest';

export default defineUnitConfig({
	dir: import.meta.dirname,
	include: ['tests/**/*.test.js'],
	coverageInclude: ['{core,headless,ui}/**', 'pack.js'],
	// the built modules are the same code, bundled and minified (tests/pack.test.js exercises them)
	coverageExclude: ['headless/bundle/**', 'ui/bundle/**'],
});
