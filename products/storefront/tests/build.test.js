/** The committed browser modules are exactly what the sources build to (esbuild needs the Node environment). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOURCES, buildModules } from '../scripts/build.js';
import { ROOT } from './helpers.js';

describe('scripts/build.js', () => {
	it('builds one headless and one renderer module per element, identical to the committed ones', async () => {
		const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
		const modules = await buildModules();
		expect(modules.filter((module) => module.path.endsWith('.js'))).toHaveLength(manifest.elements.length * 2);
		// each element ships only its own strings, all of them from strings/en.json
		const catalog = JSON.parse(readFileSync(path.join(ROOT, 'strings/en.json'), 'utf8'));
		for (const module of modules.filter((m) => m.path.endsWith('.json')))
			for (const [key, value] of Object.entries(JSON.parse(module.text)))
				expect(catalog[key], `${module.path} ${key}`).toBe(value);
		for (const module of modules) expect(readFileSync(path.join(ROOT, module.path), 'utf8'), module.path).toBe(module.text);
		expect(Object.keys(SOURCES).sort()).toEqual(manifest.elements.map((/** @type {any} */ e) => e.key).sort());
		for (const module of modules) expect(module.text, module.path).not.toMatch(/(^|[;\n])import[\s{]/);
	});
});
