import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateSigningKey, verifyBundle } from '@ss/protocol';
import { main } from '../src/cli.js';
import { initApp } from '../src/init.js';
import {
	BUNDLE_FORMAT,
	PACK_OUT_DIR,
	assetOf,
	buildPack,
	bundleModules,
	descriptorOf,
	elementModules,
	measurePack,
	moduleEntries,
	publishPack,
} from '../src/pack/index.js';
import { budgetHeadroom, checkBudgets, checkStringSlices, inStringSlice, validateProject } from '../src/validate/index.js';
import { createIo, removeDir, tempDir } from './helpers/util.js';

/** @type {string} */
let root;
let counter = 0;
beforeAll(async () => {
	root = await tempDir('ss-pack-');
});
afterAll(async () => {
	await removeDir(root);
});

const project = async (/** @type {'service' | 'pack'} */ kind = 'pack') => {
	counter += 1;
	const dir = path.join(root, `p${counter}`);
	await initApp({ dir, kind, slug: 'demo-notes', name: 'Demo Notes' });
	return dir;
};
/** @param {string} dir @param {string} file @param {(text: string) => string} change */
const edit = async (dir, file, change) => writeFile(path.join(dir, file), change(await readFile(path.join(dir, file), 'utf8')));

/** @param {string[]} argv @param {Record<string, any>} [deps] */
const ss = async (argv, deps = {}) => {
	const io = createIo();
	const code = await main(argv, { io: io.io, cwd: root, env: {}, ...deps });
	return { code, out: io.out(), err: io.err() };
};

/** A fake Portal admin pack API (`POST /v1/admin/packs`, `PUT …/assets/*`, lifecycle). */
const fakePortal = (/** @type {{ fail?: string }} */ { fail } = {}) => {
	/** @type {Array<{ method: string, url: string, headers: Record<string, string>, body: any }>} */
	const calls = [];
	/** @type {typeof globalThis.fetch} */
	const fetch = async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
		const headers = /** @type {Record<string, string>} */ (init.headers ?? {});
		const body = init.body instanceof Uint8Array ? Buffer.from(init.body) : JSON.parse(String(init.body ?? 'null'));
		calls.push({ method: String(init.method), url: String(url), headers, body });
		if (fail && String(url).includes(fail))
			return new Response(JSON.stringify({ detail: 'nope' }), {
				status: 422,
				headers: { 'content-type': 'application/json' },
			});
		if (String(url).endsWith('/v1/admin/packs'))
			return Response.json({ app: { appId: 'app_1', status: 'pending' }, version: { version: 3 } }, { status: 201 });
		if (String(url).endsWith('/lifecycle')) return Response.json({ status: 'active' });
		if (String(url).includes('/bad-json')) return new Response('<html>', { status: 500 });
		return Response.json({ ok: true });
	};
	return { fetch, calls };
};

describe('ss pack build', () => {
	it('bundles the manifest modules with shared chunks, the catalogs and a descriptor', async () => {
		const dir = await project();
		const pack = await buildPack(dir);
		const paths = pack.assets.map((a) => a.path);
		expect(paths).toEqual(expect.arrayContaining(['headless/notes.js', 'ui/notes.js', 'strings/en.json']));
		expect(paths.some((p) => p.startsWith('chunks/'))).toBe(true);
		expect(pack.manifest.elements[0].features.type).toBe('object');
		const descriptor = descriptorOf(pack);
		expect(descriptor.format).toBe(BUNDLE_FORMAT);
		expect(descriptor.assets.every((a) => /^[0-9a-f]{64}$/.test(a.sha256) && a.size > 0)).toBe(true);
		const measured = measurePack(pack);
		expect(measured.elements[0]?.key).toBe('notes');
		expect(measured.missing).toEqual([]);
		// deterministic
		expect((await buildPack(dir)).assets.map((a) => a.sha256)).toEqual(pack.assets.map((a) => a.sha256));
		const built = await ss(['pack', 'build', dir]);
		expect(built.code, built.err).toBe(0);
		expect(built.out).toContain('budget notes');
		expect(JSON.parse(await readFile(path.join(dir, PACK_OUT_DIR, 'descriptor.json'), 'utf8')).format).toBe(BUNDLE_FORMAT);
		const json = await ss(['pack', 'build', dir, '--out', 'out', '--json']);
		expect(JSON.parse(json.out)).toMatchObject({
			out: path.join(dir, 'out'),
			budget: { shared: { modules: expect.any(Array) } },
		});
		expect(await ss(['pack', 'nope'])).toMatchObject({ code: 2 });
		expect((await ss(['pack', 'build', path.join(root, 'missing')])).code).toBe(1);
	});

	it('helpers: entries, element modules, asset types, empty bundles', async () => {
		const manifest = {
			elements: [
				{ key: 'a', modes: ['A', 'B'], headless: 'headless/a.js#x', renderer: 'ui/a.js#y' },
				{ key: 'b', modes: ['B'], headless: 'headless/a.js#z', renderer: null },
				{ key: 'c', modes: ['C'] },
			],
		};
		expect(moduleEntries(manifest)).toEqual(['headless/a.js', 'ui/a.js']);
		expect(moduleEntries({})).toEqual([]);
		expect(elementModules(manifest)).toEqual([{ key: 'a', modules: ['headless/a.js', 'ui/a.js'] }]);
		expect(elementModules({})).toEqual([]);
		expect(assetOf('a.css', Buffer.from('x')).contentType).toBe('text/css');
		expect(assetOf('a.bin', Buffer.from('x')).contentType).toBe('application/octet-stream');
		expect(await bundleModules({ dir: root, entries: [] })).toEqual([]);
	});
});

describe('ss pack publish', () => {
	it('signs the descriptor and uploads it and every asset with a staff API token', async () => {
		const dir = await project();
		const pack = await buildPack(dir);
		const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'dev-1' });
		const portal = fakePortal();
		const result = await publishPack({
			pack,
			portalUrl: 'https://portal.test/',
			token: 'sst_x',
			signingKey: /** @type {any} */ (privateJwk),
			fetch: portal.fetch,
			activate: true,
		});
		expect(result).toEqual({ appId: 'app_1', version: 3, uploaded: pack.assets.length, status: 'active' });
		const [upload, ...rest] = portal.calls;
		expect(upload?.headers.authorization).toBe('Bearer sst_x');
		expect(upload?.headers['idempotency-key']).toMatch(/^ss-pack-/);
		expect(await verifyBundle({ descriptor: upload?.body.descriptor, signature: upload?.body.signature, publicJwk })).toBe(
			true,
		);
		expect(rest.filter((c) => c.method === 'PUT').map((c) => c.url)).toEqual(
			pack.assets.map((a) => `https://portal.test/v1/admin/packs/app_1/versions/3/assets/${a.path}`),
		);
		// failures and a Portal without a version are errors
		await expect(
			publishPack({
				pack,
				portalUrl: 'https://portal.test',
				token: 't',
				signingKey: /** @type {any} */ (privateJwk),
				fetch: fakePortal({ fail: '/assets/' }).fetch,
			}),
		).rejects.toMatchObject({ code: 'publish_failed', status: 422 });
		/** @type {typeof fetch} */
		const empty = async () => Response.json({});
		await expect(
			publishPack({
				pack,
				portalUrl: 'https://portal.test',
				token: 't',
				signingKey: /** @type {any} */ (privateJwk),
				fetch: empty,
			}),
		).rejects.toMatchObject({ code: 'publish_failed' });
		/** @type {typeof fetch} */
		const broken = async () => new Response('<html>', { status: 500 });
		await expect(
			publishPack({
				pack,
				portalUrl: 'https://portal.test',
				token: 't',
				signingKey: /** @type {any} */ (privateJwk),
				fetch: broken,
			}),
		).rejects.toMatchObject({ status: 500 });

		// the command: options or env, a key inline or @file
		await writeFile(path.join(root, 'dev-key.json'), JSON.stringify(privateJwk));
		const cli = fakePortal();
		const published = await ss(
			['pack', 'publish', dir, '--portal', 'https://portal.test', '--token', 'sst_y', '--key', '@dev-key.json'],
			{
				fetch: cli.fetch,
			},
		);
		expect(published.code, published.err).toBe(0);
		expect(published.out).toContain('Published app_1 version 3');
		const viaEnv = await ss(['pack', 'publish', dir, '--activate'], {
			fetch: fakePortal().fetch,
			env: { SS_PORTAL_URL: 'https://portal.test', SS_ADMIN_TOKEN: 'sst_z', SS_PACK_SIGNING_KEY: JSON.stringify(privateJwk) },
		});
		expect(viaEnv.out).toContain('active');
		expect((await ss(['pack', 'publish', dir])).code).toBe(2);
		expect((await ss(['pack', 'publish', dir, '--portal', 'https://p'])).code).toBe(2);
		expect((await ss(['pack', 'publish', dir, '--portal', 'https://p', '--token', 't'])).code).toBe(2);
		const badKey = await ss(['pack', 'publish', dir, '--portal', 'https://p', '--token', 't', '--key', '{"kty":"OKP"}']);
		expect(badKey.code).toBe(1);
		expect(badKey.err).toContain('private Ed25519 JWK');
	});
});

describe('measured budgets in ss app validate (F.18)', () => {
	it('warns on padding, undeclared and exceeded shared chunks, and unbundlable modules', async () => {
		const dir = await project();
		const files = /** @type {any} */ ({ dir, set: new Set(['ui/notes.js']) });
		/** @param {Record<string, any>} change */
		const manifest = (change = {}) =>
			/** @type {any} */ ({
				elements: [{ key: 'notes', modes: ['A', 'B'], renderer: 'ui/notes.js#render', budget: { js: 3 } }],
				...change,
			});
		/** A build whose sizes measure as asked: one entry and, when `shared` > 0, a chunk it imports. */
		const build = (/** @type {number} */ own, /** @type {number} */ shared) => async () => ({
			manifest: manifest(),
			assets: [
				assetOf('ui/notes.js', Buffer.concat([Buffer.from(shared > 0 ? 'import"./chunks/c.js";' : ''), randomish(own)])),
				...(shared > 0 ? [assetOf('ui/chunks/c.js', randomish(shared))] : []),
			],
		});
		const rulesOf = async (/** @type {any} */ m, /** @type {any} */ b) =>
			(await checkBudgets(files, m, { build: b })).map((p) => `${p.rule}@${p.pointer}`);
		expect(await rulesOf(manifest(), build(2048, 0))).toEqual([]);
		expect(await rulesOf(manifest({ elements: [{ ...manifest().elements[0], budget: { js: 9 } }] }), build(2048, 0))).toEqual([
			'budget.padded@/elements/0/budget/js',
		]);
		expect(await rulesOf(manifest(), build(4096, 0))).toEqual(['budget.estimate@/elements/0/budget/js']);
		expect(await rulesOf(manifest(), build(2048, 3000))).toEqual(['budget.shared@/budget']);
		expect(await rulesOf(manifest({ budget: { shared: 1 } }), build(2048, 3000))).toEqual(['budget.shared@/budget/shared']);
		expect(await rulesOf(manifest({ budget: { shared: 9 } }), build(2048, 600))).toEqual(['budget.padded@/budget/shared']);
		expect(await rulesOf(manifest({ budget: { shared: 0 } }), build(2048, 0))).toEqual([]);
		expect(
			await rulesOf(manifest(), async () => {
				throw new Error('Could not resolve "x"\nmore');
			}),
		).toEqual(['budget.build@undefined']);
		expect(await checkBudgets(/** @type {any} */ ({ dir, set: new Set() }), manifest(), { build: build(1, 0) })).toEqual([]);
		expect(budgetHeadroom(0.3)).toBe(2);
		expect(budgetHeadroom(10.2)).toBe(14);
	});

	it('checks string slices against the product catalog', async () => {
		const dir = await project();
		await edit(dir, 'manifest.json', (text) => text.replace('"strings": "strings/en.json",', '"stringKeys": ["other.*"],'));
		const report = await validateProject(dir);
		expect(report.problems.map((p) => p.rule)).toContain('strings.slice');
		expect(inStringSlice(['a.*', 'b'], 'a.x')).toBe(true);
		expect(inStringSlice(['a.*', 'b'], 'b')).toBe(true);
		expect(inStringSlice(['a.*', 'b'], 'c')).toBe(false);
		const none = await checkStringSlices(
			/** @type {any} */ ({ set: new Set(), read: async () => '' }),
			/** @type {any} */ ({
				elements: [{ key: 'x', modes: ['A'], renderer: 'ui/missing.js#r' }],
			}),
		);
		expect(none).toEqual([]);
	});
});

/** Bytes that gzip to roughly their own size (incompressible). @param {number} size */
const randomish = (size) => {
	const out = Buffer.alloc(size);
	let x = 2463534242;
	for (let i = 0; i < size; i += 1) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		out[i] = x & 0xff;
	}
	return out;
};
