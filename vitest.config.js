import { defineConfig } from 'vitest/config';

export default defineConfig({
	// JSX in .js files: the UI library, the console and their tests (everything else is plain JS)
	esbuild: {
		include: /(?:packages\/ui|platform\/src\/console|platform\/test\/console)\/.*\.js$/,
		exclude: [],
		loader: 'jsx',
		jsx: 'automatic',
	},
	test: {
		include: ['packages/*/test/**/*.test.js', 'platform/test/**/*.test.js', 'products/*/tests/**/*.test.js'],
		environment: 'node',
		// one MongoMemoryReplSet for the whole run (SS_TEST_MONGO_URI); platform test files get fresh databases
		globalSetup: ['platform/test/global-setup.js'],
		hookTimeout: 60000,
		testTimeout: 30000,
		coverage: {
			provider: 'v8',
			include: [
				'packages/*/src/**',
				'platform/src/**',
				'products/*/{core,headless,ui,api,adapters,jobs}/**',
				'products/*/serve.js',
			],
			thresholds: { lines: 90, functions: 90, branches: 85 },
		},
	},
});
