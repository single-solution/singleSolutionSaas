import { defineUnitConfig } from './vitest.js';

export default defineUnitConfig({
	dir: import.meta.dirname,
	coverageInclude: ['eslint.js', 'vitest.js', 'mongo-setup.js'],
	mongo: true,
});
