/**
 * Orchestration only: `pnpm test:all` (`vitest run`) runs every unit's own vitest.config.js as a Vitest project in
 * one go, sharing one MongoMemoryReplSet (the @ss/config Mongo setup is reference-counted across projects). Coverage
 * thresholds are enforced per unit by each unit's own `pnpm test`.
 */
import { defineConfig } from 'vitest/config';
import { THRESHOLDS } from '@ss/config/vitest';

export default defineConfig({
	test: {
		projects: [
			'packages/*/vitest.config.js',
			'platform/vitest.config.js',
			'products/*/vitest.config.js',
			// left out of root checks until it is rebuilt as Chat (PLAN 0.12 steps 4–8)
			'!products/chatbot/vitest.config.js',
			'e2e/vitest.config.js',
		],
		coverage: {
			provider: 'v8',
			include: [
				'packages/*/src/**',
				'packages/config/{eslint,vitest,mongo-setup}.js',
				'platform/src/**',
				'products/*/{core,ui,api,adapters}/**',
			],
			thresholds: { ...THRESHOLDS },
		},
	},
});
