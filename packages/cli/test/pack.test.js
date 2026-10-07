import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { main } from '../src/cli.js';
import { initApp } from '../src/init.js';
import {
	BUNDLE_FORMAT,
	PACK_OUT_DIR,
	assetOf,
	buildPack,
	bundleModules,
	descriptorOf,
	moduleEntries,
} from '../src/pack/index.js';
import { checkStringSlices, inStringSlice, validateProject } from '../src/validate/index.js';
import { createIo, removeDir, tempDir } from './helpers/util.js';

/** @type {string} */
let root;
let counter = 0;
beforeAll(async () => {
	root = await tempDir('ss-pack-');
});
afterAll(async () => {
	await removeDir(root);
});

const project = async (/** @type {'service' | 'pack'} */ kind = 'pack') => {
	counter += 1;
	const dir = path.join(root, `p${counter}`);
	await initApp({ dir, kind, slug: 'demo-notes', name: 'Demo Notes' });
	return dir;
};
/** @param {string} dir @param {string} file @param {(text: string) => string} change */
const edit = async (dir, file, change) => writeFile(path.join(dir, file), change(await readFile(path.join(dir, file), 'utf8')));

/** @param {string[]} argv @param {Record<string, any>} [deps] */
const ss = async (argv, deps = {}) => {
	const io = createIo();
	const code = await main(argv, { io: io.io, cwd: root, ...deps });
	return { code, out: io.out(), err: io.err() };
};

describe('ss pack build', () => {
	it('bundles the manifest modules with shared chunks, the catalogs and a descriptor', async () => {
		const dir = await project();
		const pack = await buildPack(dir);
		const paths = pack.assets.map((a) => a.path);
		expect(paths).toEqual(expect.arrayContaining(['headless/notes.js', 'ui/notes.js', 'strings/en.json']));
		expect(paths.some((p) => p.startsWith('chunks/'))).toBe(true);
		expect(pack.manifest.elements[0].features.type).toBe('object');
		const descriptor = descriptorOf(pack);
		expect(descriptor.format).toBe(BUNDLE_FORMAT);
		expect(descriptor.assets.every((a) => /^[0-9a-f]{64}$/.test(a.sha256) && a.size > 0)).toBe(true);
		// deterministic
		expect((await buildPack(dir)).assets.map((a) => a.sha256)).toEqual(pack.assets.map((a) => a.sha256));
		const built = await ss(['pack', 'build', dir]);
		expect(built.code, built.err).toBe(0);
		expect(built.out).toContain('ui/notes.js');
		expect(JSON.parse(await readFile(path.join(dir, PACK_OUT_DIR, 'descriptor.json'), 'utf8')).format).toBe(BUNDLE_FORMAT);
		const json = await ss(['pack', 'build', dir, '--out', 'out', '--json']);
		expect(JSON.parse(json.out)).toMatchObject({
			out: path.join(dir, 'out'),
			assets: expect.arrayContaining([{ path: 'ui/notes.js', size: expect.any(Number) }]),
		});
		expect(await ss(['pack', 'nope'])).toMatchObject({ code: 2 });
		expect((await ss(['pack', 'build', path.join(root, 'missing')])).code).toBe(1);
	});

	it('builds the widgets of a service product (its mode-A headless and ui modules)', async () => {
		const dir = await project('service');
		const paths = (await buildPack(dir)).assets.map((a) => a.path);
		expect(paths).toEqual(expect.arrayContaining(['headless/notes.js', 'ui/notes.js', 'strings/en.json']));
		expect(paths.some((p) => p.startsWith('api/') || p.startsWith('core/'))).toBe(false);
	});

	it('helpers: entries, asset types, empty bundles', async () => {
		const manifest = {
			elements: [
				{ key: 'a', modes: ['A', 'B'], headless: 'headless/a.js#x', renderer: 'ui/a.js#y' },
				{ key: 'b', modes: ['B'], headless: 'headless/a.js#z', renderer: null },
				{ key: 'c', modes: ['C'] },
			],
		};
		expect(moduleEntries(manifest)).toEqual(['headless/a.js', 'ui/a.js']);
		expect(moduleEntries({})).toEqual([]);
		expect(assetOf('a.css', Buffer.from('x')).contentType).toBe('text/css');
		expect(assetOf('a.bin', Buffer.from('x')).contentType).toBe('application/octet-stream');
		expect(await bundleModules({ dir: root, entries: [] })).toEqual([]);
	});
});

describe('string slices in ss app validate', () => {
	it('checks string slices against the product catalog', async () => {
		const dir = await project();
		await edit(dir, 'manifest.json', (text) => text.replace('"strings": "strings/en.json",', '"stringKeys": ["other.*"],'));
		const report = await validateProject(dir);
		expect(report.problems.map((p) => p.rule)).toContain('strings.slice');
		expect(inStringSlice(['a.*', 'b'], 'a.x')).toBe(true);
		expect(inStringSlice(['a.*', 'b'], 'b')).toBe(true);
		expect(inStringSlice(['a.*', 'b'], 'c')).toBe(false);
		const none = await checkStringSlices(
			/** @type {any} */ ({ set: new Set(), read: async () => '' }),
			/** @type {any} */ ({
				elements: [{ key: 'x', modes: ['A'], renderer: 'ui/missing.js#r' }],
			}),
		);
		expect(none).toEqual([]);
	});
});
