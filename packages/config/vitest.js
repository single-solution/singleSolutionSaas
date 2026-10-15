/**
 * Shared Vitest preset. Every unit's `vitest.config.js` is one call:
 *
 *   import { defineUnitConfig } from '@ss/config/vitest';
 *   export default defineUnitConfig({ dir: import.meta.dirname, coverageInclude: ['src/**'], mongo: true });
 *
 * Coverage thresholds are the standard (90 % lines and functions, 85 % branches) for every unit; the test project is
 * named after the unit's folder.
 * @module
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Global setup that starts one MongoMemoryReplSet per run and exposes it as `TEST_MONGODB_URI`. */
const MONGO_SETUP = fileURLToPath(new URL('./mongo-setup.js', import.meta.url));

/** The coverage standard. */
const THRESHOLDS = Object.freeze({ lines: 90, functions: 90, branches: 85 });

/** Sources of `@ss/ui` (untranspiled JSX in `.js`), linked from the workspace or installed from the registry. */
const UI_SOURCES = /[\\/](?:packages[\\/]ui|node_modules[\\/]@ss[\\/]ui)[\\/]src[\\/][^\\/]+\.js$/;

/** @param {string} text */
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Regular expression matching `.js` files below the given folders of a unit.
 * @param {string} dir unit root (absolute)
 * @param {readonly string[]} folders relative to `dir`
 * @returns {RegExp}
 */
const folderPattern = (dir, folders) =>
	new RegExp(`^(?:${folders.map((folder) => escape(path.resolve(dir, folder) + path.sep)).join('|')}).*\\.js$`);

/**
 * @typedef {object} UnitOptions
 * @property {string} dir the unit's root (`import.meta.dirname` of its vitest.config.js)
 * @property {string[]} [include] test files (default `test/**\/*.test.js`)
 * @property {string[]} [coverageInclude] files measured for coverage (default `src/**`)
 * @property {string[]} [jsx] folders whose `.js` files contain JSX (relative to `dir`)
 * @property {boolean} [mongo] start the shared MongoMemoryReplSet (`TEST_MONGODB_URI`)
 */

/**
 * Vitest config of one unit.
 * @param {UnitOptions} options
 */
export const defineUnitConfig = ({
	dir,
	include = ['test/**/*.test.js'],
	coverageInclude = ['src/**'],
	jsx = [],
	mongo = false,
}) =>
	defineConfig({
		root: dir,
		// JSX in .js files: @ss/ui (wherever it is installed) and the unit's own component folders
		esbuild: {
			include: jsx.length > 0 ? [UI_SOURCES, folderPattern(dir, jsx)] : [UI_SOURCES],
			exclude: [],
			loader: 'jsx',
			jsx: 'automatic',
		},
		test: {
			name: path.basename(dir),
			include,
			environment: 'node',
			// @ss/ui ships JSX: transform it even when it comes from node_modules
			server: { deps: { inline: [/@ss[\\/]ui/] } },
			globalSetup: mongo ? [MONGO_SETUP] : [],
			hookTimeout: 60_000,
			testTimeout: 30_000,
			coverage: {
				provider: 'v8',
				include: coverageInclude,
				thresholds: { ...THRESHOLDS },
			},
		},
	});
