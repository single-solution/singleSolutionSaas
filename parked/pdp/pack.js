/**
 * The pack as the Portal receives it, built by `ss pack build` (`@ss/cli`, F.18): the manifest with its feature
 * schemas inline, and the browser assets — the manifest's headless and renderer modules bundled as minified ES modules
 * with shared `chunks/*.js`, and the product string catalogs `strings/<lang>.json` — with their SHA-256 and size for
 * the `ss-pack-bundle@1` descriptor. Staff upload the written folder in the Portal (Admin → Apps → Upload pack
 * version); the e2e suite against the real Portal uses this module. Development only (Node).
 * @module
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_FORMAT, buildPack as build, descriptorOf, loadManifest as load, writePack as write } from '@ss/cli/pack';

/** The pack's root folder. */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

export { BUNDLE_FORMAT, descriptorOf };

/** The pack's manifest and built assets. */
export const buildPack = () => build(ROOT);

/**
 * The manifest with every `features: { $ref }` replaced by the schema it points to.
 * @returns {Promise<Record<string, any>>}
 */
export const loadManifest = async () => /** @type {Record<string, any>} */ ((await load(ROOT)).manifest);

/**
 * Build and write the pack to a folder (assets + `descriptor.json`).
 * @param {string} outDir
 */
export const writePack = async (outDir) => {
	const pack = await buildPack();
	await write(pack, outDir);
	return pack;
};
