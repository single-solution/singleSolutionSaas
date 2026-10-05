/**
 * Small filesystem helpers (node:fs/promises only). Paths returned by `walk` are POSIX-style and relative to the root.
 * @module
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * True when `target` exists.
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export const exists = async (target) => {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
};

/**
 * True when `target` is a directory.
 * @param {string} target
 * @returns {Promise<boolean>}
 */
export const isDirectory = async (target) => {
	try {
		return (await stat(target)).isDirectory();
	} catch {
		return false;
	}
};

/** Directories never walked. */
export const IGNORED_DIRS = Object.freeze(
	new Set(['node_modules', '.git', '.next', 'coverage', 'dist', '.ss', '.vercel', '.ss-pack-out']),
);

/**
 * Recursively list files under `root` (relative POSIX paths, sorted).
 * @param {string} root
 * @param {{ ignore?: ReadonlySet<string> }} [options]
 * @returns {Promise<string[]>}
 */
export const walk = async (root, { ignore = IGNORED_DIRS } = {}) => {
	/** @type {string[]} */
	const out = [];
	/** @param {string} relative */
	const visit = async (relative) => {
		/** @type {import('node:fs').Dirent[]} */
		let entries;
		try {
			entries = await readdir(path.join(root, relative), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				if (!ignore.has(entry.name)) await visit(child);
			} else if (entry.isFile()) out.push(child);
		}
	};
	await visit('');
	return out.sort();
};

/**
 * Parse JSON text, returning a result instead of throwing.
 * @param {string} text
 * @returns {{ ok: true, value: unknown } | { ok: false, message: string }}
 */
export const parseJson = (text) => {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return { ok: false, message: /** @type {Error} */ (error).message };
	}
};

/**
 * Read and parse a JSON file.
 * @param {string} file
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, message: string }>}
 */
export const readJson = async (file) => {
	/** @type {string} */
	let text;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		return { ok: false, message: `cannot read file (${/** @type {NodeJS.ErrnoException} */ (error).code ?? 'error'})` };
	}
	return parseJson(text);
};

/**
 * True when `relative` is a safe project-relative path (no absolute paths, no `..`, no backslashes).
 * @param {string} relative
 * @returns {boolean}
 */
export const isSafeRelative = (relative) =>
	typeof relative === 'string' &&
	relative.length > 0 &&
	!relative.startsWith('/') &&
	!relative.includes('\\') &&
	!relative.split('/').includes('..') &&
	!/^[A-Za-z]:/.test(relative);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
