import { mergeConfig } from 'vitest/config';
import { defineUnitConfig } from '@ss/config/vitest';

/**
 * System tests, and the test product's own tests (`fixtures/notes/tests`, as `ss app init` writes them). No coverage
 * here: this workspace has no source of its own (each unit enforces its coverage in its own run).
 */
export default mergeConfig(
	defineUnitConfig({
		dir: import.meta.dirname,
		include: ['tests/**/*.test.js', 'fixtures/*/tests/**/*.test.js'],
		// the test product's dashboard (untranspiled JSX) and its dashboard test
		jsx: ['fixtures/notes/app', 'fixtures/notes/tests'],
		mongo: true,
	}),
	// All files run at once on one shared MongoMemoryReplSet: a setup that takes ~15 s alone went past 60 s under that
	// load (2026-10-20, ecommerce-orders and setup-sheet), so the system tests get more time than the units.
	{ test: { hookTimeout: 180_000, testTimeout: 90_000 } },
);
