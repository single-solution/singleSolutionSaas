import { defineUnitConfig } from '@ss/config/vitest';

export default defineUnitConfig({
	dir: import.meta.dirname,
	include: ['tests/**/*.test.js'],
	coverageInclude: ['{core,headless,ui,api,adapters,jobs}/**'],
	// app-kit wiring (the product and its route table) runs in the deployed app, not in unit tests
	coverageExclude: ['adapters/platform.js', 'api/routes.js'],
});
