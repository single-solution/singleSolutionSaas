/**
 * `ss pack build` (F.18): the uploadable browser bundle of a product's mode-A elements, the same way for every pack and
 * for a service product's widgets. Every module the manifest names (`headless` / `renderer`, `file.js#export`) is an esbuild entry,
 * bundled together as minified ES modules for browsers with code splitting — each entry keeps its path, code shared
 * by several entries goes to `chunks/*.js` (loaded once per page). String catalogs (`strings/<lang>.json` and legacy
 * per-element `strings` files) ship as compact JSON. Every asset is hashed into the unsigned `ss-pack-bundle@1`
 * descriptor `{ format, manifest (features inline), assets: [{ path, sha256, size, contentType }] }`.
 * @module
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isObject, walk } from '../fsutil.js';
import { loadManifest } from '../manifest.js';

export { loadManifest };

export const BUNDLE_FORMAT = 'ss-pack-bundle@1';
/** Default output folder of `ss pack build` (inside `dist/`, which `ss app validate` never scans). */
export const PACK_OUT_DIR = 'dist/pack';
/** Product string catalogs: `strings/<lang>.json`. */
export const LANGUAGE_CATALOG = /^strings\/([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.json$/;
const CONTENT_TYPES = Object.freeze({ js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', css: 'text/css' });

/**
 * @typedef {object} PackAsset
 * @property {string} path
 * @property {Buffer} bytes
 * @property {string} contentType
 * @property {string} sha256
 * @property {number} size
 */

/**
 * @typedef {object} Pack
 * @property {Record<string, any>} manifest the manifest with features inline
 * @property {PackAsset[]} assets
 */

/**
 * @param {string} assetPath
 * @param {Uint8Array} bytes
 * @returns {PackAsset}
 */
export const assetOf = (assetPath, bytes) => {
	const buffer = Buffer.from(bytes);
	const ext = assetPath.slice(assetPath.lastIndexOf('.') + 1);
	return {
		path: assetPath,
		bytes: buffer,
		contentType: /** @type {Record<string, string>} */ (CONTENT_TYPES)[ext] ?? 'application/octet-stream',
		sha256: createHash('sha256').update(buffer).digest('hex'),
		size: buffer.byteLength,
	};
};

/**
 * Module files a manifest names (`headless` / `renderer` refs), sorted and de-duplicated.
 * @param {{ elements?: ReadonlyArray<Record<string, any>> }} manifest
 * @returns {string[]}
 */
export const moduleEntries = (manifest) => {
	/** @type {Set<string>} */
	const files = new Set();
	for (const element of manifest.elements ?? [])
		for (const ref of [element.headless, element.renderer])
			if (typeof ref === 'string' && ref.includes('#')) files.add(ref.split('#')[0] ?? '');
	return [...files].filter((file) => file !== '').sort();
};

/**
 * Bundle module entries (minified ESM for browsers, code splitting): each entry keeps its project-relative path and
 * shared code goes to `chunks/<name>-<hash>.js`. esbuild is loaded on demand.
 * @param {{ dir: string, entries: readonly string[], minify?: boolean }} input
 * @returns {Promise<Array<{ path: string, bytes: Uint8Array }>>}
 */
export const bundleModules = async ({ dir, entries, minify = true }) => {
	if (entries.length === 0) return [];
	const { build } = await import('esbuild');
	const outdir = path.join(dir, '.ss-pack-out');
	const result = await build({
		entryPoints: entries.map((entry) => path.join(dir, entry)),
		absWorkingDir: dir,
		outbase: dir,
		outdir,
		bundle: true,
		splitting: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify,
		write: false,
		entryNames: '[dir]/[name]',
		chunkNames: 'chunks/[name]-[hash]',
		legalComments: 'none',
		charset: 'utf8',
		logLevel: 'silent',
	});
	return result.outputFiles
		.map((file) => ({ path: path.relative(outdir, file.path).split(path.sep).join('/'), bytes: file.contents }))
		.sort((a, b) => (a.path < b.path ? -1 : 1));
};

/**
 * String catalogs a pack ships: every product catalog `strings/<lang>.json` and every legacy per-element file, as
 * compact JSON.
 * @param {string} dir
 * @param {{ elements?: ReadonlyArray<Record<string, any>> }} manifest
 * @returns {Promise<PackAsset[]>}
 */
export const stringAssets = async (dir, manifest) => {
	const files = new Set(
		(await walk(path.join(dir, 'strings'))).map((file) => `strings/${file}`).filter((file) => LANGUAGE_CATALOG.test(file)),
	);
	for (const element of manifest.elements ?? []) if (typeof element.strings === 'string') files.add(element.strings);
	return Promise.all(
		[...files].sort().map(async (file) => {
			const parsed = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
			return assetOf(file, Buffer.from(JSON.stringify(parsed)));
		}),
	);
};

/**
 * Build a product's browser bundle.
 * @param {string} dir project root
 * @returns {Promise<Pack>}
 */
export const buildPack = async (dir) => {
	const loaded = await loadManifest(dir);
	if (!loaded.ok || !isObject(loaded.manifest))
		throw Object.assign(new Error(loaded.problems.map((p) => p.message).join('; ') || 'manifest.json is unreadable'), {
			code: 'invalid_manifest',
		});
	const manifest = /** @type {Record<string, any>} */ (loaded.manifest);
	const modules = await bundleModules({ dir, entries: moduleEntries(manifest) });
	return {
		manifest,
		assets: [...modules.map((file) => assetOf(file.path, file.bytes)), ...(await stringAssets(dir, manifest))],
	};
};

/**
 * The unsigned `ss-pack-bundle@1` descriptor of a build.
 * @param {Pack} pack
 */
export const descriptorOf = ({ manifest, assets }) => ({
	format: BUNDLE_FORMAT,
	manifest,
	assets: assets.map(({ path: assetPath, sha256, size, contentType }) => ({ path: assetPath, sha256, size, contentType })),
});

/**
 * Write a build: every asset at its path plus `descriptor.json` (the folder is replaced).
 * @param {Pack} pack
 * @param {string} outDir
 */
export const writePack = async (pack, outDir) => {
	await rm(outDir, { recursive: true, force: true });
	for (const asset of pack.assets) {
		await mkdir(path.dirname(path.join(outDir, asset.path)), { recursive: true });
		await writeFile(path.join(outDir, asset.path), asset.bytes);
	}
	await writeFile(path.join(outDir, 'descriptor.json'), `${JSON.stringify(descriptorOf(pack), null, '\t')}\n`);
};
