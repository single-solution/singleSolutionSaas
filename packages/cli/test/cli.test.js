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
		expect(await ss(['--help'])).toMatchObject({ code: 0, out: USAGE });
		expect(await ss(['-v'])).toMatchObject({ code: 0, out: `${VERSION}\n` });
		expect((await ss(['nope'])).code).toBe(2);
		expect((await ss(['app'])).code).toBe(2);
		expect((await ss(['app', 'nope'])).code).toBe(2);
		expect((await ss(['app', 'validate', '--bogus'])).code).toBe(2);
		expect((await ss(['app', 'init'])).code).toBe(2);
		expect((await ss(['app', 'init', 'x', '--id', 'x1'])).err).toContain('needs --id and --name');
	});

	it('inits, validates and regenerates assets with exit codes', async () => {
		const created = await ss([
			'app',
			'init',
			'demo',
			'--id',
			'demo',
			'--name',
			'Demo',
			'--base-url',
			'https://demo.example.com',
		]);
		expect(created).toMatchObject({ code: 0, out: expect.stringContaining("Created product 'demo' in demo") });
		expect(await ss(['app', 'validate', 'demo'])).toMatchObject({ code: 0, out: expect.stringContaining('✔ valid') });
		expect(JSON.parse((await ss(['app', 'validate', 'demo', '--json'])).out).ok).toBe(true);
		expect(await ss(['app', 'assets', 'demo', '--check'])).toMatchObject({
			code: 0,
			out: 'openapi.json is up to date\napi/widget-script.js is up to date\n',
		});
		await writeFile(path.join(root, 'demo/api/widget-script.js'), '// stale\n');
		expect(await ss(['app', 'assets', 'demo', '--check'])).toMatchObject({
			code: 1,
			err: 'api/widget-script.js out of date: run ss app assets\n',
		});
		expect(await ss(['app', 'assets', 'demo'])).toMatchObject({
			code: 0,
			out: expect.stringContaining('api/widget-script.js written'),
		});
		expect((await ss(['app', 'init', 'demo', '--id', 'demo', '--name', 'Demo'])).code).toBe(1);
		expect((await ss(['app', 'init', 'other', '--id', 'Bad', '--name', 'Demo'])).err).toContain('--id must be');
		await writeFile(path.join(root, 'demo/core/extra.js'), "import '../ui/dom.js';\n");
		const invalid = await ss(['app', 'validate', 'demo']);
		expect(invalid).toMatchObject({ code: 1, out: expect.stringContaining('imports.direction') });
	}, 60_000);
});
