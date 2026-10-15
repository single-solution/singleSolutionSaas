/**
 * The test product `fixtures/notes` is exactly what `ss app init --id notes --name Notes --base-url https://notes.test`
 * writes inside a pnpm workspace, plus the test-only `import` feature (README). This test keeps the two from drifting
 * apart: it runs the real `ss app init` and compares.
 *
 * - Every file the CLI writes is in the fixture, and the fixture has no other file but the import feature's settings
 *   schema.
 * - A file the import feature does not touch is the same, byte for byte.
 * - The JSON files it extends (manifest, guide, API descriptions) equal the generated ones once its `import` parts are
 *   taken out.
 * - The code files it extends hold every generated line, in order, after the few lines it changes (listed below).
 *
 * The generated `openapi.json` and `server/widget-script.js` follow the fixture's own sources (they include the import
 * feature): `ss app validate fixtures/notes` (this workspace's `pnpm validate`) checks them.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'notes');

/** Written by `ss app init` from the sources: checked against the fixture's own sources by `ss app validate`. */
const GENERATED = new Set(['openapi.json', 'server/widget-script.js']);
/** The development secrets `ss app init` writes (git-ignored, never in the fixture). */
const LOCAL_ONLY = new Set(['.env.local']);
/** The import feature's own files. */
const IMPORT_FILES = new Set(['schemas/import.settings.json']);
/** The JSON files the import feature extends. */
const IMPORT_JSON = new Set(['manifest.json', 'docs/guide.json', 'schemas/api.json']);
/**
 * The code files the import feature extends, with the generated lines it changes (generated → fixture).
 * @type {Readonly<Record<string, ReadonlyArray<readonly [string, string]>>>}
 */
const IMPORT_CODE = Object.freeze({
	'adapters/product.js': [
		["import { noteView } from '../core/notes.js';", "import { checkImportedNote, noteView } from '../core/notes.js';"],
		['const SETTINGS = { notes: notesSettings };', 'const SETTINGS = { notes: notesSettings, import: importSettings };'],
	],
	'core/notes.js': [],
	'server/routes.js': [
		[
			"import { countHandlers, created, defineRoute, paginate, problem } from '@ss/app-kit';",
			"import { IMPORT_LIMITS, countHandlers, created, defineRoute, paginate, problem } from '@ss/app-kit';",
		],
	],
});

/**
 * The files below a folder (project-relative POSIX paths, sorted), without `node_modules`.
 * @param {string} dir
 */
const filesOf = async (dir) =>
	(await readdir(dir, { recursive: true, withFileTypes: true }))
		.filter((entry) => entry.isFile())
		.map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
		.filter((file) => !file.split('/').includes('node_modules'))
		.sort();

/**
 * A JSON value without the import feature: object members named `import` or describing an `/v1/import` route, and
 * list items whose `key` is `import`.
 * @param {unknown} value
 * @returns {unknown}
 */
const withoutImport = (value) => {
	if (Array.isArray(value))
		return value
			.filter((item) => !(item && typeof item === 'object' && /** @type {{ key?: unknown }} */ (item).key === 'import'))
			.map(withoutImport);
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== 'import' && !key.includes('/v1/import'))
				.map(([key, item]) => [key, withoutImport(item)]),
		);
	return value;
};

/**
 * The lines of `wanted` that `text` does not hold in the same order (empty when `wanted` is a subsequence).
 * @param {string[]} wanted
 * @param {string[]} text
 */
const missingLines = (wanted, text) => {
	/** @type {string[]} */
	const missing = [];
	let at = 0;
	for (const line of wanted) {
		const found = text.indexOf(line, at);
		if (found === -1) missing.push(line);
		else at = found + 1;
	}
	return missing;
};

/** @type {string} */
let root;
/** @type {string} */
let generated;

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'ss-notes-fixture-'));
	// inside a pnpm workspace, as the fixture is: the workspace's settings apply and `@ss/*` are `workspace:^`
	await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n   - 'notes'\n");
	generated = path.join(root, 'notes');
	const cli = path.dirname(require.resolve('@ss/cli/package.json'));
	const { bin } = JSON.parse(await readFile(path.join(cli, 'package.json'), 'utf8'));
	await run(process.execPath, [
		path.join(cli, bin.ss),
		'app',
		'init',
		generated,
		'--id',
		'notes',
		'--name',
		'Notes',
		'--base-url',
		'https://notes.test',
	]);
}, 60_000);

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

/** @param {string} dir @param {string} file */
const text = (dir, file) => readFile(path.join(dir, file), 'utf8');

describe('the test product Notes is what ss app init writes (plus the import feature)', () => {
	it('has every generated file and no other but the import feature’s', async () => {
		const made = (await filesOf(generated)).filter((file) => !LOCAL_ONLY.has(file));
		const kept = (await filesOf(FIXTURE)).filter((file) => !IMPORT_FILES.has(file));
		expect(kept).toEqual(made);
	});

	it('keeps every file the import feature does not touch byte for byte', async () => {
		const same = (await filesOf(generated)).filter(
			(file) => !LOCAL_ONLY.has(file) && !GENERATED.has(file) && !IMPORT_JSON.has(file) && !Object.hasOwn(IMPORT_CODE, file),
		);
		expect(same.length).toBeGreaterThan(30);
		for (const file of same) expect(await text(FIXTURE, file), file).toBe(await text(generated, file));
	});

	it('differs in the manifest, the guide and the API descriptions only by the import feature', async () => {
		for (const file of IMPORT_JSON) {
			const fixture = JSON.parse(await text(FIXTURE, file));
			expect(withoutImport(fixture), file).toEqual(JSON.parse(await text(generated, file)));
			expect(JSON.stringify(fixture), file).toContain('import');
		}
	});

	it('keeps every generated line of the code the import feature extends', async () => {
		for (const [file, changes] of Object.entries(IMPORT_CODE)) {
			let wanted = await text(generated, file);
			for (const [before, after] of changes) {
				// the template still has the line the import feature changes, once
				expect(wanted.split(before).length - 1, `${file}: ${before}`).toBe(1);
				wanted = wanted.replace(before, after);
			}
			expect(missingLines(wanted.split('\n'), (await text(FIXTURE, file)).split('\n')), file).toEqual([]);
		}
	});
});
