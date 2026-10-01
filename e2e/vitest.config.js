import { defineUnitConfig } from '@ss/config/vitest';

/** System tests: no source of their own to measure (each unit enforces its coverage in its own run). */
export default defineUnitConfig({
	dir: import.meta.dirname,
	include: ['tests/**/*.test.js'],
	coverageInclude: [],
	mongo: true,
});
