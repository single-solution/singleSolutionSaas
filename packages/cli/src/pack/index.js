/**
 * `ss pack build | publish` (F.18): the publishable browser bundle of a product's mode-A elements, the same way for
 * every pack (and for a service product's UI bundle), and the measurement `ss app validate` uses for budgets.
 *
 * - **build**: every module the manifest names (`headless` / `renderer`, `file.js#export`) is an esbuild entry,
 *   bundled together as minified ES modules for browsers with code splitting — each entry keeps its path, code shared
 *   by several entries goes to `chunks/*.js` (loaded once per page). String catalogs (`strings/<lang>.json` and legacy
 *   per-element `strings` files) ship as compact JSON. Every asset is hashed into the unsigned `ss-pack-bundle@1`
 *   descriptor `{ format, manifest (features inline), assets: [{ path, sha256, size, contentType }] }`.
 * - **publish**: signs the descriptor with `@ss/protocol` `signBundle` and uploads it to the Portal admin pack API
 *   (`POST /v1/admin/packs`, then `PUT /v1/admin/packs/:appId/versions/:version/assets/<path>` per asset) with a staff
 *   API token (`sst_…`, Admin Console → API tokens, or `POST /v1/admin/api-tokens`).
 * @module
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { measureBundle } from '@ss/contracts/budget';
import { createSigner, signBundle, toPublicJwk } from '@ss/protocol';
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
 * Each mode-A element's entry modules (for {@link measureBundle}).
 * @param {{ elements?: ReadonlyArray<Record<string, any>> }} manifest
 * @returns {Array<{ key: string, modules: string[] }>}
 */
export const elementModules = (manifest) =>
	(manifest.elements ?? [])
		.filter((element) => Array.isArray(element.modes) && element.modes.includes('A'))
		.map((element) => ({
			key: String(element.key),
			modules: [element.headless, element.renderer]
				.filter((ref) => typeof ref === 'string' && ref.includes('#'))
				.map((ref) => String(ref).split('#')[0] ?? ''),
		}));

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
 * Measure a build the way the Portal does (`@ss/contracts/budget`).
 * @param {Pack} pack
 */
export const measurePack = ({ manifest, assets }) => {
	const byPath = new Map(assets.map((asset) => [asset.path, asset.bytes]));
	return measureBundle({ elements: elementModules(manifest), read: (file) => byPath.get(file) });
};

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

/**
 * @typedef {object} PublishInput
 * @property {Pack} pack
 * @property {string} portalUrl
 * @property {string} token staff API token (`sst_…`)
 * @property {Record<string, unknown>} signingKey the developer's private Ed25519 JWK (with `kid`)
 * @property {typeof fetch} fetch
 * @property {boolean} [activate] activate the pack once its assets are uploaded
 */

/**
 * Sign and upload a build.
 * @param {PublishInput} input
 * @returns {Promise<{ appId: string, version: number, uploaded: number, status: string }>}
 */
export const publishPack = async ({ pack, portalUrl, token, signingKey, fetch, activate = false }) => {
	const base = portalUrl.replace(/\/+$/, '');
	const descriptor = descriptorOf(pack);
	const signature = await signBundle({ signer: createSigner(/** @type {any} */ (signingKey)), descriptor });
	const publicJwk = toPublicJwk(signingKey);
	/** @param {string} method @param {string} route @param {{ json?: unknown, bytes?: Buffer, type?: string }} body */
	const call = async (method, route, { json, bytes, type }) => {
		const response = await fetch(`${base}${route}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': type ?? 'application/json',
				...(method === 'POST'
					? {
							'idempotency-key': `ss-pack-${createHash('sha256')
								.update(route + JSON.stringify(json ?? ''))
								.digest('hex')
								.slice(0, 32)}`,
						}
					: {}),
			},
			body: bytes ? new Uint8Array(bytes) : JSON.stringify(json),
		});
		const text = await response.text();
		/** @type {any} */
		let parsed = null;
		try {
			parsed = text ? JSON.parse(text) : null;
		} catch {
			parsed = null;
		}
		if (!response.ok)
			throw Object.assign(
				new Error(`${method} ${route}: ${response.status} ${parsed?.detail ?? parsed?.title ?? text.slice(0, 200)}`),
				{
					code: 'publish_failed',
					status: response.status,
					problem: parsed,
				},
			);
		return parsed;
	};
	const uploaded = await call('POST', '/v1/admin/packs', { json: { descriptor, signature, publicJwk } });
	const appId = String(uploaded?.app?.appId ?? '');
	const version = Number(uploaded?.version?.version ?? 0);
	if (!appId || !version)
		throw Object.assign(new Error('the Portal did not return the pack version'), { code: 'publish_failed' });
	for (const asset of pack.assets)
		await call('PUT', `/v1/admin/packs/${appId}/versions/${version}/assets/${asset.path}`, {
			bytes: asset.bytes,
			type: asset.contentType,
		});
	let status = String(uploaded?.app?.status ?? 'pending');
	if (activate && status !== 'active') {
		const result = await call('POST', `/v1/admin/apps/${appId}/lifecycle`, { json: { action: 'activate' } });
		status = String(result?.status ?? status);
	}
	return { appId, version, uploaded: pack.assets.length, status };
};
