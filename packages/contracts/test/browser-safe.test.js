/**
 * @ss/contracts is bundled into browser code (dashboards and widgets): no source file may import a Node built-in, or
 * `next build` fails with "does not support external modules (node:…)".
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

describe('contracts stay browser-safe', () => {
	it('no source file imports a Node built-in', async () => {
		const bad = [];
		for (const entry of await readdir(src, { withFileTypes: true, recursive: true })) {
			if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
			const file = path.join(entry.parentPath, entry.name);
			if (/from\s+['"]node:/.test(await readFile(file, 'utf8'))) bad.push(path.relative(src, file));
		}
		expect(bad).toEqual([]);
	});
});
