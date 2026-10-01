import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateSigningKey, hashRegistrationToken } from '@ss/protocol';
import { main, SESSION_FILE, USAGE, VERSION } from '../src/cli.js';
import { exists } from '../src/fsutil.js';
import { createFakeProduct } from './helpers/fake-product.js';
import { createIo, freePort, removeDir, tempDir } from './helpers/util.js';

const TOKEN = 'rt_cli_registration_token_0123456789';
/** @type {string} */
let root;
beforeAll(async () => {
	root = await tempDir('ss-cli-main-');
});
afterAll(async () => {
	await removeDir(root);
});

/** @param {string[]} argv @param {Partial<import('../src/cli.js').CliDeps>} [deps] */
const ss = async (argv, deps = {}) => {
	const io = createIo();
	const code = await main(argv, { io: io.io, cwd: root, env: {}, ...deps });
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
		expect((await ss(['dev', 'nope'])).code).toBe(2);
	});

	it('inits and validates projects with exit codes', async () => {
		const created = await ss(['app', 'init', 'svc', '--kind', 'service', '--slug', 'cli-notes', '--name', 'CLI Notes']);
		expect(created.code).toBe(0);
		expect(created.out).toContain("Created service product 'cli-notes'");
		expect(await ss(['app', 'validate', 'svc'])).toMatchObject({ code: 0, out: expect.stringContaining('✔ valid') });
		const json = await ss(['app', 'validate', 'svc', '--json']);
		expect(JSON.parse(json.out).ok).toBe(true);
		expect((await ss(['app', 'init', 'svc', '--kind', 'pack', '--slug', 'x1', '--name', 'X'])).code).toBe(1);
		await writeFile(path.join(root, 'svc/core/extra.js'), "import '../ui/notes.js';\n");
		const invalid = await ss(['app', 'validate', 'svc']);
		expect(invalid.code).toBe(1);
		expect(invalid.out).toContain('imports.direction');
		expect((await ss(['app', 'init', 'pk', '--kind', 'pack', '--slug', 'cli-pack', '--name', 'Pack'])).code).toBe(0);
		const packCert = await ss(['certify', 'pk', '--report', 'pack-report.json']);
		expect(packCert.code).toBe(0);
		expect(JSON.parse(await readFile(path.join(root, 'pack-report.json'), 'utf8')).kind).toBe('pack');
	});

	it('prints development env values', async () => {
		const result = await ss(['dev', 'env', '--kid', 'my-kid']);
		expect(result.code).toBe(0);
		const token = /--token (\S+)/.exec(result.out)?.[1] ?? '';
		expect(result.out).toContain(`SS_REGISTRATION_TOKEN_HASH=${hashRegistrationToken(token)}`);
		expect(JSON.parse(/SS_APP_SIGNING_KEY=(.*)/.exec(result.out)?.[1] ?? '{}')).toMatchObject({
			kid: 'my-kid',
			crv: 'Ed25519',
		});
	});

	it('explains that dev subcommands need a running emulator', async () => {
		const result = await ss(['dev', 'launch', '--kind', 'merchant', '--dir', 'nowhere']);
		expect(result.code).toBe(1);
		expect(result.err).toMatch(/no running emulator/);
		expect((await ss(['dev', 'register'])).code).toBe(2);
		expect((await ss(['dev', 'launch'])).code).toBe(2);
		expect((await ss(['dev', 'emit'])).code).toBe(2);
		expect((await ss(['dev', 'entitlements'])).code).toBe(2);
		expect((await ss(['dev', 'settle', '--hours', '0'])).code).toBe(2);
		expect((await ss(['dev', 'state', '--emulator', 'http://127.0.0.1:1', '--admin-token', 't'])).err).toMatch(/not reachable/);
		expect((await ss(['dev', '--fixture', 'missing.json'])).err).toMatch(/not found/);
	});

	it('simulates settlement offline from manifest.json when no emulator runs', async () => {
		await ss(['app', 'init', 'offline', '--kind', 'service', '--slug', 'offline-notes', '--name', 'Offline']);
		const result = await ss(['dev', 'settle', '--hours', '2', '--dir', 'offline']);
		expect(result.code).toBe(0);
		expect(result.out).toMatch(/Settlement .* → /);
		expect(result.err).toContain('simulating from manifest.json');
		expect((await ss(['dev', 'settle', '--dir', 'nowhere'])).code).toBe(1);
	});

	it('runs `ss dev` with every subcommand against a live product, then certify', async () => {
		await ss(['app', 'init', 'live', '--kind', 'service', '--slug', 'live-notes', '--name', 'Live Notes']);
		const dir = path.join(root, 'live');
		const port = await freePort();
		const portalUrl = `http://127.0.0.1:${port}`;
		await writeFile(path.join(dir, 'ss.dev.json'), JSON.stringify({ portal: { url: portalUrl } }));
		await writeFile(
			path.join(dir, 'data.json'),
			JSON.stringify({
				orderId: 'ord_fromfile0001',
				currency: 'USD',
				lines: [{ itemId: 'itm_1', quantity: 1, unitAmount: 1 }],
				amounts: { subtotal: 1, total: 1 },
			}),
		);
		const { manifest } = await import('../src/manifest.js').then((module) => module.loadManifest(dir));
		const product = createFakeProduct({
			manifest,
			portalUrl,
			tokenHash: hashRegistrationToken(TOKEN),
			signingKey: (await generateSigningKey({ kid: 'cli-app-1' })).privateJwk,
		});
		const productUrl = await product.start();

		/** @type {() => void} */
		let stop = () => {};
		const stopped = new Promise((resolve) => {
			stop = () => resolve(undefined);
		});
		/** @type {(value?: unknown) => void} */
		let ready = () => {};
		const isReady = new Promise((resolve) => {
			ready = resolve;
		});
		const devIo = createIo();
		const running = main(['dev', '--dir', 'live', '--state', 'live/.ss/state.json', '--mongo-uri', 'mongodb://127.0.0.1:1'], {
			io: devIo.io,
			cwd: root,
			env: {},
			untilStopped: () => stopped.then(() => undefined),
			onServer: () => ready(),
		});
		await isReady;
		expect(devIo.out()).toContain(`Portal emulator  ${portalUrl}`);
		expect(await exists(path.join(dir, SESSION_FILE))).toBe(true);
		const d = ['--dir', 'live'];
		try {
			expect(await ss(['dev', 'register', ...d, '--url', productUrl, '--token', TOKEN])).toMatchObject({
				code: 0,
				out: expect.stringContaining('proof of possession verified'),
			});
			const launch = await ss(['dev', 'launch', ...d, '--kind', 'admin', '--scope', 'mer_devmerchant01']);
			expect(launch.out).toContain(`${productUrl}/sso?launch=`);
			expect(launch.err).toContain('admin launch');
			const keys = await ss(['dev', 'keys', ...d]);
			expect(keys.out).toMatch(/web_devwebsite01 {2}sk {2}key_\w+ {2}sk_test_/);
			const rotated = await ss(['dev', 'keys', ...d, '--rotate']);
			expect(rotated.out.trim().split('\n')).toHaveLength(2);
			const keyId = /key_\w+/.exec(keys.out)?.[0] ?? '';
			expect((await ss(['dev', 'keys', ...d, '--revoke', keyId])).out).toContain(`Revoked ${keyId}`);
			const emitted = await ss([
				'dev',
				'emit',
				'order.placed',
				...d,
				'--website',
				'web_devwebsite01',
				'--data',
				'@live/data.json',
			]);
			expect(emitted).toMatchObject({ code: 0, out: expect.stringContaining('order.placed@1') });
			expect((await ss(['dev', 'emit', 'cart.updated', ...d])).code).toBe(1);
			expect(
				(
					await ss([
						'dev',
						'entitlements',
						...d,
						'--website',
						'web_devwebsite01',
						'--element',
						'notes',
						'--enabled',
						'true',
						'--feature',
						'max_notes',
						'--value',
						'7',
					])
				).out,
			).toContain('notes.max_notes');
			expect((await ss(['dev', 'subscription', ...d, '--website', 'web_devwebsite01', '--status', 'paused'])).out).toContain(
				'subscription.paused@1',
			);
			expect((await ss(['dev', 'subscription', ...d, '--website', 'web_devwebsite01', '--status', 'active'])).out).toContain(
				'subscription.resumed@1',
			);
			expect(
				(await ss(['dev', 'resource', ...d, '--website', 'web_devwebsite01', '--kind', 'ai', '--status', 'missing'])).out,
			).toContain('"ai":"missing"');
			expect((await ss(['dev', 'subscription', ...d])).code).toBe(2);
			expect((await ss(['dev', 'resource', ...d])).code).toBe(2);
			expect((await ss(['dev', 'settle', ...d, '--hours', '2'])).out).toContain('Total');
			expect(JSON.parse((await ss(['dev', 'state', ...d])).out).apps).toHaveLength(1);
			expect(devIo.out()).toContain('registered  live-notes');
		} finally {
			stop();
			expect(await running).toBe(0);
		}
		expect(await exists(path.join(dir, SESSION_FILE))).toBe(false);
		const state = JSON.parse(await readFile(path.join(dir, '.ss/state.json'), 'utf8'));
		expect(state.apps[0].manifest.product.slug).toBe('live-notes');

		// certify reuses the ss dev state (Portal key + registered app) instead of a new handshake
		const cert = await ss(['certify', 'live', '--url', productUrl, '--state', 'live/.ss/state.json', '--json']);
		const report = JSON.parse(cert.out);
		expect(report.checks.find((/** @type {any} */ check) => check.id === 'registration.handshake').status).toBe('skip');
		expect(
			report.checks.filter((/** @type {any} */ check) => check.status === 'fail').map((/** @type {any} */ check) => check.id),
		).toEqual([]);
		expect(cert.code).toBe(0);
		await product.stop();
	}, 60_000);

	it('reports a busy port for ss dev', async () => {
		const port = await freePort();
		const { createServer } = await import('node:http');
		const blocker = createServer().listen(port, '127.0.0.1');
		await new Promise((resolve) => blocker.once('listening', resolve));
		try {
			const result = await ss(['dev', '--portal-url', `http://127.0.0.1:${port}`]);
			expect(result.code).toBe(1);
			expect(result.err).toMatch(/cannot listen/);
		} finally {
			blocker.close();
		}
	});
});
