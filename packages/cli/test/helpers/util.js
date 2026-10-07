import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

/** @param {string} [prefix] */
export const tempDir = (prefix = 'ss-cli-') => mkdtemp(path.join(tmpdir(), prefix));

/** @param {string} dir */
export const removeDir = (dir) => rm(dir, { recursive: true, force: true });

/** Copy a project (without node_modules) to a new folder. @param {string} from @param {string} to */
export const copyProject = (from, to) =>
	cp(from, to, { recursive: true, filter: (source) => !source.split(path.sep).includes('node_modules') });

/** @param {string} dir @param {string} file @param {(text: string) => string} change */
export const edit = async (dir, file, change) =>
	writeFile(path.join(dir, file), change(await readFile(path.join(dir, file), 'utf8')));

/** Collecting io for main(). */
export const createIo = () => {
	const out = /** @type {string[]} */ ([]);
	const err = /** @type {string[]} */ ([]);
	return {
		io: { out: (/** @type {string} */ text) => void out.push(text), err: (/** @type {string} */ text) => void err.push(text) },
		out: () => out.join(''),
		err: () => err.join(''),
	};
};

/** @param {string} name */
const packageDir = (name) => path.dirname(require.resolve(`${name}/package.json`));

/** What a generated product's tests need, linked from this package's own dependencies instead of installed. */
const TEST_PACKAGES = Object.freeze([
	'@ss/app-kit',
	'@ss/config',
	'@ss/contracts',
	'vitest',
	'@vitest/coverage-v8',
	'mongodb',
	'mongodb-memory-server',
]);

/** @param {string} dir */
export const linkTestPackages = async (dir) => {
	for (const name of TEST_PACKAGES) {
		await mkdir(path.dirname(path.join(dir, 'node_modules', name)), { recursive: true });
		await symlink(packageDir(name), path.join(dir, 'node_modules', name), 'dir');
	}
};

/**
 * Run a generated product's own test suite (`vitest run --coverage` with its own vitest.config.js, thresholds
 * included). Rejects when a test fails or coverage is below the thresholds.
 * @param {string} dir
 */
export const runOwnTests = async (dir) => {
	const env = {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				([name]) => !name.startsWith('VITEST') && name !== 'FORCE_COLOR' && name !== 'NODE_V8_COVERAGE',
			),
		),
		NO_COLOR: '1',
	};
	const { stdout } = await run(
		process.execPath,
		[path.join(packageDir('vitest'), 'vitest.mjs'), 'run', '--coverage', '--coverage.reporter=text-summary'],
		{ cwd: dir, env },
	);
	return stdout;
};
