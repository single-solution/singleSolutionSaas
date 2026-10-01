import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { NOTES_SAMPLE_FILES, checkInitOptions, fill, initApp } from '../src/init.js';
import { validateProject } from '../src/validate/index.js';
import { exists } from '../src/fsutil.js';
import { removeDir, tempDir } from './helpers/util.js';

const run = promisify(execFile);
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
			'jobs/purge-deleted.js',
			'strings/en.json',
			'schemas/notes.features.json',
			'schemas/events/order_notes.note_created@1.json',
			'tests/api.test.js',
			'app/.well-known/ss-register/route.js',
			'app/.well-known/ss-events/route.js',
			'app/.well-known/ss-app.json/route.js',
			'app/api/v1/[...route]/route.js',
			'app/dashboard/page.js',
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
		expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(['dev', 'test', 'validate', 'certify']));
		expect(JSON.parse(await readFile(path.join(dir, 'vercel.json'), 'utf8')).crons).toEqual([]);
		const env = await readFile(path.join(dir, '.env.example'), 'utf8');
		for (const name of [
			'SS_PORTAL_URL',
			'SS_APP_ID',
			'SS_APP_SIGNING_KEY',
			'SS_REGISTRATION_TOKEN_HASH',
			'SS_PRODUCT_DB_URI',
			'SS_LOG_LEVEL',
		])
			expect(env).toContain(`${name}=`);
		expect(await readFile(path.join(dir, 'app/_lib/product.js'), 'utf8')).toContain('toNextRoute');
		expect(await readFile(path.join(dir, 'app/api/v1/[...route]/route.js'), 'utf8')).toContain("forward('POST')");
		expect(files).toContain('serve.js');
		expect(files).not.toContain('api/probes.js');
		expect(await readFile(path.join(dir, 'api/routes.js'), 'utf8')).not.toContain('{{');

		const report = await validateProject(dir);
		expect(report.problems).toEqual([]);

		const { stdout } = await run(
			process.execPath,
			['--test', 'tests/core.test.js', 'tests/headless.test.js', 'tests/ui.test.js', 'tests/api.test.js'],
			{ cwd: dir },
		);
		expect(stdout).toMatch(/fail 0/);
	}, 30_000);

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
		const { stdout } = await run(process.execPath, ['--test', 'tests/status.test.js'], { cwd: dir });
		expect(stdout).toMatch(/fail 0/);
	}, 30_000);

	it('generates an element pack that validates and whose own tests pass', async () => {
		const dir = path.join(root, 'pack');
		const { files } = await initApp({ dir, kind: 'pack', slug: 'sticky', name: 'Sticky Notes' });
		expect(files).not.toContain('api/routes.js');
		expect(files).not.toContain('openapi.json');
		const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
		expect(manifest.endpoints).toBeUndefined();
		expect(manifest.elements[0].modes).toEqual(['A', 'B']);
		expect((await validateProject(dir)).ok).toBe(true);
		const { stdout } = await run(
			process.execPath,
			['--test', 'tests/core.test.js', 'tests/headless.test.js', 'tests/ui.test.js'],
			{ cwd: dir },
		);
		expect(stdout).toMatch(/fail 0/);
	}, 30_000);

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
