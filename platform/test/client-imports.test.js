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

/** @param {string} source */
const isClientFile = (source) => /^(\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*['"]use client['"]/.test(source);

describe('server routes read only components from client files', () => {
	// A server file that imports a plain value (a list, a constant) from a 'use client' file gets a client reference,
	// not the value, and the page fails with "This could not be loaded" (My account parts, 2026-10-21). Shared values
	// belong in plain modules such as the paths files.
	it('imports no plain value from a use client file', async () => {
		const bad = [];
		for (const file of await filesOf(path.join(root, 'app'))) {
			const source = await readFile(file, 'utf8');
			if (isClientFile(source)) continue;
			for (const [, names, spec] of source.matchAll(/^import\s*\{([^}]*)\}\s*from\s+['"](\.[^'"]+)['"]/gm)) {
				const target = path.resolve(path.dirname(file), spec ?? '');
				const targetSource = await readFile(target, 'utf8').catch(() => '');
				if (!isClientFile(targetSource)) continue;
				const values = (names ?? '')
					.split(',')
					.map((name) => name.trim().split(/\s+as\s+/)[0])
					.filter((name) => name && !/^[A-Z][a-z]/.test(name));
				if (values.length) bad.push(`${path.relative(root, file)}: ${values.join(', ')} from ${spec}`);
			}
		}
		expect(bad).toEqual([]);
	});
});
