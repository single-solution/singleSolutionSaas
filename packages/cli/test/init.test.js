import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkInitOptions, fill, globalNameOf, initApp, insideWorkspace } from '../src/init.js';
import { validateProject } from '../src/validate/index.js';
import { exists } from '../src/fsutil.js';
import { linkTestPackages, removeDir, runOwnTests, tempDir } from './helpers/util.js';

/** @type {string} */
let root;
beforeAll(async () => {
	root = await tempDir('ss-init-');
});
afterAll(async () => {
	await removeDir(root);
});

/** @param {string} dir @param {string} file */
const read = (dir, file) => readFile(path.join(dir, file), 'utf8');
/** @param {string} dir @param {string} file */
const json = async (dir, file) => JSON.parse(await read(dir, file));

describe('ss app init → validate → own tests (integration)', () => {
	it('generates the 0.4.13 layout that validates and whose own tests pass with the coverage thresholds', async () => {
		const dir = path.join(root, 'notes');
		const { files } = await initApp({ dir, id: 'order-notes', name: 'Order Notes', sdkVersion: '^0.2.0' });
		for (const file of [
			'manifest.json',
			'openapi.json',
			'package.json',
			'README.md',
			'.env.example',
			'.env.local',
			'.gitignore',
			'.prettierignore',
			'vercel.json',
			'next.config.js',
			'postcss.config.mjs',
			'eslint.config.js',
			'tsconfig.json',
			'vitest.config.js',
			'pnpm-workspace.yaml',
			'.nvmrc',
			'core/notes.js',
			'core/widgets.js',
			'api/routes.js',
			'api/docs.js',
			'api/widget-script.js',
			'adapters/product.js',
			'adapters/notes-store.js',
			'ui/entry.js',
			'ui/widget.js',
			'ui/note-form.js',
			'ui/inbox.js',
			'app/api/[...path]/route.js',
			'app/dashboard/page.js',
			'app/dashboard/tabs.js',
			'app/dashboard/texts.js',
			'app/layout.js',
			'strings/en.json',
			'schemas/notes.settings.json',
			'docs/guide.json',
			'tests/api.test.js',
			'tests/ui.test.js',
			'tests/core.test.js',
		])
			expect(files).toContain(file);
		for (const file of files) expect(await read(dir, file), file).not.toMatch(/\{\{[A-Za-z]+\}\}/);
		expect(files.filter((file) => /(?:^|\/)(?:headless|jobs|cron)\//.test(file))).toEqual([]);

		const manifest = await json(dir, 'manifest.json');
		expect(Object.keys(manifest).sort()).toEqual(
			['docsUrl', 'endpoints', 'features', 'id', 'name', 'permissions', 'version', 'widgetScriptUrl', 'widgets'].sort(),
		);
		expect(manifest).toMatchObject({
			id: 'order-notes',
			name: 'Order Notes',
			endpoints: { base: 'http://localhost:3000', dashboard: '/dashboard' },
			widgetScriptUrl: '/widget.js',
			docsUrl: '/docs',
			permissions: [{ key: 'notes.read', feature: 'notes' }],
		});
		expect(manifest.widgets.map((/** @type {{ kind: string }} */ widget) => widget.kind)).toEqual(['visitor', 'admin']);

		const pkg = await json(dir, 'package.json');
		expect(pkg).toMatchObject({ name: '@ss/product-order-notes', private: true, license: 'UNLICENSED' });
		expect(pkg.exports).toEqual({
			'./product': './adapters/product.js',
			'./routes': './api/routes.js',
			'./package.json': './package.json',
		});
		expect(Object.keys(pkg.scripts).sort()).toEqual(
			['build', 'check', 'dev', 'format', 'format:check', 'lint', 'start', 'test', 'typecheck', 'validate'].sort(),
		);
		expect(pkg.dependencies).toMatchObject({ '@ss/app-kit': '^0.2.0', '@ss/ui': '^0.2.0' });
		expect(pkg.devDependencies).toMatchObject({ '@ss/cli': '^0.2.0', '@ss/config': '^0.2.0' });

		const env = await read(dir, '.env.example');
		expect(env.split('\n').filter((line) => /^[A-Z_]+=/.test(line))).toEqual([
			'MONGODB_URI=',
			'CONNECT_SECRET=',
			'ENCRYPTION_KEY=',
		]);
		expect(await read(dir, '.env.local')).toMatch(/^MONGODB_URI=\nCONNECT_SECRET=[\w-]{43}\nENCRYPTION_KEY=[\w-]{43}\n$/);
		const ignored = (await read(dir, '.gitignore')).split('\n');
		for (const line of ['.env*', '**/.env*', '!.env.example', '!**/.env.example']) expect(ignored).toContain(line);
		expect((await json(dir, 'vercel.json')).crons).toBeUndefined();
		expect(await read(dir, 'vitest.config.js')).toContain("from '@ss/config/vitest'");
		expect((await json(dir, 'tsconfig.json')).extends).toBe('@ss/config/tsconfig.base.json');
		expect(await read(dir, 'next.config.js')).toContain("'/widget.js', '/docs', '/v1/:path*'");
		expect(await read(dir, 'core/widgets.js')).toContain("WIDGET_GLOBAL = 'SSOrderNotes'");
		expect(await read(dir, 'core/widgets.js')).toContain("WIDGET_ATTRIBUTE = 'data-ss-order-notes'");
		expect(await read(dir, 'api/widget-script.js')).toContain('export const WIDGET_SCRIPT = ');
		const openapi = await json(dir, 'openapi.json');
		expect(Object.keys(openapi.paths)).toEqual([
			'/v1/admin/notes',
			'/v1/data-rights/delete',
			'/v1/data-rights/export',
			'/v1/notes',
			'/v1/tickets',
		]);
		expect(openapi.paths['/v1/admin/notes'].get).toMatchObject({ 'x-ss-auth': 'ticket', 'x-ss-feature': 'notes' });

		expect((await validateProject(dir)).problems).toEqual([]);
		await linkTestPackages(dir);
		// installed, the kit resolves from the project itself and the bundle is the same
		expect((await validateProject(dir)).problems).toEqual([]);
		const stdout = await runOwnTests(dir);
		for (const file of ['core', 'api', 'ui']) expect(stdout).toContain(`tests/${file}.test.js`);
		expect(stdout).toMatch(/Tests\s+\d+ passed/);
	}, 120_000);

	it('inside a pnpm workspace leaves the repository files to the workspace and links @ss/* with workspace:^', async () => {
		const workspace = path.join(root, 'monorepo');
		await mkdir(path.join(workspace, 'products'), { recursive: true });
		await writeFile(path.join(workspace, 'pnpm-workspace.yaml'), "packages:\n   - 'products/*'\n");
		expect(await insideWorkspace(path.join(workspace, 'products'))).toBe(true);
		expect(await insideWorkspace(root)).toBe(false);
		const dir = path.join(workspace, 'products', 'inner');
		const { files } = await initApp({ dir, id: 'inner', name: 'Inner', baseUrl: 'https://inner.example.com' });
		expect(files).not.toContain('pnpm-workspace.yaml');
		expect(files).not.toContain('.nvmrc');
		expect((await json(dir, 'package.json')).dependencies['@ss/app-kit']).toBe('workspace:^');
		expect((await json(dir, 'manifest.json')).endpoints.base).toBe('https://inner.example.com');
		const forced = await initApp({ dir: path.join(workspace, 'products', 'own'), id: 'own', name: 'Own', standalone: true });
		expect(forced.files).toContain('pnpm-workspace.yaml');
	}, 60_000);

	it('refuses bad options and non-empty targets', async () => {
		expect(checkInitOptions({ dir: 'x', id: 'notes', name: 'Notes' })).toEqual([]);
		expect(checkInitOptions({ id: 'Bad Id', name: '' })).toHaveLength(3);
		expect(checkInitOptions({ dir: 'x', id: 'ok', name: 'a {{b}}' })).toEqual([expect.stringMatching(/must not contain/)]);
		expect(checkInitOptions({ dir: 'x', id: 'ok', name: 'x'.repeat(81) })).toEqual([expect.stringMatching(/1–80/)]);
		for (const baseUrl of ['http://example.com', 'https://example.com/path', 'nope', 'https://u:p@example.com'])
			expect(checkInitOptions({ dir: 'x', id: 'ok', name: 'Ok', baseUrl }), baseUrl).toEqual([
				expect.stringMatching(/--base-url/),
			]);
		for (const baseUrl of ['https://notes.example.com', 'http://127.0.0.1:4000', 'http://app.localhost', 'http://[::1]:3000'])
			expect(checkInitOptions({ dir: 'x', id: 'ok', name: 'Ok', baseUrl }), baseUrl).toEqual([]);
		await expect(initApp({ dir: path.join(root, 'bad'), id: '-', name: 'x' })).rejects.toMatchObject({
			code: 'invalid_options',
		});
		const full = path.join(root, 'full');
		await mkdir(full, { recursive: true });
		await writeFile(path.join(full, 'keep.txt'), 'x');
		await expect(initApp({ dir: full, id: 'full', name: 'Full' })).rejects.toMatchObject({ code: 'not_empty' });
		expect(await exists(path.join(full, 'manifest.json'))).toBe(false);
		await expect(initApp({ dir: path.join(full, 'keep.txt', 'x'), id: 'full', name: 'Full' })).rejects.toMatchObject({
			code: 'ENOTDIR',
		});
		expect(fill('{{id}} {{unknown}}', { id: 's' })).toBe('s {{unknown}}');
		expect(globalNameOf('chat')).toBe('SSChat');
		expect(globalNameOf('order--notes')).toBe('SSOrderNotes');
	});
});
