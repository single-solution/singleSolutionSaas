/**
 * Loads a project's `manifest.json` and bundles local `$ref`s so element `features` are delivered inline (PLAN F.3).
 * Only project-relative JSON files are followed (`schemas/x.json` or `schemas/x.json#/pointer`); anything else is a problem.
 * @module
 */
import path from 'node:path';
import { isObject, isSafeRelative, readJson } from './fsutil.js';

/**
 * @typedef {object} Problem
 * @property {'error' | 'warning'} severity
 * @property {string} rule stable rule id, e.g. `imports.direction`
 * @property {string} file project-relative file the problem is about
 * @property {string} [pointer] JSON Pointer inside the file
 * @property {number} [line] 1-based line inside the file
 * @property {string} message
 */

/**
 * @param {Omit<Problem, 'severity'> & { severity?: Problem['severity'] }} input
 * @returns {Problem}
 */
export const problemOf = ({ severity = 'error', ...rest }) => ({ severity, ...rest });

/**
 * Resolve a JSON Pointer inside a value.
 * @param {unknown} value
 * @param {string} pointer `''` or `/a/b`
 * @returns {{ found: true, value: unknown } | { found: false }}
 */
export const resolvePointer = (value, pointer) => {
	if (pointer === '' || pointer === '/') return { found: true, value };
	if (!pointer.startsWith('/')) return { found: false };
	/** @type {unknown} */
	let current = value;
	for (const raw of pointer.slice(1).split('/')) {
		const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
		if (Array.isArray(current) && /^\d+$/.test(token) && Number(token) < current.length) current = current[Number(token)];
		else if (isObject(current) && Object.hasOwn(current, token)) current = current[token];
		else return { found: false };
	}
	return { found: true, value: current };
};

/**
 * @typedef {object} LoadedManifest
 * @property {boolean} ok true when the file parsed and every `$ref` resolved
 * @property {unknown} raw manifest as written (null when unreadable)
 * @property {unknown} manifest manifest with `$ref`s inlined (null when unreadable)
 * @property {string[]} refs project-relative files that were inlined
 * @property {Problem[]} problems
 */

/**
 * Load and bundle `<dir>/manifest.json`.
 * @param {string} dir project root
 * @param {{ file?: string }} [options]
 * @returns {Promise<LoadedManifest>}
 */
export const loadManifest = async (dir, { file = 'manifest.json' } = {}) => {
	const read = await readJson(path.join(dir, file));
	if (!read.ok) {
		return {
			ok: false,
			raw: null,
			manifest: null,
			refs: [],
			problems: [problemOf({ rule: 'manifest.read', file, message: `manifest.json: ${read.message}` })],
		};
	}
	/** @type {Problem[]} */
	const problems = [];
	/** @type {Set<string>} */
	const refs = new Set();
	/** @type {Map<string, Promise<{ ok: true, value: unknown } | { ok: false, message: string }>>} */
	const cache = new Map();

	/**
	 * @param {unknown} node
	 * @param {string} pointer
	 * @param {number} depth
	 * @returns {Promise<unknown>}
	 */
	const inline = async (node, pointer, depth) => {
		if (Array.isArray(node)) return Promise.all(node.map((item, index) => inline(item, `${pointer}/${index}`, depth)));
		if (!isObject(node)) return node;
		if (typeof node.$ref === 'string') {
			const ref = node.$ref;
			const [target = '', fragment = ''] = ref.split('#');
			if (!isSafeRelative(target) || !target.endsWith('.json')) {
				problems.push(
					problemOf({ rule: 'manifest.ref', file, pointer, message: `$ref '${ref}' must be a project-relative .json file` }),
				);
				return node;
			}
			if (depth > 8) {
				problems.push(problemOf({ rule: 'manifest.ref', file, pointer, message: `$ref '${ref}' nests too deeply` }));
				return node;
			}
			let loading = cache.get(target);
			if (loading === undefined) {
				loading = readJson(path.join(dir, target));
				cache.set(target, loading);
			}
			const loaded = await loading;
			if (!loaded.ok) {
				problems.push(problemOf({ rule: 'manifest.ref', file, pointer, message: `$ref '${ref}': ${loaded.message}` }));
				return node;
			}
			const resolved = resolvePointer(loaded.value, fragment);
			if (!resolved.found) {
				problems.push(problemOf({ rule: 'manifest.ref', file, pointer, message: `$ref '${ref}': pointer not found` }));
				return node;
			}
			refs.add(target);
			const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$ref'));
			const inlined = await inline(resolved.value, pointer, depth + 1);
			return isObject(inlined) && Object.keys(siblings).length > 0 ? { ...inlined, ...siblings } : inlined;
		}
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const [key, value] of Object.entries(node)) out[key] = await inline(value, `${pointer}/${key}`, depth);
		return out;
	};

	const manifest = await inline(read.value, '', 0);
	return { ok: problems.length === 0, raw: read.value, manifest, refs: [...refs].sort(), problems };
};
