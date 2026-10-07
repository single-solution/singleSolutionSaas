import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutboundPolicy } from '@ss/net';
import { loadEnv, parseAssetStorage } from '../../../src/infra/config.js';
import { assetType, checkUpload, isAssetPath, mediaType, sha256Hex } from '../../../src/modules/delivery/core/assets.js';
import {
	bundleData,
	compilePlacement,
	featureDefaults,
	keyConflicts,
	parseModuleRef,
	selectElements,
	versionedLoader,
} from '../../../src/modules/delivery/core/compile.js';
import {
	createAssetStorage,
	createFileStorage,
	createMemoryStorage,
	createS3Storage,
	withImmutableCache,
} from '../../../src/modules/delivery/storage.js';
import { testEnv } from '../../helpers.js';
import { PACK, SERVICE, packAssets, packManifest, serviceManifest } from './fixtures.js';

/** @param {Record<string, any>} [overrides] */
const doc = (overrides = {}) => ({
	runtime: { state: 'active' },
	elements: { bar: { enabled: true }, tip: { enabled: true }, launcher: { enabled: true }, inbox: { enabled: true } },
	config: { bar: { message: 'Hi', placement: { paths: { include: ['/**'] } } }, launcher: {} },
	...overrides,
});

/** @param {Record<string, any>} [overrides] @returns {any} */
const packSource = (overrides = {}) => ({
	appId: PACK,
	slug: 'notice-bar',
	kind: 'pack',
	manifestVersion: 1,
	manifest: packManifest(),
	document: doc(),
	apiBase: null,
	assets: new Map(packAssets().map((a) => [a.path, a])),
	strings: new Map([['strings/en.json', { 'bar.label': 'Notice', bad: 3 }]]),
	...overrides,
});

/** @param {Record<string, any>} [overrides] @returns {any} */
const serviceSource = (overrides = {}) => ({
	appId: SERVICE,
	slug: 'chat-box',
	kind: 'service',
	manifestVersion: 1,
	manifest: serviceManifest(),
	document: doc(),
	apiBase: 'https://chat.example.net',
	assets: new Map(packAssets().map((a) => [a.path, a])),
	strings: new Map(),
	widgets: {
		version: 3,
		elements: new Map([['launcher', { key: 'launcher', headless: 'headless/bar.js#createBar', renderer: 'ui/bar.js#render' }]]),
	},
	...overrides,
});

const keysOf = (/** @type {ReturnType<typeof selectElements>} */ out) => out.selected.map((s) => s.key);

/**
 * A `read(name)` over a plain record (as `loadConfig` passes it to `parseAssetStorage`).
 * @param {Record<string, string | undefined>} env
 */
const readOf = (env) => (/** @type {string} */ name) => env[name];

describe('element selection matrix', () => {
	it('delivers enabled mode-A elements of active subscriptions only', () => {
		expect(keysOf(selectElements([packSource(), serviceSource()]))).toEqual(['bar', 'launcher']);
		const bar = selectElements([packSource()]).selected[0];
		expect(bar).toMatchObject({
			config: { message: 'Hi' }, // placement is not element config
			placement: { paths: { include: ['/**'] } },
			strings: { 'bar.label': 'Notice' },
			headless: { path: 'headless/bar.js', name: 'createBar' },
			renderer: { path: 'ui/bar.js', name: 'render' },
			moduleVersion: 1,
			api: null,
		});
		expect(selectElements([serviceSource()]).selected[0]).toMatchObject({
			moduleVersion: 3,
			api: 'https://chat.example.net',
			readScopes: ['chat-box.read', 'chat-box.write'],
		});
		for (const state of ['paused', 'suspended', 'spend_cap', 'quota_exhausted', 'resource_missing'])
			expect(keysOf(selectElements([packSource({ document: doc({ runtime: { state, reason: 'x' } }) })]))).toEqual([]);
		expect(keysOf(selectElements([packSource({ document: doc({ elements: { bar: { enabled: false } } }) })]))).toEqual([]);
		expect(keysOf(selectElements([packSource({ document: doc({ elements: {} }) })]))).toEqual([]);
		expect(keysOf(selectElements([packSource({ document: null })]))).toEqual([]);
	});

	it('skips undeliverable elements with warnings', () => {
		const missing = selectElements([packSource({ assets: new Map([['headless/bar.js', { sha256: 'a', size: 1 }]]) })]);
		expect(missing.selected).toEqual([]);
		expect(missing.warnings).toEqual([{ code: 'assets_missing', appId: PACK, key: 'bar', detail: 'not uploaded: ui/bar.js' }]);
		const noBase = selectElements([serviceSource({ apiBase: 'http://chat.example.net' })]);
		expect(noBase.warnings[0]?.code).toBe('no_api_base');
		const noWidgets = selectElements([serviceSource({ widgets: null })]);
		expect(noWidgets).toEqual({
			selected: [],
			warnings: [
				{ code: 'widgets_missing', appId: SERVICE, key: 'launcher', detail: 'no widgets are uploaded for this element' },
			],
		});
		const manifest = packManifest();
		/** @type {any} */ (manifest.elements[0]).renderer = null;
		expect(selectElements([packSource({ manifest })]).warnings[0]?.code).toBe('no_modules');
	});

	it('namespaces element keys per product: two products may deliver the same key (F.18)', () => {
		const other = packSource({ appId: 'app_9123456789abcdefghjkmnpq', slug: 'other-bar' });
		const selected = selectElements([packSource(), other]).selected;
		expect(keyConflicts(selected)).toEqual([]);
		const data = bundleData({
			websiteId: 'web_1',
			env: 'live',
			version: '',
			publicKey: 'pk_x',
			eventsUrl: 'https://p/v1/events',
			assetBase: 'https://p/w/',
			elements: selected.map((s) => ({ ...s, compiledPlacement: null })),
		});
		expect(data.elements.map((e) => `${e.product}:${e.key}`).sort()).toEqual(['notice-bar:bar', 'other-bar:bar']);
		expect(keyConflicts([...selected, ...selected.slice(0, 1)])).toEqual([
			{ path: '/elements/notice-bar:bar', message: 'element notice-bar:bar is delivered twice' },
		]);
	});
});

describe('compiler helpers', () => {
	it('parses module refs and feature defaults', () => {
		expect(parseModuleRef('ui/a.js#render')).toEqual({ path: 'ui/a.js', name: 'render' });
		expect(parseModuleRef('ui/a.mjs#x')).toEqual({ path: 'ui/a.mjs', name: 'x' });
		for (const bad of ['/ui/a.js#x', 'ui/../a.js#x', 'ui/a.css#x', 'ui/a.js', null]) expect(parseModuleRef(bad)).toBeNull();
		expect(featureDefaults({ properties: { a: { default: 1 }, b: {} } })).toEqual({ a: 1 });
		expect(featureDefaults(null)).toEqual({});
	});

	it('validates placements and precompiles audience rules', () => {
		expect(compilePlacement(null)).toEqual({ ok: true, placement: null, audience: false });
		expect(compilePlacement({ devices: ['mobile'] })).toEqual({
			ok: true,
			placement: { devices: ['mobile'] },
			audience: false,
		});
		const compiled = compilePlacement({ audience: "device == 'mobile'" });
		expect(compiled).toMatchObject({ ok: true, audience: true, placement: { audience: { v: 1 } } });
		expect(compilePlacement({ audience: 'device ==' })).toMatchObject({ ok: false, code: 'audience_invalid' });
		expect(compilePlacement({ devices: ['watch'] })).toMatchObject({ ok: false, code: 'placement_invalid' });
	});

	it('renders deterministic, content-versioned loaders', () => {
		const { selected } = selectElements([serviceSource(), packSource()]);
		const elements = selected.map((s) => ({ ...s, compiledPlacement: s.placement }));
		const data = bundleData({
			websiteId: 'web_0123456789abcdefghjkmnpq',
			env: 'live',
			version: '',
			publicKey: 'pk_live_x',
			eventsUrl: 'https://portal.test/v1/events',
			assetBase: 'https://portal.test/w/',
			elements,
		});
		expect(data.elements.map((e) => e.key)).toEqual(['bar', 'launcher']);
		expect(data.elements[0]).toMatchObject({ headless: { path: `packs/${PACK}/1/headless/bar.js`, name: 'createBar' } });
		expect(data.elements[1]).toMatchObject({
			headless: { path: `packs/${SERVICE}/3/headless/bar.js`, name: 'createBar' },
			renderer: { path: `packs/${SERVICE}/3/ui/bar.js`, name: 'render' },
			api: 'https://chat.example.net',
		});
		const a = versionedLoader({ data, core: 'var __ssr={start(){}};', audience: null });
		const b = versionedLoader({
			data: bundleData({
				...data,
				elements: [...elements].reverse(),
				assetBase: data.assets,
				publicKey: data.key,
				eventsUrl: data.events,
			}),
			core: 'var __ssr={start(){}};',
			audience: null,
		});
		expect(a).toEqual(b);
		expect(a.version).toMatch(/^[0-9a-f]{16}$/);
		expect(a.text).toContain(`"version":"${a.version}"`);
		const c = versionedLoader({ data, core: 'var __ssr={start(){}};', audience: 'var __ssa={};' });
		expect(c.version).not.toBe(a.version);
		expect(c.text).toContain(',{audience:__ssa.evaluateAudienceProgram}');
		const changed = versionedLoader({ data: { ...data, key: 'pk_live_y' }, core: 'var __ssr={start(){}};', audience: null });
		expect(changed.version).not.toBe(a.version);
	});
});

describe('asset rules', () => {
	it('allows the listed types with caps and checks bytes against the descriptor', () => {
		expect(assetType('a/b.JS')).toMatchObject({ contentType: 'text/javascript' });
		expect(assetType('a.woff2')).toMatchObject({ contentType: 'font/woff2', maxBytes: 1024 * 1024 });
		expect(assetType('a.html')).toBeNull();
		expect(mediaType('application/javascript; charset=utf-8')).toBe('text/javascript');
		expect(mediaType(undefined)).toBe('');
		expect(isAssetPath('ui/bar.js')).toBe(true);
		for (const bad of ['', '/ui.js', 'a/../b.js', '.hidden', `${'a/'.repeat(8)}x.js`]) expect(isAssetPath(bad)).toBe(false);
		const bytes = Buffer.from('export const x = 1;');
		const declared = { path: 'x.js', sha256: sha256Hex(bytes), size: bytes.length };
		expect(checkUpload({ path: 'x.js', bytes, contentType: 'text/javascript', declared }).errors).toEqual([]);
		const codes = (/** @type {any} */ input) => checkUpload(input).errors.map((e) => e.code);
		expect(
			codes({ path: 'x.js', bytes: Buffer.from('export const x = 2;'), contentType: 'text/javascript', declared }),
		).toEqual(['sha256_mismatch']);
		expect(codes({ path: 'x.js', bytes, contentType: 'text/css', declared: { ...declared, contentType: 'text/css' } })).toEqual(
			['content_type', 'content_type'],
		);
		expect(codes({ path: 'x.js', bytes, contentType: 'text/javascript', declared: undefined })).toEqual(['not_in_descriptor']);
		expect(codes({ path: 'x.exe', bytes, contentType: 'x', declared })).toEqual(['type_not_allowed']);
		const big = Buffer.alloc(257 * 1024);
		expect(codes({ path: 'x.css', bytes: big, contentType: 'text/css', declared: { ...declared, path: 'x.css' } })).toEqual([
			'too_large',
			'size_mismatch',
			'sha256_mismatch',
		]);
	});
});

describe('asset storage adapters', () => {
	it('memory and file stores round-trip bytes and refuse unsafe keys', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ss-assets-'));
		try {
			for (const store of [createMemoryStorage(), createFileStorage(dir)]) {
				await store.put('packs/app_1/1/ui/a.js', Buffer.from('x=1'), { contentType: 'text/javascript' });
				const got = await store.get('packs/app_1/1/ui/a.js');
				expect(Buffer.from(/** @type {any} */ (got).body).toString()).toBe('x=1');
				expect(got?.contentType).toBe('text/javascript');
				expect(await store.get('packs/none.js')).toBeNull();
				await expect(store.put('../escape.js', Buffer.from(''), { contentType: 'x' })).rejects.toThrow(/invalid storage key/);
				await expect(store.get('/abs')).rejects.toThrow(/invalid storage key/);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('the S3 adapter signs requests with SigV4 and maps statuses', async () => {
		/** @type {any[]} */
		const calls = [];
		/** @type {Record<string, { status: number, body?: Buffer, type?: string }>} */
		const replies = {};
		/** @type {any} */
		const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
			calls.push({ url, init });
			const reply = replies[`${init.method} ${url}`] ?? { status: 200 };
			return {
				status: reply.status,
				headers: reply.type ? { 'content-type': reply.type } : {},
				body: reply.body ?? Buffer.alloc(0),
				url,
			};
		};
		const config = /** @type {any} */ (
			parseAssetStorage(
				readOf({
					STORAGE_ENDPOINT: 'https://s3.example.net',
					STORAGE_REGION: 'eu-west-1',
					STORAGE_BUCKET: 'ss-assets',
					STORAGE_ACCESS_KEY_ID: 'AK',
					STORAGE_SECRET_ACCESS_KEY: 'SK',
					STORAGE_PREFIX: 'v1/',
				}),
			)
		);
		const store = createS3Storage(config, {
			policy: createOutboundPolicy(),
			fetch,
			now: () => Date.parse('2026-10-01T00:00:00Z'),
		});
		await store.put('w/x/loader.js', Buffer.from('js'), { contentType: 'text/javascript', cacheControl: 'public' });
		expect(calls[0].url).toBe('https://s3.example.net/ss-assets/v1/w/x/loader.js');
		expect(calls[0].init.method).toBe('PUT');
		expect(calls[0].init.headers.authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AK\/20261001\/eu-west-1\/s3\/aws4_request/,
		);
		expect(calls[0].init.headers['x-amz-content-sha256']).toBe(sha256Hex(Buffer.from('js')));
		replies['GET https://s3.example.net/ss-assets/v1/w/x/loader.js'] = {
			status: 200,
			body: Buffer.from('js'),
			type: 'text/javascript',
		};
		expect(Buffer.from(/** @type {any} */ (await store.get('w/x/loader.js')).body).toString()).toBe('js');
		replies['GET https://s3.example.net/ss-assets/v1/w/x/none.js'] = { status: 404 };
		expect(await store.get('w/x/none.js')).toBeNull();
		replies['GET https://s3.example.net/ss-assets/v1/w/x/err.js'] = { status: 403 };
		await expect(store.get('w/x/err.js')).rejects.toThrow(/failed with 403/);
		replies['PUT https://s3.example.net/ss-assets/v1/w/x/err.js'] = { status: 500 };
		await expect(store.put('w/x/err.js', Buffer.from(''), { contentType: 'x' })).rejects.toThrow(/failed with 500/);
		expect(createAssetStorage(config, { policy: createOutboundPolicy(), fetch })?.kind).toBe('s3');
		expect(createAssetStorage({ kind: 'memory' }, { policy: createOutboundPolicy() })?.kind).toBe('memory');
		expect(createAssetStorage({ kind: 'file', dir: tmpdir() }, { policy: createOutboundPolicy() })?.kind).toBe('file');
		expect(createAssetStorage(null, { policy: createOutboundPolicy() })).toBeNull();
	});

	it('caches immutable objects with bounded memory', async () => {
		const inner = createMemoryStorage();
		let reads = 0;
		const counting = { ...inner, get: async (/** @type {string} */ k) => ((reads += 1), inner.get(k)) };
		const cache = withImmutableCache(counting, { maxEntries: 2, maxBytes: 10 });
		await inner.put('a', Buffer.from('1234'), { contentType: 't' });
		await cache.get('a');
		await cache.get('a');
		expect(reads).toBe(1);
		await cache.put('b', Buffer.from('1234'), { contentType: 't' });
		await cache.put('c', Buffer.from('1234'), { contentType: 't' });
		expect(cache.cached('a')).toBe(false); // evicted (bytes and entries bounded)
		await cache.put('huge', Buffer.alloc(11), { contentType: 't' });
		expect(cache.cached('huge')).toBe(false);
		await cache.put('c', Buffer.from('12'), { contentType: 't' });
		expect(cache.cached('c')).toBe(true);
		expect(await cache.get('missing')).toBeNull();
	});
});

describe('STORAGE_* configuration', () => {
	it('parses an S3 bucket, a directory or memory; production needs an https bucket', async () => {
		expect(parseAssetStorage(readOf({}))).toBeNull();
		expect(parseAssetStorage(readOf({ STORAGE_DIR: ':memory:' }))).toEqual({ kind: 'memory' });
		expect(parseAssetStorage(readOf({ STORAGE_DIR: '.data/assets' }))).toEqual({ kind: 'file', dir: '.data/assets' });
		const base = { STORAGE_BUCKET: 'ss-assets', STORAGE_ACCESS_KEY_ID: 'AK', STORAGE_SECRET_ACCESS_KEY: 'SK' };
		expect(parseAssetStorage(readOf(base))).toMatchObject({
			kind: 's3',
			region: 'auto',
			endpoint: null,
			prefix: '',
			forcePathStyle: null,
		});
		for (const bad of [
			{ ...base, STORAGE_DIR: '.data' },
			{ STORAGE_ENDPOINT: 'https://x' },
			{ ...base, STORAGE_BUCKET: 'X' },
			{ ...base, STORAGE_REGION: 'Bad Region' },
			{ ...base, STORAGE_SECRET_ACCESS_KEY: undefined },
			{ ...base, STORAGE_ACCESS_KEY_ID: undefined },
			{ ...base, STORAGE_PATH_STYLE: 'yes' },
			{ ...base, STORAGE_PREFIX: 'no-slash' },
			{ ...base, STORAGE_ENDPOINT: 'ftp://x' },
			{ ...base, STORAGE_ENDPOINT: 'https://x/path' },
			{ ...base, STORAGE_ENDPOINT: 'not a url' },
		])
			expect(() => parseAssetStorage(readOf(bad))).toThrow(/STORAGE_/);
		const full = parseAssetStorage(
			readOf({ ...base, STORAGE_ENDPOINT: 'https://r2.example.net/', STORAGE_PATH_STYLE: 'true', STORAGE_PREFIX: 'a/b/' }),
		);
		expect(full).toMatchObject({
			endpoint: 'https://r2.example.net',
			sessionToken: null,
			forcePathStyle: true,
			prefix: 'a/b/',
		});

		expect(loadEnv(await testEnv()).delivery).toEqual({ storage: null });
		expect(loadEnv(await testEnv({ STORAGE_DIR: ':memory:' })).delivery).toEqual({ storage: { kind: 'memory' } });
		const prod = await testEnv({ NODE_ENV: 'production' });
		expect(() => loadEnv({ ...prod, STORAGE_DIR: ':memory:' })).toThrow(
			/S3-compatible bucket \(STORAGE_BUCKET\) in production/,
		);
		expect(() => loadEnv({ ...prod, ...base, STORAGE_ENDPOINT: 'http://minio:9000' })).toThrow(/must use https in production/);
		expect(loadEnv({ ...prod, ...base, STORAGE_ENDPOINT: 'https://r2.example.net' }).delivery.storage?.kind).toBe('s3');
		const bogus = await testEnv({ STORAGE_BUCKET: 'Bogus!' });
		expect(() => loadEnv(bogus)).toThrow(/STORAGE_BUCKET is not a valid/);
	});
});
