/**
 * Bundle-budget measurement (Node only: `node:zlib`), the one function `ss app validate` and the Portal's delivery
 * compiler both use (F.18), so an estimate and a delivery refusal always agree.
 *
 * What is measured is what ships: the minified, bundled ES modules of a pack or service UI bundle (`ss pack build`
 * output), gzip level 9. An element's own size is the gzip size of its entry modules (headless + renderer). A module
 * that several elements name as an entry, and every chunk reachable through relative imports (code splitting), is
 * **shared**: it loads once per page whatever elements are on it, so it counts once, against the product-level
 * `budget.shared`, never against an element's `budget.js`.
 * @module
 */
import path from 'node:path';
import { gzipSync } from 'node:zlib';

/** The gzip level every budget measurement uses. */
export const GZIP_LEVEL = 9;

/** Relative module specifiers of static imports, re-exports and literal dynamic imports. */
const IMPORT =
	/(?:\bimport|\bexport)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?["'](\.{1,2}\/[^"'\s]+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"'\s]+)["']\s*\)/g;

/**
 * Gzip size of some bytes or text.
 * @param {Uint8Array | string} content
 * @returns {number}
 */
export const gzipSize = (content) =>
	gzipSync(typeof content === 'string' ? Buffer.from(content, 'utf8') : content, { level: GZIP_LEVEL }).byteLength;

/**
 * Bytes as KB with one decimal, rounded up (the unit of `budget.js` / `budget.shared` and of every report).
 * @param {number} bytes
 * @returns {number}
 */
export const toKb = (bytes) => Math.ceil(bytes / 102.4) / 10;

/**
 * Relative import specifiers of a bundled module (esbuild output: `import{a}from"./chunks/x.js"`, `import"./y.js"`,
 * `import("./z.js")`).
 * @param {string} text
 * @returns {string[]}
 */
export const relativeImports = (text) => [...text.matchAll(IMPORT)].map((match) => String(match[1] ?? match[2]));

/**
 * The module path a relative specifier names, relative to the bundle root (null when it leaves the root).
 * @param {string} from importing module path
 * @param {string} specifier
 * @returns {string | null}
 */
export const resolveModule = (from, specifier) => {
	const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
	return joined.startsWith('..') || path.posix.isAbsolute(joined) ? null : joined;
};

/**
 * @typedef {object} MeasureInput
 * @property {ReadonlyArray<{ key: string, modules: ReadonlyArray<string> }>} elements each element's entry modules
 * @property {(path: string) => Uint8Array | string | null | undefined} read bytes of a bundle file (null: absent)
 * @property {(path: string) => number | undefined} [gzip] cached gzip size of a file (default: computed)
 */

/**
 * @typedef {object} Measurement
 * @property {Array<{ key: string, modules: string[], gzipBytes: number, kb: number }>} elements own entry modules
 * @property {{ modules: string[], gzipBytes: number, kb: number }} shared shared entries and chunks, each once
 * @property {string[]} missing modules named or imported but absent
 */

/**
 * Measure elements and their shared code from bundle files.
 * @param {MeasureInput} input
 * @returns {Measurement}
 */
export const measureBundle = ({ elements, read, gzip }) => {
	/** @type {Map<string, number>} */
	const sizes = new Map();
	/** @type {Set<string>} */
	const missing = new Set();
	/** @param {string} file */
	const sizeOf = (file) => {
		const known = sizes.get(file);
		if (known !== undefined) return known;
		const cached = gzip?.(file);
		const content = cached === undefined ? read(file) : null;
		const size = cached ?? (content === null || content === undefined ? 0 : gzipSize(content));
		if (cached === undefined && (content === null || content === undefined)) missing.add(file);
		sizes.set(file, size);
		return size;
	};
	/** @type {Map<string, number>} entry module → how many elements name it */
	const uses = new Map();
	for (const element of elements) for (const module of new Set(element.modules)) uses.set(module, (uses.get(module) ?? 0) + 1);
	/** @type {Set<string>} */
	const shared = new Set([...uses].filter(([, count]) => count > 1).map(([module]) => module));
	/** @type {Set<string>} */
	const visited = new Set();
	/** @param {string} file */
	const walk = (file) => {
		if (visited.has(file)) return;
		visited.add(file);
		const content = read(file);
		if (content === null || content === undefined) {
			missing.add(file);
			return;
		}
		const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
		for (const specifier of relativeImports(text)) {
			const target = resolveModule(file, specifier);
			if (target === null) continue;
			if (!uses.has(target) || uses.get(target) !== 1) shared.add(target);
			walk(target);
		}
	};
	for (const module of uses.keys()) walk(module);
	const own = elements.map((element) => {
		const modules = [...new Set(element.modules)].filter((module) => !shared.has(module));
		const gzipBytes = modules.reduce((sum, module) => sum + sizeOf(module), 0);
		return { key: element.key, modules, gzipBytes, kb: toKb(gzipBytes) };
	});
	const sharedModules = [...shared].sort();
	const sharedBytes = sharedModules.reduce((sum, module) => sum + sizeOf(module), 0);
	return {
		elements: own,
		shared: { modules: sharedModules, gzipBytes: sharedBytes, kb: toKb(sharedBytes) },
		missing: [...missing].sort(),
	};
};
