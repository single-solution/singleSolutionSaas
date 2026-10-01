/**
 * Pack build (Node only, never shipped to browsers): the publishable `ss-pack-bundle@1` contents of this element pack.
 *
 * - The manifest with every feature schema inlined (the Portal takes features inline, F.3).
 * - The manifest module references (`headless/*.js`, `ui/*.js`) bundled together with esbuild: minified ES modules
 *   under the referenced paths plus shared `chunks/*.js` (code splitting), so each element ships only its own code
 *   and the shared core loads once per page from `/w/packs/<appId>/<version>/…`; the Portal measures each
 *   element entry against its `budget.js`.
 * - The per-element string catalogs (compact JSON).
 *
 * `node pack.js [outDir]` writes the assets and `descriptor.json` (unsigned: sign it with `@ss/protocol`
 * `signBundle` and upload it with `POST /v1/admin/packs`, then `PUT` each asset).
 * @module
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** This pack's root folder. */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const BUNDLE_FORMAT = 'ss-pack-bundle@1';

/** @param {string} relative */
const readJson = async (relative) => JSON.parse(await readFile(path.join(ROOT, relative), 'utf8'));

/**
 * The manifest with local `{ "$ref": "schemas/…" }` feature schemas inlined.
 * @returns {Promise<Record<string, any>>}
 */
export const loadManifest = async () => {
	const manifest = await readJson('manifest.json');
	const elements = await Promise.all(
		manifest.elements.map(async (/** @type {Record<string, any>} */ element) =>
			typeof element.features?.$ref === 'string' ? { ...element, features: await readJson(element.features.$ref) } : element,
		),
	);
	return { ...manifest, elements };
};

/**
 * @typedef {object} PackAsset
 * @property {string} path
 * @property {Buffer} bytes
 * @property {string} contentType
 * @property {string} sha256
 * @property {number} size
 */

/**
 * @param {string} assetPath
 * @param {Buffer} bytes
 * @param {string} contentType
 * @returns {PackAsset}
 */
const asset = (assetPath, bytes, contentType) => ({
	path: assetPath,
	bytes,
	contentType,
	sha256: createHash('sha256').update(bytes).digest('hex'),
	size: bytes.byteLength,
});

/**
 * Bundle the module entries together (minified ESM, browser target, code splitting): every entry keeps its path,
 * code shared by several entries goes to `chunks/*.js`, which the browser loads once for all elements on a page.
 * @param {readonly string[]} entries project-relative module paths
 * @returns {Promise<Array<{ path: string, bytes: Buffer }>>}
 */
export const bundleModules = async (entries) => {
	const outdir = path.join(ROOT, '.pack-out');
	const result = await build({
		entryPoints: entries.map((entry) => path.join(ROOT, entry)),
		outbase: ROOT,
		outdir,
		bundle: true,
		splitting: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify: true,
		write: false,
		entryNames: '[dir]/[name]',
		chunkNames: 'chunks/[name]-[hash]',
		legalComments: 'none',
		logLevel: 'silent',
	});
	return result.outputFiles
		.map((file) => ({ path: path.relative(outdir, file.path).split(path.sep).join('/'), bytes: Buffer.from(file.contents) }))
		.sort((a, b) => (a.path < b.path ? -1 : 1));
};

/**
 * The pack's manifest and assets.
 * @returns {Promise<{ manifest: Record<string, any>, assets: PackAsset[] }>}
 */
export const buildPack = async () => {
	const manifest = await loadManifest();
	/** @type {Set<string>} */
	const modules = new Set();
	/** @type {Set<string>} */
	const catalogs = new Set();
	for (const element of manifest.elements) {
		for (const ref of [element.headless, element.renderer]) if (typeof ref === 'string') modules.add(ref.split('#')[0] ?? '');
		if (typeof element.strings === 'string') catalogs.add(element.strings);
	}
	const assets = [
		...(await bundleModules([...modules].sort())).map((file) => asset(file.path, file.bytes, 'text/javascript')),
		...(await Promise.all(
			[...catalogs]
				.sort()
				.map(async (file) => asset(file, Buffer.from(JSON.stringify(await readJson(file))), 'application/json')),
		)),
	];
	return { manifest, assets };
};

/**
 * The unsigned bundle descriptor of a build.
 * @param {{ manifest: Record<string, any>, assets: PackAsset[] }} pack
 */
export const descriptorOf = ({ manifest, assets }) => ({
	format: BUNDLE_FORMAT,
	manifest,
	assets: assets.map(({ path: assetPath, sha256, size, contentType }) => ({ path: assetPath, sha256, size, contentType })),
});

/**
 * Write a build to a folder: every asset at its path plus `descriptor.json`.
 * @param {string} outDir
 */
export const writePack = async (outDir) => {
	const pack = await buildPack();
	for (const entry of pack.assets) {
		await mkdir(path.dirname(path.join(outDir, entry.path)), { recursive: true });
		await writeFile(path.join(outDir, entry.path), entry.bytes);
	}
	await writeFile(path.join(outDir, 'descriptor.json'), `${JSON.stringify(descriptorOf(pack), null, '\t')}\n`);
	return pack;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const out = path.resolve(process.argv[2] ?? path.join(ROOT, 'dist'));
	const pack = await writePack(out);
	process.stdout.write(`${pack.assets.length} assets written to ${out}\n`);
}
