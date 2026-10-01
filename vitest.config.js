import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['packages/*/test/**/*.test.js', 'platform/test/**/*.test.js'],
		environment: 'node',
		hookTimeout: 60000,
		testTimeout: 30000,
		coverage: {
			provider: 'v8',
			include: ['packages/*/src/**', 'platform/src/**'],
			thresholds: { lines: 90, functions: 90, branches: 85 },
		},
	},
});
