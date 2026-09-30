import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['packages/*/test/**/*.test.js'],
		environment: 'node',
		coverage: { provider: 'v8', include: ['packages/*/src/**'], thresholds: { lines: 90, functions: 90, branches: 85 } },
	},
});
