import { defineUnitConfig } from '@ss/config/vitest';

/**
 * System tests, and the test product's own tests (`fixtures/notes/tests`, as `ss app init` writes them): no source of
 * their own to measure (each unit enforces its coverage in its own run).
 */
export default defineUnitConfig({
	dir: import.meta.dirname,
	include: ['tests/**/*.test.js', 'fixtures/*/tests/**/*.test.js'],
	coverageInclude: [],
	mongo: true,
});
