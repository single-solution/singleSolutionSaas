import { defineUnitConfig } from '@ss/config/vitest';

export default defineUnitConfig({
	dir: import.meta.dirname,
	include: ['tests/**/*.test.js'],
	coverageInclude: ['{core,headless,ui,api,adapters}/**'],
	mongo: true,
});
