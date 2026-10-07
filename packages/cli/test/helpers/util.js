import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** @param {string} [prefix] */
export const tempDir = (prefix = 'ss-cli-') => mkdtemp(path.join(tmpdir(), prefix));

/** @param {string} dir */
export const removeDir = (dir) => rm(dir, { recursive: true, force: true });

/** Collecting io for main(). */
export const createIo = () => {
	const out = /** @type {string[]} */ ([]);
	const err = /** @type {string[]} */ ([]);
	return {
		io: { out: (/** @type {string} */ text) => void out.push(text), err: (/** @type {string} */ text) => void err.push(text) },
		out: () => out.join(''),
		err: () => err.join(''),
	};
};
