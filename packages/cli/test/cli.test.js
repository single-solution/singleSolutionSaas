import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { main, USAGE, VERSION } from '../src/cli.js';
import { createIo, removeDir, tempDir } from './helpers/util.js';

/** @type {string} */
let root;
beforeAll(async () => {
	root = await tempDir('ss-cli-main-');
});
afterAll(async () => {
	await removeDir(root);
});

/** @param {string[]} argv */
const ss = async (argv) => {
	const io = createIo();
	const code = await main(argv, { io: io.io, cwd: root });
	return { code, out: io.out(), err: io.err() };
};

describe('ss (main)', () => {
	it('prints help and version, rejects unknown commands and options', async () => {
		expect(await ss([])).toMatchObject({ code: 0, out: USAGE });
		expect(await ss(['--version'])).toMatchObject({ code: 0, out: `${VERSION}\n` });
		expect((await ss(['nope'])).code).toBe(2);
		expect((await ss(['app', 'nope'])).code).toBe(2);
		expect((await ss(['app', 'validate', '--bogus'])).code).toBe(2);
		expect((await ss(['app', 'init'])).code).toBe(2);
		expect((await ss(['app', 'init', 'x', '--kind', 'weird'])).code).toBe(2);
		for (const removed of ['dev', 'certify']) expect((await ss([removed])).code).toBe(2);
		expect((await ss(['pack', 'publish'])).code).toBe(2);
	});

	it('inits and validates projects with exit codes', async () => {
		const created = await ss(['app', 'init', 'svc', '--kind', 'service', '--slug', 'cli-notes', '--name', 'CLI Notes']);
		expect(created.code).toBe(0);
		expect(created.out).toContain("Created service product 'cli-notes'");
		expect(created.out).toContain('pnpm dev');
		expect(await ss(['app', 'validate', 'svc'])).toMatchObject({ code: 0, out: expect.stringContaining('✔ valid') });
		expect(await ss(['app', 'assets', 'svc', '--check'])).toMatchObject({
			code: 0,
			out: expect.stringContaining('up to date'),
		});
		await writeFile(path.join(root, 'svc/app/_lib/assets.js'), '// stale\n');
		expect(await ss(['app', 'assets', 'svc', '--check'])).toMatchObject({
			code: 1,
			err: expect.stringContaining('out of date'),
		});
		expect(await ss(['app', 'assets', 'svc'])).toMatchObject({ code: 0, out: expect.stringContaining('written') });
		const json = await ss(['app', 'validate', 'svc', '--json']);
		expect(JSON.parse(json.out).ok).toBe(true);
		expect((await ss(['app', 'init', 'svc', '--kind', 'pack', '--slug', 'x1', '--name', 'X'])).code).toBe(1);
		await writeFile(path.join(root, 'svc/core/extra.js'), "import '../ui/notes.js';\n");
		const invalid = await ss(['app', 'validate', 'svc']);
		expect(invalid.code).toBe(1);
		expect(invalid.out).toContain('imports.direction');
		const pack = await ss(['app', 'init', 'pk', '--kind', 'pack', '--slug', 'cli-pack', '--name', 'Pack']);
		expect(pack).toMatchObject({ code: 0, out: expect.stringContaining('ss pack build') });
		expect((await ss(['app', 'validate', 'pk'])).code).toBe(0);
	});
});
