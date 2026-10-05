import { defineUnitConfig } from '@ss/config/vitest';

export default defineUnitConfig({
	dir: import.meta.dirname,
	include: ['tests/**/*.test.js'],
	coverageInclude: ['{core,headless,ui,api,adapters,jobs}/**'],
	// the plain node:http entry point is exercised end to end by `ss certify` (tests/certify.test.js)
	coverageExclude: ['serve.js'],
	mongo: true,
});
