import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** @returns {Promise<number>} */
export const freePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
			server.close(() => resolve(port));
		});
	});

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
