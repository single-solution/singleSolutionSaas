import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { NOTES_SAMPLE_FILES, checkInitOptions, fill, initApp, insideWorkspace } from '../src/init.js';
import { validateProject } from '../src/validate/index.js';
import { exists } from '../src/fsutil.js';
import { removeDir, tempDir } from './helpers/util.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
/** @param {string} name */
const packageDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const VITEST = path.join(packageDir('vitest'), 'vitest.mjs');
/** The environment of this run without the outer Vitest's worker variables (and without colours). */
const childEnv = {
	...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITEST') && name !== 'FORCE_COLOR')),
	NO_COLOR: '1',
};

/**
 * Run a generated project's own test suite (`vitest run --coverage` with its own vitest.config.js, thresholds
 * included), with the tooling it needs (`@ss/config`, `@ss/app-kit`, vitest, the coverage provider) linked from this package's own
 * dev dependencies instead of installed.
 * @param {string} dir
 */
const runOwnTests = async (dir) => {
	await mkdir(path.join(dir, 'node_modules', '@ss'), { recursive: true });
	await mkdir(path.join(dir, 'node_modules', '@vitest'), { recursive: true });
	for (const name of ['@ss/config', '@ss/app-kit', 'vitest', '@vitest/coverage-v8'])
		await symlink(packageDir(name), path.join(dir, 'node_modules', name), 'dir');
	const { stdout } = await run(process.execPath, [VITEST, 'run', '--coverage', '--coverage.reporter=text-summary'], {
		cwd: dir,
		env: childEnv,
	});
	return stdout;
};
/** @type {string} */
let root;
beforeAll(async () => {
	root = await tempDir('ss-init-');
});
afterAll(async () => {
	await removeDir(root);
});

describe('ss app init → validate (integration)', () => {
	it('generates a service product that validates and whose own tests pass', async () => {
		const dir = path.join(root, 'svc');
		const { files } = await initApp({ dir, kind: 'service', slug: 'order-notes', name: 'Order Notes', sdkVersion: '^0.1.0' });
		for (const file of [
			'manifest.json',
			'openapi.json',
			'core/notes.js',
			'headless/notes.js',
			'ui/notes.js',
			'api/routes.js',
			'adapters/db.js',
			'jobs/README.md',
			'strings/en.json',
			'schemas/notes.features.json',
			'schemas/events/order_notes.note_created@1.json',
			'tests/api.test.js',
			'app/api/[...path]/route.js',
			'app/dashboard/[[...section]]/page.js',
			'app/_lib/assets.js',
			'vercel.json',
			'.env.example',
			'.gitignore',
			'README.md',
			'ss.dev.json',
		])
			expect(files).toContain(file);
		const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
		expect(manifest.product).toMatchObject({ slug: 'order-notes', name: 'Order Notes', kind: 'service' });
		expect(manifest.events.publishes).toEqual(['order_notes.note_created@1']);
		const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
		expect(pkg.dependencies['@ss/app-kit']).toBe('^0.1.0');
		expect(Object.keys(pkg.scripts)).toEqual(
			expect.arrayContaining(['dev', 'build', 'start', 'portal', 'check', 'test', 'lint', 'typecheck', 'format:check']),
		);
		expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(['validate', 'certify']));
		expect(pkg).toMatchObject({ private: true, license: 'UNLICENSED', prettier: '@ss/config/prettier.json' });
		expect(pkg.devDependencies).toMatchObject({ '@ss/cli': '^0.1.0', '@ss/config': '^0.1.0' });
		// self-sufficient: its own tooling config from @ss/config, and the repository files of a standalone project
		for (const file of [
			'eslint.config.js',
			'tsconfig.json',
			'vitest.config.js',
			'.prettierignore',
			'pnpm-workspace.yaml',
			'.nvmrc',
		])
			expect(files).toContain(file);
		expect(await readFile(path.join(dir, 'vitest.config.js'), 'utf8')).toContain("from '@ss/config/vitest'");
		expect(JSON.parse(await readFile(path.join(dir, 'tsconfig.json'), 'utf8')).extends).toBe('@ss/config/tsconfig.base.json');
		expect(JSON.parse(await readFile(path.join(dir, 'vercel.json'), 'utf8')).crons).toBeUndefined();
		expect(files.some((file) => file.startsWith('app/cron/'))).toBe(false);
		const env = await readFile(path.join(dir, '.env.example'), 'utf8');
		expect(env.split('\n').filter((line) => /^[A-Z_]+=/.test(line))).toEqual(['MONGODB_URI=', 'CONNECT_SECRET=']);
		expect(await readFile(path.join(dir, '.env.local'), 'utf8')).toMatch(/^MONGODB_URI=\nCONNECT_SECRET=[A-Za-z0-9_-]{43}\n$/);
		expect(env).not.toMatch(/\bSS_|LOG_LEVEL/);
		expect(await readFile(path.join(dir, 'app/_lib/product.js'), 'utf8')).toContain('toNextRoute');
		expect(await readFile(path.join(dir, 'app/api/[...path]/route.js'), 'utf8')).toContain("forward('POST')");
		expect(await readFile(path.join(dir, 'app/_lib/assets.js'), 'utf8')).toContain("'schemas/notes.features.json': feature0");
		expect(files).toContain('serve.js');
		expect(files).not.toContain('api/probes.js');
		expect(await readFile(path.join(dir, 'api/routes.js'), 'utf8')).not.toContain('{{');

		const report = await validateProject(dir);
		expect(report.problems).toEqual([]);

		const stdout = await runOwnTests(dir);
		for (const file of ['core', 'headless', 'ui', 'api', 'api-helpers']) expect(stdout).toContain(`tests/${file}.test.js`);
		expect(stdout).toMatch(/Tests\s+\d+ passed/);
	}, 60_000);

	it('--minimal generates a service product without the notes sample that validates and passes its tests', async () => {
		const dir = path.join(root, 'minimal');
		const { files } = await initApp({ dir, kind: 'service', slug: 'bare-app', name: 'Bare App', minimal: true });
		for (const file of NOTES_SAMPLE_FILES) expect(files).not.toContain(file.replace('{{namespace}}', 'bare_app'));
		expect(files.filter((file) => /notes?[._]/.test(file))).toEqual([]);
		for (const file of ['core/status.js', 'api/routes.js', 'adapters/privacy.js', 'tests/status.test.js', 'ui/README.md'])
			expect(files).toContain(file);
		const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
		expect(manifest.elements.map((/** @type {{ key: string }} */ element) => element.key)).toEqual(['status']);
		expect(manifest.product).toMatchObject({ slug: 'bare-app', kind: 'service' });
		const strings = JSON.parse(await readFile(path.join(dir, 'strings/en.json'), 'utf8'));
		expect(Object.keys(strings).every((key) => key.startsWith('dashboard.'))).toBe(true);
		const openapi = JSON.parse(await readFile(path.join(dir, 'openapi.json'), 'utf8'));
		expect(Object.keys(openapi.paths)).toEqual(['/v1/status']);
		for (const file of files) expect(await readFile(path.join(dir, file), 'utf8'), file).not.toMatch(/\{\{[A-Za-z]+\}\}/);

		const report = await validateProject(dir);
		expect(report.problems).toEqual([]);
		const stdout = await runOwnTests(dir);
		for (const file of ['status', 'api-helpers']) expect(stdout).toContain(`tests/${file}.test.js`);
		expect(stdout).toMatch(/Tests\s+\d+ passed/);
	}, 60_000);

	it('generates an element pack that validates and whose own tests pass', async () => {
		const dir = path.join(root, 'pack');
		const { files } = await initApp({ dir, kind: 'pack', slug: 'sticky', name: 'Sticky Notes' });
		expect(files).not.toContain('api/routes.js');
		expect(files).not.toContain('openapi.json');
		const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
		expect(manifest.endpoints).toBeUndefined();
		expect(manifest.elements[0].modes).toEqual(['A', 'B']);
		expect((await validateProject(dir)).ok).toBe(true);
		const stdout = await runOwnTests(dir);
		for (const file of ['core', 'headless', 'ui']) expect(stdout).toContain(`tests/${file}.test.js`);
		expect(stdout).toMatch(/Tests\s+\d+ passed/);
	}, 60_000);

	it('inside a pnpm workspace leaves the repository files to the workspace and links @ss/* with workspace:^', async () => {
		const workspace = path.join(root, 'monorepo');
		await mkdir(path.join(workspace, 'products'), { recursive: true });
		await writeFile(path.join(workspace, 'pnpm-workspace.yaml'), "packages:\n   - 'products/*'\n");
		expect(await insideWorkspace(path.join(workspace, 'products'))).toBe(true);
		expect(await insideWorkspace(root)).toBe(false);
		const dir = path.join(workspace, 'products', 'inner');
		const { files } = await initApp({ dir, kind: 'pack', slug: 'inner', name: 'Inner' });
		expect(files).not.toContain('pnpm-workspace.yaml');
		expect(files).not.toContain('.nvmrc');
		expect(files).toContain('eslint.config.js');
		const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
		expect(pkg.dependencies['@ss/contracts']).toBe('workspace:^');
		const forced = await initApp({
			dir: path.join(workspace, 'products', 'own'),
			kind: 'pack',
			slug: 'own',
			name: 'Own',
			standalone: true,
		});
		expect(forced.files).toContain('pnpm-workspace.yaml');
	});

	it('refuses bad options and non-empty targets', async () => {
		expect(checkInitOptions({ dir: 'x', kind: 'service', slug: 'ok-slug', name: 'Fine' })).toEqual([]);
		expect(checkInitOptions({ kind: /** @type {any} */ ('other'), slug: 'Bad Slug', name: '' })).toHaveLength(4);
		expect(checkInitOptions({ dir: 'x', kind: 'pack', slug: 'ok', name: 'a {{b}}' })).toEqual([
			expect.stringMatching(/must not contain/),
		]);
		await expect(initApp({ dir: path.join(root, 'bad'), kind: 'service', slug: '-', name: 'x' })).rejects.toMatchObject({
			code: 'invalid_options',
		});
		const full = path.join(root, 'full');
		await mkdir(full, { recursive: true });
		await writeFile(path.join(full, 'keep.txt'), 'x');
		await expect(initApp({ dir: full, kind: 'pack', slug: 'full', name: 'Full' })).rejects.toMatchObject({ code: 'not_empty' });
		expect(await exists(path.join(full, 'manifest.json'))).toBe(false);
		expect(fill('{{slug}} {{unknown}}', { slug: 's' })).toBe('s {{unknown}}');
		expect(checkInitOptions({ dir: 'x', kind: 'pack', slug: 'ok', name: 'Ok', minimal: true })).toEqual([
			expect.stringMatching(/--minimal is for service products/),
		]);
	});
});
