/**
 * Shared Vitest preset. Every unit's `vitest.config.js` is one call:
 *
 *   import { defineUnitConfig } from '@ss/config/vitest';
 *   export default defineUnitConfig({ dir: import.meta.dirname, coverageInclude: ['src/**'], mongo: true });
 *
 * Coverage thresholds are the standard (90 % lines and functions, 85 % branches) for every unit.
 * @module
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Global setup that starts one MongoMemoryReplSet per run and exposes it as `TEST_MONGODB_URI`. */
export const MONGO_SETUP = fileURLToPath(new URL('./mongo-setup.js', import.meta.url));

/** The coverage standard. */
export const THRESHOLDS = Object.freeze({ lines: 90, functions: 90, branches: 85 });

/** Sources of `@ss/ui` (untranspiled JSX in `.js`), linked from the workspace or installed from the registry. */
export const UI_SOURCES = /[\\/](?:packages[\\/]ui|node_modules[\\/]@ss[\\/]ui)[\\/]src[\\/][^\\/]+\.js$/;

/** @param {string} text */
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Regular expression matching `.js` files below the given folders of a unit.
 * @param {string} dir unit root (absolute)
 * @param {readonly string[]} folders relative to `dir`
 * @returns {RegExp}
 */
export const folderPattern = (dir, folders) =>
	new RegExp(`^(?:${folders.map((folder) => escape(path.resolve(dir, folder) + path.sep)).join('|')}).*\\.js$`);

/**
 * @typedef {object} UnitOptions
 * @property {string} dir the unit's root (`import.meta.dirname` of its vitest.config.js)
 * @property {string} [name] project name (default: the folder name)
 * @property {string[]} [include] test files (default `test/**\/*.test.js`)
 * @property {string[]} [coverageInclude] files measured for coverage (default `src/**`)
 * @property {string[]} [coverageExclude]
 * @property {string[]} [jsx] folders whose `.js` files contain JSX (relative to `dir`)
 * @property {boolean} [mongo] start the shared MongoMemoryReplSet (`TEST_MONGODB_URI`)
 * @property {{ lines: number, functions: number, branches: number }} [thresholds]
 */

/**
 * Vitest config of one unit.
 * @param {UnitOptions} options
 */
export const defineUnitConfig = ({
	dir,
	name = path.basename(dir),
	include = ['test/**/*.test.js'],
	coverageInclude = ['src/**'],
	coverageExclude = [],
	jsx = [],
	mongo = false,
	thresholds = THRESHOLDS,
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
			name,
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
				exclude: coverageExclude,
				thresholds: { ...thresholds },
			},
		},
	});
