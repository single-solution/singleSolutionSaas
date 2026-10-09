import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initApp } from '../src/init.js';
import { formatValidation, layerOf, packageOf, resolveImport, serverEntries, validateProject } from '../src/validate/index.js';
import { writeAssets } from '../src/assets.js';
import { renderOpenapi } from '../src/openapi.js';
import { projectFiles } from '../src/project.js';
import { loadManifest, resolvePointer } from '../src/manifest.js';
import { copyProject, edit, removeDir, tempDir } from './helpers/util.js';

/** @type {string} */
let root;
/** @type {string} */
let base;
let counter = 0;

beforeAll(async () => {
	root = await tempDir('ss-validate-');
	base = path.join(root, 'base');
	await initApp({ dir: base, id: 'demo', name: 'Demo' });
}, 60_000);
afterAll(async () => {
	await removeDir(root);
});

/** A fresh copy of the generated product. */
const project = async () => {
	counter += 1;
	const dir = path.join(root, `p${counter}`);
	await copyProject(base, dir);
	return dir;
};

/** @param {string} dir @param {string} file @param {string} text */
const put = async (dir, file, text) => {
	await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
	await writeFile(path.join(dir, file), text);
};

/** @param {import('../src/validate/index.js').ValidationReport} report */
const rules = (report) => report.problems.map((problem) => problem.rule);

/** @param {import('../src/validate/index.js').ValidationReport} report @param {string} rule */
const messages = (report, rule) => report.problems.filter((problem) => problem.rule === rule).map((problem) => problem.message);

describe('ss app validate', () => {
	it('accepts a freshly generated product', async () => {
		const report = await validateProject(await project());
		expect(report.problems).toEqual([]);
		expect(report).toMatchObject({ ok: true, summary: { errors: 0, warnings: 0 } });
		expect(formatValidation(report)).toContain('✔ valid (0 warnings');
	});

	it('reports missing folders and files', async () => {
		const dir = await project();
		await rm(path.join(dir, 'docs'), { recursive: true });
		await rm(path.join(dir, 'app/dashboard/page.js'));
		await rm(path.join(dir, '.env.example'));
		const report = await validateProject(dir);
		expect(report.problems.filter((p) => p.rule === 'anatomy.missing').map((p) => p.file)).toEqual([
			'.env.example',
			'app/dashboard/page.js',
			'docs/',
		]);
		expect(formatValidation(report)).toMatch(/✖ \d+ errors, 0 warnings/);
	});

	it('checks the manifest with @ss/contracts, $refs included', async () => {
		const dir = await project();
		await edit(dir, 'manifest.json', (text) =>
			text.replace('"feature": "notes", "kind": "admin"', '"feature": "nope", "kind": "admin"'),
		);
		await edit(dir, 'schemas/notes.settings.json', (text) => text.replace('"default": 500', '"default": "many"'));
		const report = await validateProject(dir);
		expect(rules(report).filter((rule) => rule.startsWith('manifest.')).length).toBeGreaterThanOrEqual(2);
		expect(report.ok).toBe(false);

		const missing = await project();
		await rm(path.join(missing, 'manifest.json'));
		expect(rules(await validateProject(missing))).toContain('manifest.read');
		const badRef = await project();
		await edit(badRef, 'manifest.json', (text) => text.replace('schemas/notes.settings.json', '../outside.json'));
		expect(rules(await validateProject(badRef))).toContain('manifest.ref');
	});

	it('checks routes against the manifest', async () => {
		const dir = await project();
		await put(
			dir,
			'server/extra.js',
			[
				"import { defineRoute } from '@ss/app-kit';",
				'export const extra = [',
				"\tdefineRoute({ method: 'GET', path: '/v1/a', auth: 'server', feature: 'nope', handler: () => 1 }),",
				"\tdefineRoute({ method: 'GET', path: '/v1/b', auth: 'ticket', permission: 'nope.read', handler: () => 1 }),",
				"\tdefineRoute({ method: 'GET', path: '/v1/c', auth: 'weird', handler: () => 1 }),",
				"\tdefineRoute({ method: 'GET', path: '/v1/d', auth: 'browser', handler: () => 1 }),",
				"\tdefineRoute({ method: 'GET', path: '/v1/g', auth: 'browser', feature: ['notes', 'nope'], handler: () => 1 }),",
				"\tdefineRoute({ method: 'GET', path: '/v1/h', auth: 'browser', feature: ['notes'], handler: () => 1 }),",
				"\tdefineRoute({ method: ['GET'], path: '/v1/i', auth: 'none', handler: () => 1 }),",
				"\tdefineRoute({ method: 'GET', path: `/v1/${'e'}`, auth: 'server', feature: 'notes', handler: () => 1 }),",
				"\tdefineRoute({ ...{ method: 'GET' }, path: '/v1/f', auth: 'none', handler: () => 1 }),",
				'\tdefineRoute({ handler: () => 1 }),',
				'];',
				'',
			].join('\n'),
		);
		const report = await validateProject(dir);
		expect(messages(report, 'routes.feature')).toEqual([
			"GET /v1/a: feature 'nope' is not in manifest.json",
			'GET /v1/d: every browser route belongs to one feature (set feature)',
			"GET /v1/g: feature 'nope' is not in manifest.json",
		]);
		expect(messages(report, 'routes.permission')).toEqual(["GET /v1/b: permission 'nope.read' is not in manifest.json"]);
		expect(messages(report, 'routes.auth')).toHaveLength(1);
		expect(messages(report, 'routes.dynamic')).toEqual([
			'write method as string literals so the route can be checked and documented',
			'write path as string literals so the route can be checked and documented',
			'write the route without spreads and method as string literals so the route can be checked and documented',
			'write method, path, auth as string literals so the route can be checked and documented',
		]);
		// the new routes are not in openapi.json yet
		expect(rules(report)).toContain('assets.openapi');

		const bare = await project();
		await edit(bare, 'server/routes.js', (text) =>
			text
				.replace("path: '/widget.js'", "path: '/script.js'")
				.replace("path: '/docs',\n\t\tauth: 'none'", "path: '/docs',\n\t\tauth: 'server'"),
		);
		const shape = await validateProject(bare);
		expect(rules(shape)).toEqual(expect.arrayContaining(['routes.widget-script', 'routes.docs', 'routes.feature']));
	});

	it('checks widget texts', async () => {
		const dir = await project();
		await put(dir, 'strings/de.json', '{}\n');
		await edit(dir, 'strings/en.json', (text) =>
			text.replace('"form.title": "Leave us a note"', '"form.title": "Leave {us a note", "bad key": "x", "form.count": 3'),
		);
		await edit(dir, 'ui/note-form.js', (text) => text.replace("t('form.submit')", "t('form.missing')"));
		const report = await validateProject(dir);
		expect(rules(report)).toEqual(
			expect.arrayContaining(['strings.file', 'strings.placeholders', 'strings.invalid', 'strings.unknown-key']),
		);
		expect(messages(report, 'strings.invalid')).toHaveLength(2);

		const broken = await project();
		await put(broken, 'strings/en.json', '{ nope');
		expect(rules(await validateProject(broken))).toContain('strings.invalid');
		const notObject = await project();
		await put(notObject, 'strings/en.json', '[]');
		expect(messages(await validateProject(notObject), 'strings.invalid')).toEqual(['texts must be a JSON object']);
		const none = await project();
		await rm(path.join(none, 'strings/en.json'));
		expect(rules(await validateProject(none))).not.toContain('strings.unknown-key');
	});

	it('checks .env.example and vercel.json', async () => {
		const dir = await project();
		await edit(dir, '.env.example', (text) => `${text}export PORTAL_URL=x\n`);
		await put(dir, 'vercel.json', JSON.stringify({ crons: [{ path: '/v1/x', schedule: '* * * * *' }] }));
		const report = await validateProject(dir);
		expect(messages(report, 'env.example')).toEqual([
			'must list exactly MONGODB_URI, CONNECT_SECRET, ENCRYPTION_KEY (found: MONGODB_URI, CONNECT_SECRET, ENCRYPTION_KEY, PORTAL_URL)',
		]);
		expect(rules(report)).toContain('vercel.crons');
		const empty = await project();
		await put(empty, '.env.example', '# nothing\n');
		await put(empty, 'vercel.json', '{ nope');
		const second = await validateProject(empty);
		expect(messages(second, 'env.example')[0]).toContain('found: none');
		expect(rules(second)).not.toContain('vercel.crons');
	});

	it('reports import direction, packages, unresolved and outside imports, and DOM globals in core/', async () => {
		const dir = await project();
		await edit(
			dir,
			'core/notes.js',
			(text) =>
				`import { element } from '../ui/dom.js';\nimport fs from 'node:fs';\nimport x from './missing.js';\nimport y from '../../outside.js';\nimport texts from '../strings/en.json' with { type: 'json' };\nexport const w = () => window.location;\n${text}`,
		);
		await edit(
			dir,
			'ui/dom.js',
			(text) => `import { createNotesStore } from '../adapters/notes-store.js';\nimport React from 'react';\n${text}`,
		);
		await edit(dir, 'adapters/notes-store.js', (text) => `import { createRoutes } from '../server/routes.js';\n${text}`);
		await edit(
			dir,
			'server/docs.js',
			(text) => `import Page from '../app/dashboard/page.js';\nimport lodash from 'lodash';\nimport fs from 'fs';\n${text}`,
		);
		await put(dir, 'app/globals.css', "@import 'tailwindcss';\n@import '../../outside.css';\n@import './local.css';\n");
		await put(dir, 'tests/extra.test.js', "import x from '../../elsewhere.js';\n");
		const report = await validateProject(dir);
		const byRule = (/** @type {string} */ rule) =>
			report.problems.filter((p) => p.rule === rule).map((p) => `${p.file}:${p.line}`);
		expect(byRule('imports.direction')).toEqual([
			'adapters/notes-store.js:1',
			'core/notes.js:1',
			'core/notes.js:5',
			'server/docs.js:1',
			'ui/dom.js:1',
		]);
		expect(byRule('imports.package')).toEqual(['core/notes.js:2', 'ui/dom.js:2']);
		expect(byRule('imports.unresolved')).toEqual(['core/notes.js:3']);
		expect(byRule('imports.outside')).toEqual(['app/globals.css:2', 'core/notes.js:4', 'tests/extra.test.js:1']);
		expect(byRule('core.dom')).toEqual(['core/notes.js:6']);
		expect(byRule('package.missing')).toEqual(['server/docs.js:2']);
		expect(messages(report, 'imports.direction')[0]).toMatch(/adapters\/ must not import from server\/.*JSON data/);
	});

	it('checks the package wiring', async () => {
		const dir = await project();
		await edit(dir, 'package.json', (text) => {
			const pkg = JSON.parse(text);
			delete pkg.dependencies['@ss/app-kit'];
			delete pkg.devDependencies['@ss/cli'];
			delete pkg.scripts.validate;
			return JSON.stringify(pkg);
		});
		const report = await validateProject(dir);
		expect(rules(report)).toEqual(expect.arrayContaining(['package.dependency', 'package.devDependency', 'package.script']));
		expect(report.problems.find((p) => p.rule === 'package.script')?.severity).toBe('warning');
		expect(messages(report, 'package.missing')[0]).toContain("'@ss/app-kit' is imported");

		const broken = await project();
		await put(broken, 'package.json', '{ nope');
		expect(rules(await validateProject(broken))).toContain('package.dependency');
		const none = await project();
		await rm(path.join(none, 'package.json'));
		expect(rules(await validateProject(none))).not.toContain('package.dependency');
	});

	it('checks the server shape', async () => {
		const dir = await project();
		await put(dir, 'app/other/route.js', 'export const GET = () => new Response();\n');
		await put(dir, 'app/[slug]/page.js', 'export default function Page() { return null; }\n');
		await put(dir, 'app/static/page.js', 'export default function Page() { return null; }\n');
		await put(dir, 'proxy.js', 'export const proxy = () => {};\n');
		await edit(dir, 'next.config.js', (text) =>
			text.replace('poweredByHeader: false,', 'poweredByHeader: false, outputFileTracingIncludes: {},'),
		);
		const files = await projectFiles(dir);
		expect(await serverEntries(files)).toEqual([
			'app/[slug]/page.js',
			'app/api/[...path]/route.js',
			'app/other/route.js',
			'proxy.js',
		]);
		const report = await validateProject(dir);
		expect(rules(report)).toEqual(expect.arrayContaining(['server.entries', 'server.tracing']));
	});

	it('checks that the generated files are up to date', async () => {
		const dir = await project();
		await edit(dir, 'openapi.json', (text) => text.replace('"3.1.0"', '"3.0.0"'));
		await edit(dir, 'server/widget-script.js', (text) => `${text}// edited\n`);
		const report = await validateProject(dir);
		expect(report.problems.filter((p) => p.rule.startsWith('assets.')).map((p) => `${p.rule} ${p.file}`)).toEqual([
			'assets.openapi openapi.json',
			'assets.widget server/widget-script.js',
		]);
		expect(await writeAssets(dir, { check: true })).toEqual([
			{ file: 'openapi.json', upToDate: false },
			{ file: 'server/widget-script.js', upToDate: false },
		]);
		await writeAssets(dir);
		expect((await validateProject(dir)).problems).toEqual([]);

		const unbundled = await project();
		await edit(unbundled, 'ui/widget.js', (text) => `${text}\nexport const broken = (;\n`);
		expect(messages(await validateProject(unbundled), 'assets.widget')[0]).toMatch(/cannot be bundled/);
		const noEntry = await project();
		await rm(path.join(noEntry, 'ui/entry.js'));
		expect(messages(await validateProject(noEntry), 'assets.widget')[0]).toMatch(/ui\/entry\.js .* is required/);
		const unparsable = await project();
		await put(unparsable, 'openapi.json', '{ nope');
		expect(rules(await validateProject(unparsable))).toContain('assets.openapi');
	});

	it('accepts a product without widgets', async () => {
		const dir = await project();
		await edit(dir, 'manifest.json', (text) => {
			const manifest = JSON.parse(text);
			return JSON.stringify({ ...manifest, widgetScriptUrl: null, widgets: [] }, null, '\t');
		});
		await rm(path.join(dir, 'ui/entry.js'));
		await rm(path.join(dir, 'server/widget-script.js'));
		await edit(dir, 'server/routes.js', (text) =>
			text.replace("import { WIDGET_SCRIPT } from './widget-script.js';", "const WIDGET_SCRIPT = '';"),
		);
		expect(await writeAssets(dir, { check: true })).toEqual([{ file: 'openapi.json', upToDate: true }]);
		expect((await validateProject(dir)).problems).toEqual([]);
	});
});

describe('helpers', () => {
	it('resolve layers, packages and imports', () => {
		expect(layerOf('core/a.js')).toBe('core');
		expect(layerOf('manifest.json')).toBe('.');
		expect(packageOf('@ss/app-kit/widget')).toBe('@ss/app-kit');
		expect(packageOf('next/server.js')).toBe('next');
		expect(packageOf('node:fs')).toBe('node:fs');
		const files = new Set(['core/a.js', 'core/b/index.js']);
		expect(resolveImport('server/x.js', '../core/a', files)).toEqual({ inside: true, target: 'core/a.js' });
		expect(resolveImport('server/x.js', '../core/b', files)).toEqual({ inside: true, target: 'core/b/index.js' });
		expect(resolveImport('server/x.js', '../../x.js', files)).toEqual({ inside: false, target: null });
	});

	it('loads manifests with $refs and resolves pointers', async () => {
		const dir = path.join(root, 'refs');
		await put(dir, 'schemas/a.json', JSON.stringify({ defs: { one: { type: 'object', 'a/b': 1, 'c~d': 2 } }, list: [5] }));
		await put(
			dir,
			'manifest.json',
			JSON.stringify({
				a: { $ref: 'schemas/a.json#/defs/one', extra: true },
				b: [{ $ref: 'schemas/a.json#/list/0' }],
				c: { $ref: 'schemas/missing.json' },
				d: { $ref: 'schemas/a.json#/nope' },
				e: { $ref: 'https://example.com/x.json' },
			}),
		);
		const loaded = await loadManifest(dir);
		expect(loaded.ok).toBe(false);
		expect(loaded.refs).toEqual(['schemas/a.json']);
		expect(loaded.manifest).toMatchObject({ a: { type: 'object', extra: true }, b: [5] });
		expect(loaded.problems.map((p) => p.rule)).toEqual(['manifest.ref', 'manifest.ref', 'manifest.ref']);
		expect(resolvePointer({ 'a/b': 1, 'c~d': 2 }, '/a~1b')).toEqual({ found: true, value: 1 });
		expect(resolvePointer({ 'c~d': 2 }, '/c~0d')).toEqual({ found: true, value: 2 });
		expect(resolvePointer({}, 'x')).toEqual({ found: false });
		expect(resolvePointer([1], '/3')).toEqual({ found: false });
		expect(resolvePointer({ a: 1 }, '')).toEqual({ found: true, value: { a: 1 } });
		await put(dir, 'deep.json', JSON.stringify({ x: { $ref: 'deep.json' } }));
		expect((await loadManifest(dir, { file: 'deep.json' })).problems[0]?.message).toMatch(/nests too deeply/);
	});

	it('renders OpenAPI from any manifest', () => {
		const doc = /** @type {any} */ (
			renderOpenapi({
				manifest: null,
				routes: [
					{
						file: 'server/a.js',
						line: 1,
						method: 'DELETE',
						path: '/v1/items/:itemId',
						auth: 'server',
						feature: 'items',

						idempotent: true,
					},
					{
						file: 'server/a.js',
						line: 2,
						method: 'GET',
						path: '/v1/x',
						auth: 'ticket',
						permission: 'x.read',

						idempotent: false,
					},
					{ file: 'server/a.js', line: 3, method: 'GET', path: '/docs', auth: 'none', idempotent: false },
				],
			})
		);
		expect(doc.info).toEqual({ title: 'Product API', version: '0.0.0' });
		expect(doc.servers).toEqual([{ url: '/' }]);
		expect(doc.paths['/v1/items/{itemId}'].delete.parameters.map((/** @type {any} */ p) => p.name)).toEqual([
			'itemId',
			'Idempotency-Key',
		]);
		expect(doc.paths['/v1/x'].get).toMatchObject({ 'x-ss-permission': 'x.read', security: [{ ticket: [] }] });
		expect(doc.paths['/v1/x'].get['x-ss-feature']).toBeUndefined();
		expect(doc.paths['/docs']).toBeUndefined();
	});
});

describe('generated files on disk', () => {
	it('are readable by the product (openapi.json as JSON)', async () => {
		const openapi = JSON.parse(await readFile(path.join(base, 'openapi.json'), 'utf8'));
		expect(openapi.openapi).toBe('3.1.0');
	});
});
