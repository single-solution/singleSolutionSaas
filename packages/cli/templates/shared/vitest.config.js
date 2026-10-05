import { defineUnitConfig } from '@ss/config/vitest';

export default defineUnitConfig({
	dir: import.meta.dirname,
	include: ['tests/**/*.test.js'],
	coverageInclude: ['{core,headless,ui,api,adapters,jobs}/**'],
	// app-kit wiring (the server, the product and its route table) is exercised end to end by `ss certify`
	coverageExclude: ['serve.js', 'adapters/platform.js', 'adapters/privacy.js', 'api/routes.js'],
});
