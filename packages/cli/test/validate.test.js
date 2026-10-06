import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initApp } from '../src/init.js';
import { formatValidation, isDailyOrRarer, layerOf, packageOf, resolveImport, validateProject } from '../src/validate/index.js';
import { loadManifest, resolvePointer } from '../src/manifest.js';
import { removeDir, tempDir } from './helpers/util.js';

/** @type {string} */
let root;
let counter = 0;

beforeAll(async () => {
	root = await tempDir('ss-validate-');
});
afterAll(async () => {
	await removeDir(root);
});

/** @param {'service' | 'pack'} [kind] */
const project = async (kind = 'service') => {
	counter += 1;
	const dir = path.join(root, `p${counter}`);
	await initApp({ dir, kind, slug: 'demo-notes', name: 'Demo Notes' });
	return dir;
};

/** @param {string} dir @param {string} file @param {(text: string) => string} change */
const edit = async (dir, file, change) => writeFile(path.join(dir, file), change(await readFile(path.join(dir, file), 'utf8')));

/** @param {import('../src/validate/index.js').ValidationReport} report */
const rules = (report) => report.problems.map((problem) => problem.rule);

describe('ss app validate', () => {
	it('accepts freshly generated service and pack projects', async () => {
		for (const kind of /** @type {const} */ (['service', 'pack'])) {
			const report = await validateProject(await project(kind));
			expect(report.problems).toEqual([]);
			expect(report.ok).toBe(true);
			expect(formatValidation(report)).toContain('✔ valid');
		}
	});

	it('reports import-direction, package, unresolved and outside imports', async () => {
		const dir = await project();
		await edit(
			dir,
			'core/notes.js',
			(text) =>
				`import { render } from '../ui/notes.js';\nimport fs from 'node:fs';\nimport x from './missing.js';\nimport y from '../../outside.js';\n${text}`,
		);
		await edit(dir, 'ui/notes.js', (text) => `import { DEFAULT_CONFIG } from '../core/notes.js';\n${text}`);
		await edit(dir, 'api/notes.js', (text) => `import { render } from '../ui/notes.js';\n${text}`);
		await edit(
			dir,
			'headless/notes.js',
			(text) => `import { createElementRuntime } from '@ss/web/element';\nimport { boot } from '@ss/web/loader';\n${text}`,
		);
		const report = await validateProject(dir);
		expect(report.ok).toBe(false);
		const found = report.problems.map((problem) => `${problem.file}:${problem.line}:${problem.rule}`);
		expect(found).toEqual(
			expect.arrayContaining([
				'core/notes.js:1:imports.direction',
				'core/notes.js:2:imports.package',
				'core/notes.js:3:imports.unresolved',
				'core/notes.js:4:imports.outside',
				'ui/notes.js:1:imports.direction',
				'api/notes.js:1:imports.direction',
				'headless/notes.js:2:imports.package',
			]),
		);
		expect(found).not.toContain('headless/notes.js:1:imports.package'); // the headless runtime is allowed
		expect(formatValidation(report)).toMatch(/error +core\/notes\.js:1 {2}imports\.direction/);
	});

	it('keeps every import inside the project: tests, app/, root files and stylesheets included', async () => {
		const dir = await project();
		await edit(dir, 'tests/api.test.js', (text) => `import { createPortal } from '../../../platform/src/portal.js';\n${text}`);
		await edit(dir, 'serve.js', (text) => `export { x } from '../loyalty/serve.js';\n${text}`);
		await edit(dir, 'app/page.js', (text) => `const other = await import('../../other/app/page.js');\n${text}`);
		await mkdir(path.join(dir, 'app'), { recursive: true });
		await writeFile(
			path.join(dir, 'app/globals.css'),
			"@import 'tailwindcss';\n/* @source '../../ignored'; */\n@source '../node_modules/@ss/ui/src';\n@source '../../../packages/ui/src';\n@import url('../../shared.css');\n",
		);
		const report = await validateProject(dir);
		const found = report.problems.filter((problem) => problem.rule === 'imports.outside');
		expect(found.map((problem) => `${problem.file}:${problem.line}`)).toEqual([
			'app/globals.css:4',
			'app/globals.css:5',
			'app/page.js:1',
			'serve.js:1',
			'tests/api.test.js:1',
		]);
		expect(found[0]?.message).toMatch(/its own repository/);
		// unlayered files only need to stay inside: unresolved or any package imports are theirs to decide
		expect(report.problems.filter((problem) => problem.file === 'tests/api.test.js')).toHaveLength(1);
	});

	it('checks the package wiring of a pack: tooling dev dependencies and scripts', async () => {
		const dir = await project('pack');
		await edit(dir, 'package.json', (text) => {
			const pkg = JSON.parse(text);
			delete pkg.devDependencies['@ss/config'];
			pkg.dependencies['@ss/cli'] = pkg.devDependencies['@ss/cli'];
			delete pkg.devDependencies['@ss/cli'];
			delete pkg.scripts.typecheck;
			delete pkg.dependencies['@ss/contracts'];
			return JSON.stringify(pkg);
		});
		const report = await validateProject(dir);
		expect(report.problems.map((problem) => `${problem.severity}:${problem.rule}:${problem.message}`)).toEqual([
			"error:package.dependency:dependencies must include '@ss/contracts'",
			"warning:package.devDependency:devDependencies should include '@ss/config'",
			'warning:package.script:scripts.typecheck is missing',
		]);
	});

	it('reports DOM globals in headless/core and hard-coded colours in ui', async () => {
		const dir = await project();
		await edit(dir, 'headless/notes.js', (text) => `${text}\nexport const size = () => window.innerWidth;\n`);
		await edit(dir, 'core/notes.js', (text) => `${text}\nexport const store = () => localStorage;\n`);
		await edit(dir, 'ui/notes.js', (text) => `${text}\nexport const accent = '#ff0000';\n`);
		await writeFile(path.join(dir, 'ui/extra.css'), '/* #000 in a comment is fine */\n.x { color: rgb(0 0 0); }\n');
		await writeFile(path.join(dir, 'ui/tokens.css'), ':root { --ss-color-text: #111; }\n');
		const report = await validateProject(dir);
		expect(rules(report).filter((rule) => rule === 'headless.dom')).toHaveLength(2);
		expect(
			report.problems.filter((problem) => problem.rule === 'ui.colour').map((problem) => `${problem.file}:${problem.line}`),
		).toEqual(['ui/extra.css:2', expect.stringMatching(/^ui\/notes\.js:\d+$/)]);
	});

	it('checks string keys, catalogs and placeholders', async () => {
		const dir = await project();
		await edit(dir, 'ui/notes.js', (text) => text.replace("t('notes.empty')", "t('notes.nope')"));
		await writeFile(
			path.join(dir, 'strings/fr.json'),
			JSON.stringify({ 'notes.error.text_too_long': 'Au plus {limit} caractères', 'notes.extra': 'x' }),
		);
		await writeFile(path.join(dir, 'strings/bad.json'), '[1]');
		await writeFile(path.join(dir, 'strings/broken.json'), '{ nope');
		await writeFile(path.join(dir, 'strings/typed.json'), JSON.stringify({ 'ok.key': 1 }));
		const report = await validateProject(dir);
		expect(rules(report)).toEqual(
			expect.arrayContaining(['strings.unknown-key', 'strings.placeholders', 'strings.extra-key', 'strings.invalid']),
		);
		expect(report.problems.filter((problem) => problem.rule === 'strings.invalid')).toHaveLength(3);
	});

	it('checks manifest refs, schema problems and module references', async () => {
		const dir = await project();
		await edit(dir, 'manifest.json', (text) =>
			text
				.replace('"headless/notes.js#createNotes"', '"headless/notes.js#createMissing"')
				.replace('"ui/notes.js#render"', '"ui/gone.js#render"')
				.replace('"strings": "strings/en.json"', '"strings": "strings/zz.json"'),
		);
		let report = await validateProject(dir);
		expect(rules(report)).toEqual(expect.arrayContaining(['module.export', 'module.missing', 'strings.missing-file']));

		await edit(dir, 'manifest.json', (text) => text.replace('"schemas/notes.features.json"', '"../escape.json"'));
		report = await validateProject(dir);
		expect(rules(report)).toContain('manifest.ref');

		await edit(dir, 'manifest.json', (text) => text.replace('"../escape.json"', '"schemas/none.json#/x"'));
		report = await validateProject(dir);
		expect(report.problems.find((problem) => problem.rule === 'manifest.ref')?.message).toMatch(/cannot read/);

		await edit(dir, 'manifest.json', (text) => text.replace('"schemas/none.json#/x"', '"schemas/notes.features.json#/nope"'));
		report = await validateProject(dir);
		expect(report.problems.find((problem) => problem.rule === 'manifest.ref')?.message).toMatch(/pointer not found/);

		await edit(dir, 'manifest.json', (text) =>
			text
				.replace('"schemas/notes.features.json#/nope"', '"schemas/notes.features.json"')
				.replace('"version": "0.1.0"', '"version": "one"'),
		);
		report = await validateProject(dir);
		expect(rules(report)).toContain('manifest.pattern');
		expect(report.problems.find((problem) => problem.rule === 'manifest.pattern')?.pointer).toBe('/product/version');

		await writeFile(path.join(dir, 'manifest.json'), '{ broken');
		report = await validateProject(dir);
		expect(rules(report)).toContain('manifest.read');
	});

	it('reports semantic manifest problems (mode rules) and the budget estimate', async () => {
		const dir = await project();
		await edit(dir, 'manifest.json', (text) => text.replace('"budget": { "js": 3 }', '"budget": { "js": 1 }'));
		let report = await validateProject(dir);
		expect(report.ok).toBe(true);
		expect(report.problems.map((problem) => `${problem.severity}:${problem.rule}`)).toEqual(['warning:budget.estimate']);
		expect(formatValidation(report)).toContain('1 warning');

		await edit(dir, 'manifest.json', (text) => text.replace('"renderer": "ui/notes.js#render"', '"renderer": null'));
		report = await validateProject(dir);
		expect(rules(report)).toContain('manifest.modeARequiresRenderer');
	});

	it('checks anatomy, OpenAPI coverage, package wiring and event schemas', async () => {
		const dir = await project();
		await rm(path.join(dir, 'jobs'), { recursive: true });
		await rm(path.join(dir, 'app/dashboard/page.js'));
		await rm(path.join(dir, 'schemas/events'), { recursive: true });
		await edit(dir, 'openapi.json', (text) => text.replaceAll('"/v1/notes', '"/v1/other'));
		await edit(dir, 'package.json', (text) =>
			text.replace('"@ss/app-kit"', '"@ss/app-kit-renamed"').replace('"certify":', '"certify-x":'),
		);
		let report = await validateProject(dir);
		expect(report.problems.filter((problem) => problem.rule === 'anatomy.missing').map((problem) => problem.file)).toEqual([
			'app/dashboard/page.js',
			'jobs/',
		]);
		expect(rules(report)).toEqual(
			expect.arrayContaining(['openapi.resource', 'package.dependency', 'package.script', 'events.schema']),
		);

		await writeFile(path.join(dir, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', paths: {} }));
		report = await validateProject(dir);
		expect(rules(report)).toContain('openapi.invalid');
	});

	it('keeps vercel.json crons daily and few (free-tier hosting)', async () => {
		const dir = await project();
		const crons = (/** @type {unknown[]} */ list) =>
			writeFile(path.join(dir, 'vercel.json'), JSON.stringify({ framework: 'nextjs', crons: list }));
		await crons([
			{ path: '/cron/a', schedule: '*/5 * * * *' },
			{ path: '/cron/b', schedule: '0 * * * *' },
			{ path: '/cron/c', schedule: '15 3 * * *' },
		]);
		const report = await validateProject(dir);
		expect(report.ok).toBe(false);
		expect(report.problems.filter((p) => p.rule === 'vercel.crons').map((p) => p.pointer)).toEqual([
			'/crons',
			'/crons/0/schedule',
			'/crons/1/schedule',
		]);
		await writeFile(path.join(dir, 'vercel.json'), '{ not json');
		expect(rules(await validateProject(dir))).not.toContain('vercel.crons');
		expect(isDailyOrRarer('15 3 * * 1')).toBe(true);
		expect(isDailyOrRarer('15 3,9 * * *')).toBe(false);
		expect(isDailyOrRarer(null)).toBe(false);
		expect(isDailyOrRarer('15 3 * *')).toBe(false);
	});

	it('reports an unknown kind with the common anatomy only', async () => {
		const dir = path.join(root, 'empty');
		await mkdir(dir, { recursive: true });
		const report = await validateProject(dir);
		expect(rules(report)).toContain('manifest.read');
		expect(report.problems.filter((problem) => problem.rule === 'anatomy.missing')).toHaveLength(9);
		expect(formatValidation(report)).toMatch(/✖ \d+ errors/);
	});
});

describe('helpers', () => {
	it('classifies layers, packages and relative imports', () => {
		expect(layerOf('core/a.js')).toBe('core');
		expect(layerOf('manifest.json')).toBe('.');
		expect(packageOf('@ss/app-kit/sub')).toBe('@ss/app-kit');
		expect(packageOf('react/jsx')).toBe('react');
		expect(packageOf('node:fs')).toBe('node:fs');
		const files = new Set(['core/a.js', 'core/b/index.js']);
		expect(resolveImport('core/x.js', './a', files)).toEqual({ inside: true, target: 'core/a.js' });
		expect(resolveImport('core/x.js', './b', files)).toEqual({ inside: true, target: 'core/b/index.js' });
		expect(resolveImport('core/x.js', '../../y', files)).toEqual({ inside: false, target: null });
	});

	it('resolves JSON pointers and bundles nested refs with siblings', async () => {
		expect(resolvePointer({ a: [{ 'b/c': 1 }] }, '/a/0/b~1c')).toEqual({ found: true, value: 1 });
		expect(resolvePointer({ a: 1 }, 'a')).toEqual({ found: false });
		expect(resolvePointer({ a: 1 }, '')).toEqual({ found: true, value: { a: 1 } });
		const dir = path.join(root, 'refs');
		await mkdir(path.join(dir, 'schemas'), { recursive: true });
		await writeFile(
			path.join(dir, 'manifest.json'),
			JSON.stringify({
				elements: [
					{ features: { $ref: 'schemas/a.json', title: 'T' } },
					{ features: { $ref: 'schemas/loop.json' } },
					{ features: { $ref: 'x.yaml' } },
				],
			}),
		);
		await writeFile(
			path.join(dir, 'schemas/a.json'),
			JSON.stringify({ type: 'object', properties: { p: { $ref: 'schemas/b.json#/node' } } }),
		);
		await writeFile(path.join(dir, 'schemas/b.json'), JSON.stringify({ node: { type: 'integer' } }));
		await writeFile(path.join(dir, 'schemas/loop.json'), JSON.stringify({ $ref: 'schemas/loop.json' }));
		const loaded = await loadManifest(dir);
		expect(/** @type {any} */ (loaded.manifest).elements[0].features).toEqual({
			type: 'object',
			title: 'T',
			properties: { p: { type: 'integer' } },
		});
		expect(loaded.refs).toEqual(['schemas/a.json', 'schemas/b.json', 'schemas/loop.json']);
		expect(loaded.problems.map((problem) => problem.message)).toEqual(
			expect.arrayContaining([expect.stringMatching(/nests too deeply/), expect.stringMatching(/project-relative \.json/)]),
		);
	});
});
