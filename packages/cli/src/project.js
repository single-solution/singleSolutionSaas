/**
 * The files of a product project, listed once and read through a cache (shared by `ss app validate` and
 * `ss app assets`).
 * @module
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { walk } from './fsutil.js';

/**
 * @typedef {object} ProjectFiles
 * @property {string} dir project root (absolute)
 * @property {string[]} list project-relative POSIX paths, sorted
 * @property {Set<string>} set
 * @property {(relative: string) => Promise<string>} read cached text reader
 */

/**
 * @param {string} dir
 * @returns {Promise<ProjectFiles>}
 */
export const projectFiles = async (dir) => {
	const list = await walk(dir);
	/** @type {Map<string, Promise<string>>} */
	const cache = new Map();
	return {
		dir,
		list,
		set: new Set(list),
		read: (relative) => {
			let text = cache.get(relative);
			if (text === undefined) {
				text = readFile(path.join(dir, relative), 'utf8');
				cache.set(relative, text);
			}
			return text;
		},
	};
};
