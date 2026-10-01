/**
 * The pack as the Portal receives it: the manifest with its feature schemas inline, and the browser assets (the
 * built element modules and the string catalog) with their SHA-256 and size for the signed `ss-pack-bundle@1`
 * descriptor. Used to publish the pack (Admin → Apps → upload) and by the system test against the real Portal.
 * @module
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The pack's root folder. */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

const TYPES = Object.freeze({ js: 'text/javascript', json: 'application/json' });

/**
 * @param {string} dir
 * @param {string} relative
 */
const readJson = async (dir, relative) => JSON.parse(await readFile(path.join(dir, relative), 'utf8'));

/**
 * The manifest with every `features: { $ref }` replaced by the schema it points to.
 * @param {string} [dir]
 * @returns {Promise<Record<string, any>>}
 */
export const loadManifest = async (dir = ROOT) => {
	const manifest = await readJson(dir, 'manifest.json');
	const elements = await Promise.all(
		manifest.elements.map(async (/** @type {Record<string, any>} */ element) =>
			typeof element.features?.$ref === 'string'
				? { ...element, features: await readJson(dir, element.features.$ref) }
				: element,
		),
	);
	return { ...manifest, elements };
};

/**
 * Asset paths the Portal must hold: every element's headless and renderer module and every string catalog.
 * @param {Record<string, any>} manifest
 * @returns {string[]}
 */
export const assetPaths = (manifest) => [
	...new Set(
		manifest.elements.flatMap((/** @type {Record<string, any>} */ element) =>
			[element.headless, element.renderer, element.strings]
				.filter((ref) => typeof ref === 'string')
				.map((ref) => String(ref).split('#')[0] ?? ''),
		),
	),
];

/**
 * The assets with their bytes and descriptor entries.
 * @param {string} [dir]
 * @returns {Promise<Array<{ path: string, bytes: Buffer, sha256: string, size: number, contentType: string }>>}
 */
export const packAssets = async (dir = ROOT) => {
	const manifest = await readJson(dir, 'manifest.json');
	return Promise.all(
		assetPaths(manifest).map(async (relative) => {
			const bytes = await readFile(path.join(dir, relative));
			const ext = /** @type {keyof typeof TYPES} */ (relative.slice(relative.lastIndexOf('.') + 1));
			return {
				path: relative,
				bytes,
				sha256: createHash('sha256').update(bytes).digest('hex'),
				size: bytes.byteLength,
				contentType: TYPES[ext] ?? 'application/octet-stream',
			};
		}),
	);
};
