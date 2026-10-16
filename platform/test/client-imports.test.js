/**
 * The browser bundle of both consoles must never pull server code in: a console file that imports the server config
 * or the network package breaks `next build` (node-only modules such as `node:dns/promises` end up in the browser).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ONLY = [/['"]@ss\/net['"]/, /infra\/(config|db|http|auth|crypto|system|logger)\.js['"]/, /['"]node:/];

/** @param {string} dir @returns {Promise<string[]>} */
const filesOf = async (dir) =>
	(await readdir(dir, { withFileTypes: true, recursive: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
		.map((entry) => path.join(entry.parentPath, entry.name));

describe('console files stay browser-safe', () => {
	it('imports no server-only module', async () => {
		const bad = [];
		for (const file of await filesOf(path.join(root, 'src/console'))) {
			const imports = (await readFile(file, 'utf8')).match(/^import[^;]*from\s+['"][^'"]+['"]/gm) ?? [];
			for (const line of imports)
				if (SERVER_ONLY.some((rx) => rx.test(line))) bad.push(`${path.relative(root, file)}: ${line}`);
		}
		expect(bad).toEqual([]);
	});
});
