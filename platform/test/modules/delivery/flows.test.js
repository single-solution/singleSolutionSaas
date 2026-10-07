import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { closeMongoClients } from '../../../src/infra/db.js';
import { startMongo } from '../../helpers.js';
import {
	M1,
	M2,
	PACK,
	SERVICE,
	STAFF_ACTOR,
	W1,
	W2,
	WIDGET_FILES,
	bootDelivery,
	fileBytes,
	packAssets,
	widgetDescriptor,
} from './fixtures.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

/** @param {Parameters<typeof bootDelivery>[0] extends infer T ? Partial<T> : never} [options] */
const boot = (options = {}) => bootDelivery({ db: mongo.db(), ...options });

/** @param {{ status: number, json: any, text?: string }} res @param {number} status @param {string} [code] */
const problemOf = (res, status, code) => {
	if (res.status !== status || (code && !String(res.json?.type).endsWith(`/${code}`)))
		throw new Error(`expected ${status} ${code ?? ''}, got ${res.status} ${res.text ?? JSON.stringify(res.json)}`);
	return res.json;
};

const SITE = `/v1/merchants/${M1}/websites/${W1}`;

describe('pack asset uploads', () => {
	it('stores assets whose bytes match the descriptor and refuses everything else', async () => {
		const t = await boot();
		const staff = await t.cookie({ kind: 'staff', roles: ['admin'] });
		const put = (/** @type {string} */ path, /** @type {Uint8Array | string} */ raw, type = 'text/javascript', c = staff) =>
			t.request('PUT', `/v1/admin/packs/${PACK}/versions/1/assets/${path}`, {
				raw,
				cookie: c,
				headers: { 'content-type': type },
			});

		// tampered bytes → hash mismatch
		const tampered = Buffer.from(fileBytes('headless/bar.js').toString('utf8').replace('dismissed', 'gone!!!!!'));
		const mismatch = problemOf(await put('headless/bar.js', tampered), 422, 'delivery_asset_mismatch');
		expect(mismatch.errors.map((/** @type {any} */ e) => e.code)).toContain('sha256_mismatch');
		// not in the descriptor, wrong content type, disallowed type, unknown version, merchants
		problemOf(await put('headless/other.js', 'x'), 422, 'delivery_asset_mismatch');
		problemOf(await put('headless/bar.js', fileBytes('headless/bar.js'), 'text/plain'), 415, 'unsupported_media_type');
		problemOf(await put('bin/run.exe', 'x', 'application/octet-stream'), 415, 'unsupported_media_type');
		problemOf(
			await t.request('PUT', `/v1/admin/packs/${PACK}/versions/9/assets/ui/bar.js`, {
				raw: 'x',
				cookie: staff,
				headers: { 'content-type': 'text/javascript' },
			}),
			404,
			'not_found',
		);
		problemOf(await put('ui/bar.js', fileBytes('ui/bar.js'), 'text/javascript', await t.cookie()), 401);
		// a service product without that widget version
		problemOf(
			await t.request('PUT', `/v1/admin/packs/${SERVICE}/versions/1/assets/ui/bar.js`, {
				raw: 'x',
				cookie: staff,
				headers: { 'content-type': 'text/javascript' },
			}),
			404,
			'not_found',
		);

		// the real bytes (binary too) are accepted, idempotently
		const ok = await put('headless/bar.js', fileBytes('headless/bar.js'));
		expect(ok.status).toBe(200);
		expect(ok.json).toMatchObject({
			path: 'headless/bar.js',
			changed: true,
			status: 'uploading',
			missing: ['ui/bar.js', 'strings/en.json', 'img/logo.png'],
		});
		expect((await put('headless/bar.js', fileBytes('headless/bar.js'))).json.changed).toBe(false);
		const png = await put('img/logo.png', fileBytes('img/logo.png'), 'image/png');
		expect(png.status).toBe(200);

		// served immutable, byte for byte, with CORS for module scripts
		const served = await t.request('GET', `/w/packs/${PACK}/1/img/logo.png`);
		expect(served.status).toBe(200);
		expect(Buffer.from(served.bytes).equals(fileBytes('img/logo.png'))).toBe(true);
		expect(served.headers.get('content-type')).toBe('image/png');
		expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(served.headers.get('access-control-allow-origin')).toBe('*');
		expect(served.headers.get('content-security-policy')).toContain('sandbox');
		const js = await t.request('GET', `/w/packs/${PACK}/1/headless/bar.js`);
		expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
		const etag = /** @type {string} */ (js.headers.get('etag'));
		expect((await t.request('GET', `/w/packs/${PACK}/1/headless/bar.js`, { headers: { 'if-none-match': etag } })).status).toBe(
			304,
		);
		problemOf(await t.request('GET', `/w/packs/${PACK}/1/ui/bar.js`), 404, 'not_found');

		const audit = await t.db.collection('platform_audit').find({ action: 'delivery.asset_uploaded' }).toArray();
		expect(audit).toHaveLength(2);
		// an already accepted version is not made ready again
		await t.uploadAll(PACK);
		expect(t.world.ready).toEqual([]);
	});

	it('makes an uploading pack version current when its last asset lands, then recompiles subscribed websites', async () => {
		const t = await boot();
		await t.uploadAll(PACK);
		await t.subscribe(W1, PACK);
		const entry = /** @type {any} */ (t.world.apps.get(PACK));
		entry.versions.set(2, { ...entry.versions.get(1), status: 'uploading', assets: packAssets() });
		entry.versions.set(3, { ...entry.versions.get(1), status: 'superseded' });
		const before = Number((await t.db.collection('delivery_aliases').findOne({ websiteId: W1 }))?.requested);
		await t.uploadAll(PACK, 2, ['headless/bar.js', 'ui/bar.js', 'strings/en.json']);
		expect(t.world.ready).toEqual([]);
		await t.uploadAll(PACK, 2, ['img/logo.png']);
		expect(t.world.ready).toEqual([{ appId: PACK, version: 2 }]);
		expect(entry.app.currentVersion).toBe(2);
		expect(Number((await t.db.collection('delivery_aliases').findOne({ websiteId: W1 }))?.requested)).toBe(before + 1);
		await expect(t.uploadAll(PACK, 3)).rejects.toThrow(/409/);
	});
});

describe('compile and serve', () => {
	it('compiles the enabled mode-A elements and serves alias and immutable versions', async () => {
		const t = await boot();
		await t.uploadAll(PACK);
		const owner = await t.cookie();
		const pack = await t.subscribe(W1, PACK);

		const first = await t.request('POST', `${SITE}/delivery/compile`, { cookie: owner });
		expect(first.status).toBe(200);
		expect(first.json).toMatchObject({ changed: true, previousVersion: null });
		const v1 = first.json.version;
		expect(v1).toMatch(/^[0-9a-f]{16}$/);
		expect(first.json.artefact.elements).toEqual([{ appId: PACK, slug: 'notice-bar', key: 'bar', kind: 'pack' }]);

		// recompiling unchanged inputs is a no-op with the same version (deterministic)
		const again = await t.request('POST', `${SITE}/delivery/compile`, { cookie: owner });
		expect(again.json).toMatchObject({ changed: false, version: v1 });

		// alias: short cache + ETag; immutable: one year; manifest with integrity and CSP
		const alias = await t.request('GET', `/w/${W1}/loader.js`);
		expect(alias.status).toBe(200);
		expect(alias.headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=600');
		expect(alias.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
		expect(alias.headers.get('x-content-type-options')).toBe('nosniff');
		expect(alias.headers.get('access-control-allow-origin')).toBe('*');
		expect(alias.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
		expect(alias.headers.get('etag')).toBe(`"${v1}"`);
		const integrity = `sha384-${createHash('sha384').update(alias.bytes).digest('base64')}`;
		expect(alias.headers.get('x-ss-integrity')).toBe(integrity);
		expect(alias.text).toContain(`"version":"${v1}"`);
		expect(alias.text).toContain('__ssr.start(');
		expect(alias.text).not.toContain('__ssa'); // no audience rule → no evaluator
		expect((await t.request('GET', `/w/${W1}/loader.js`, { headers: { 'if-none-match': `"${v1}"` } })).status).toBe(304);
		expect((await t.request('HEAD', `/w/${W1}/loader.js`)).status).toBe(200);

		const pinned = await t.request('GET', `/w/${W1}/${v1}/loader.js`);
		expect(pinned.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(pinned.text).toBe(alias.text);
		const manifest = await t.request('GET', `/w/${W1}/${v1}/manifest.json`);
		expect(manifest.json).toMatchObject({
			format: 'ss-website-bundle@1',
			websiteId: W1,
			env: 'live',
			version: v1,
			integrity,
			csp: { scriptSrc: ['https://portal.test', `'${integrity}'`], hashes: [integrity] },
			elements: [{ appId: PACK, key: 'bar', moduleVersion: 1, modules: [{ path: 'headless/bar.js' }, { path: 'ui/bar.js' }] }],
		});
		expect(manifest.json).not.toHaveProperty('budget');
		problemOf(await t.request('GET', `/w/${W1}/0000000000000000/loader.js`), 404, 'not_found');
		problemOf(await t.request('GET', `/w/${W2}/loader.js`), 404, 'not_found');

		// snippet: SRI tag for the immutable URL, alias guidance
		const snippet = await t.request('GET', `${SITE}/delivery/snippet`, { cookie: owner });
		expect(snippet.json.immutable.tag).toBe(
			`<script src="https://portal.test/w/${W1}/${v1}/loader.js" integrity="${integrity}" crossorigin="anonymous" defer></script>`,
		);
		expect(snippet.json.alias.tag).toContain(`/w/${W1}/loader.js`);

		// a config change → new version
		t.world.layers.set(pack.subscriptionId, { website: { features: { 'bar.message': { value: 'Sale ends tonight' } } } });
		await t.commerce.invalidate(pack.subscriptionId);
		const second = await t.request('POST', `${SITE}/delivery/compile`, { cookie: owner });
		expect(second.json).toMatchObject({ changed: true, previousVersion: v1 });
		const v2 = second.json.version;
		expect(v2).not.toBe(v1);
		expect((await t.request('GET', `/w/${W1}/loader.js`)).text).toContain('Sale ends tonight');
		problemOf(await t.request('POST', `${SITE}/delivery/rollback`, { cookie: owner, body: { version: v1 } }), 404);

		const status = await t.request('GET', `${SITE}/delivery`, { cookie: owner });
		expect(status.json).toMatchObject({ version: v2, previousVersion: v1, env: 'live' });
		expect(status.json.history.map((/** @type {any} */ h) => h.reason)).toEqual(['manual', 'manual']);
		expect(status.json.artefacts.map((/** @type {any} */ a) => a.seq)).toEqual([2, 1]);

		// another merchant cannot see or change this website
		const other = await t.cookie({ merchantId: M2 });
		problemOf(await t.request('GET', `${SITE}/delivery`, { cookie: other }), 403);
		problemOf(await t.request('GET', `/v1/merchants/${M2}/websites/${W1}/delivery`, { cookie: other }), 404);

		// one public pk_ key was issued for the loader and is embedded
		const keys = [...t.world.keys.values()];
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatchObject({ kind: 'pk', websiteId: W1, scopes: ['events.write', 'elements.read'] });
		expect(alias.text).toContain(/** @type {any} */ (keys[0]).key);
	});

	it('selects elements by entitlement state and mode', async () => {
		const t = await boot();
		await t.uploadAll(PACK);
		const pack = await t.subscribe(W1, PACK);
		const chat = await t.subscribe(W1, SERVICE);
		const elementsOf = async () => {
			const out = await t.service.compile({ websiteId: W1 });
			const manifest = await t.request('GET', `/w/${W1}/${out.version}/manifest.json`);
			return {
				keys: manifest.json.elements.map((/** @type {any} */ e) => `${e.key}:${e.kind}`),
				out,
				manifest: manifest.json,
			};
		};
		// pack bar (A); chat launcher (A) has no widgets yet; tip (B only) and inbox (C only) are never delivered
		const all = await elementsOf();
		expect(all.keys).toEqual(['bar:pack']);
		expect(all.out.warnings).toContainEqual(
			expect.objectContaining({ code: 'widgets_missing', appId: SERVICE, key: 'launcher' }),
		);
		expect(all.manifest.csp.connectSrc).toEqual(['https://portal.test']);
		await t.service.registerWidgets({
			appId: SERVICE,
			descriptor: widgetDescriptor(),
			actor: /** @type {any} */ (STAFF_ACTOR),
		});
		await t.uploadAll(SERVICE, 1, WIDGET_FILES);
		const both = await elementsOf();
		expect(both.keys).toEqual(['bar:pack', 'launcher:service']);
		expect(both.manifest.csp.connectSrc).toEqual(['https://chat.example.net', 'https://portal.test']);

		// element switched off → gone
		await t.commerce.setElement({
			subscriptionId: chat.subscriptionId,
			elementKey: 'launcher',
			enabled: false,
			actor: /** @type {any} */ ({ type: 'merchant_user', id: 'usr_owner', merchantId: M1, roles: ['owner'] }),
		});
		expect((await elementsOf()).keys).toEqual(['bar:pack']);
		// a service product without an https base URL delivers nothing
		await t.commerce.setElement({
			subscriptionId: chat.subscriptionId,
			elementKey: 'launcher',
			enabled: true,
			actor: /** @type {any} */ ({ type: 'merchant_user', id: 'usr_owner', merchantId: M1, roles: ['owner'] }),
		});
		/** @type {any} */ (t.world.apps.get(SERVICE)).app.baseUrl = 'http://chat.example.net';
		const insecure = await elementsOf();
		expect(insecure.keys).toEqual(['bar:pack']);
		expect(insecure.out.warnings).toContainEqual(expect.objectContaining({ code: 'no_api_base', key: 'launcher' }));
		await t.commerce.cancel({ subscriptionId: chat.subscriptionId, actor: /** @type {any} */ ({ type: 'system', id: 't' }) });
		// paused subscription → its elements are gone
		await t.commerce.pause({
			subscriptionId: pack.subscriptionId,
			reason: 'test',
			actor: /** @type {any} */ ({ type: 'system', id: 't' }),
		});
		const paused = await elementsOf();
		expect(paused.keys).toEqual([]);
		await t.commerce.resume({ subscriptionId: pack.subscriptionId, actor: /** @type {any} */ ({ type: 'system', id: 't' }) });
		expect((await elementsOf()).keys).toEqual(['bar:pack']);
		// assets missing for the pinned version → skipped with a warning (fail closed for that element only)
		await t.db.collection('delivery_assets').deleteMany({ path: 'ui/bar.js' });
		const missing = await elementsOf();
		expect(missing.keys).toEqual([]);
		expect(missing.out.warnings).toContainEqual(expect.objectContaining({ code: 'assets_missing', appId: PACK, key: 'bar' }));
		// cancelled → gone
		await t.uploadAll(PACK);
		await t.commerce.cancel({ subscriptionId: pack.subscriptionId, actor: /** @type {any} */ ({ type: 'system', id: 't' }) });
		expect((await elementsOf()).keys).toEqual([]);
	});

	it('precompiles audience rules and bundles the evaluator only then', async () => {
		const t = await boot();
		await t.uploadAll(PACK);
		const pack = await t.subscribe(W1, PACK);
		t.world.layers.set(pack.subscriptionId, {
			website: { features: { 'bar.placement': { value: { paths: { include: ['/**'] }, audience: "device == 'mobile'" } } } },
		});
		await t.commerce.invalidate(pack.subscriptionId);
		const out = await t.service.compile({ websiteId: W1 });
		const text = (await t.request('GET', `/w/${W1}/${out.version}/loader.js`)).text;
		expect(text).toContain('__ssa.evaluateAudienceProgram');
		expect(text).toContain('"audience":{"ast":');
		expect(text).not.toContain("device == 'mobile'");

		// an invalid rule skips the element with a warning
		t.world.layers.set(pack.subscriptionId, {
			website: { features: { 'bar.placement': { value: { audience: 'device ==' } } } },
		});
		await t.commerce.invalidate(pack.subscriptionId);
		const bad = await t.service.compile({ websiteId: W1 });
		expect(bad.warnings).toContainEqual(expect.objectContaining({ code: 'audience_invalid', key: 'bar' }));
		expect(bad.artefact.elements).toEqual([]);
	});

	it('recompiles through the job when commerce bumps a document version, coalescing requests', async () => {
		const t = await boot();
		await t.uploadAll(PACK);
		const pack = await t.subscribe(W1, PACK); // bump → requestCompile
		const queued = await t.db.collection('platform_jobs').find({ name: 'delivery.compile' }).toArray();
		expect(queued.length).toBeGreaterThan(0);
		t.world.layers.set(pack.subscriptionId, { website: { features: { 'bar.message': { value: 'v2' } } } });
		await t.commerce.invalidate(pack.subscriptionId); // second bump
		// the compile job runs right after the request that asked for it; outside a request, the next loader fetch does
		await t.portal.shared.jobs.runBatch({ handlers: t.portal.modules.jobs, deadlineMs: 10_000, owner: 'test' });
		const alias = await t.db.collection('delivery_aliases').findOne({ websiteId: W1 });
		expect(alias).toMatchObject({ compiledRequest: alias?.requested });
		expect((await t.request('GET', `/w/${W1}/loader.js`)).text).toContain('"message":"v2"');
		expect(await t.db.collection('delivery_artefacts').countDocuments({ websiteId: W1 })).toBe(1);
	});
	it('records a refused compile job and retries it when the loader is served', async () => {
		const t = await boot();
		await t.uploadAll(PACK);
		const entry = /** @type {any} */ (t.world.apps.get(PACK));
		const manifest = entry.versions.get(1).manifest;
		await t.subscribe(W1, PACK);
		manifest.elements = [manifest.elements[0], { ...manifest.elements[0], name: 'Twin' }];
		await t.db.collection('platform_jobs').deleteMany({});
		await t.service.requestCompile(W1);
		await t.portal.shared.jobs.runBatch({ handlers: t.portal.modules.jobs, deadlineMs: 10_000, owner: 'test' });
		const owner = await t.cookie();
		const status = await t.request('GET', `${SITE}/delivery`, { cookie: owner });
		expect(status.json).toMatchObject({ version: null, lastFailure: { code: 'conflict' } });
		expect(status.json.lastFailure.errors).toEqual([
			{ path: '/elements/notice-bar:bar', message: 'element notice-bar:bar is delivered twice' },
		]);
		problemOf(await t.request('GET', `/w/${W1}/loader.js`), 404, 'not_found');
		await expect(
			t.service.uploadAsset({
				appId: PACK,
				version: 1,
				path: '../x.js',
				bytes: Buffer.from('x'),
				contentType: 'text/javascript',
				actor: /** @type {any} */ (STAFF_ACTOR),
			}),
		).rejects.toMatchObject({ code: 'validation_failed' });
	});
});

describe('service widgets', () => {
	it('registers widgets, uploads them on the pack asset route and compiles the real modules into the loader', async () => {
		const t = await boot();
		/** @type {any} */ (t.world.apps.get(SERVICE)).app.baseUrl = 'https://api.chat.example.net/';
		await t.subscribe(W1, SERVICE);
		const first = await t.service.compile({ websiteId: W1 });
		expect(first.artefact.elements).toEqual([]);
		expect(first.warnings).toContainEqual(expect.objectContaining({ code: 'widgets_missing', key: 'launcher' }));

		const actor = /** @type {any} */ (STAFF_ACTOR);
		const registered = await t.service.registerWidgets({ appId: SERVICE, descriptor: widgetDescriptor(), actor });
		expect(registered).toEqual({
			version: 1,
			status: 'uploading',
			missing: WIDGET_FILES,
			uploadPath: `/v1/admin/packs/${SERVICE}/versions/1/assets/`,
			changed: true,
		});
		// the same descriptor is the same version; a descriptor without widget modules is refused
		expect((await t.service.registerWidgets({ appId: SERVICE, descriptor: widgetDescriptor(), actor })).version).toBe(1);
		const bare = { ...widgetDescriptor(), manifest: { elements: [{ key: 'launcher', headless: 'nope.js#x' }] } };
		await expect(t.service.registerWidgets({ appId: SERVICE, descriptor: bare, actor })).rejects.toMatchObject({
			code: 'validation_failed',
		});

		// one asset route for both kinds: bytes must match the descriptor
		const staff = await t.cookie({ kind: 'staff', roles: ['admin'] });
		const put = (/** @type {string} */ path, /** @type {Uint8Array | string} */ raw) =>
			t.request('PUT', `${registered.uploadPath}${path}`, {
				raw,
				cookie: staff,
				headers: { 'content-type': 'text/javascript' },
			});
		problemOf(await put('headless/bar.js', 'tampered'), 422, 'delivery_asset_mismatch');
		problemOf(await put('img/other.js', 'x'), 422, 'delivery_asset_mismatch');
		const partial = await put('headless/bar.js', fileBytes('headless/bar.js'));
		expect(partial.json).toMatchObject({ status: 'uploading', missing: ['ui/bar.js'] });
		expect((await t.service.compile({ websiteId: W1 })).version).toBe(first.version);
		const done = await put('ui/bar.js', fileBytes('ui/bar.js'));
		expect(done.json).toMatchObject({
			status: 'ready',
			missing: [],
			url: `https://portal.test/w/packs/${SERVICE}/1/ui/bar.js`,
		});
		expect(await t.db.collection('platform_audit').countDocuments({ action: 'delivery.widgets_ready' })).toBe(1);
		expect((await put('ui/bar.js', fileBytes('ui/bar.js'))).json).toMatchObject({ status: 'ready', changed: false });
		expect(await t.db.collection('platform_audit').countDocuments({ action: 'delivery.widgets_ready' })).toBe(1);
		const again = await t.service.registerWidgets({ appId: SERVICE, descriptor: widgetDescriptor(), actor });
		expect(again).toMatchObject({ version: 1, status: 'ready', missing: [], changed: false });

		// ready → every subscribed website was asked to recompile; the loader ships the real modules from /w/packs/
		expect((await t.db.collection('delivery_aliases').findOne({ websiteId: W1 }))?.requested).toBeGreaterThan(0);
		const out = await t.service.compile({ websiteId: W1 });
		expect(out.changed).toBe(true);
		const manifest = await t.request('GET', `/w/${W1}/${out.version}/manifest.json`);
		expect(manifest.json.elements[0]).toMatchObject({
			key: 'launcher',
			kind: 'service',
			moduleVersion: 1,
			api: 'https://api.chat.example.net',
		});
		expect(manifest.json.elements[0].modules.map((/** @type {any} */ m) => m.path)).toEqual(WIDGET_FILES);
		const loader = (await t.request('GET', `/w/${W1}/loader.js`)).text;
		expect(loader).toContain(`"path":"packs/${SERVICE}/1/headless/bar.js"`);
		expect(loader).toContain(`"path":"packs/${SERVICE}/1/ui/bar.js"`);
		expect(loader).toContain('"api":"https://api.chat.example.net"');
		expect(loader).not.toContain('stub');
		const served = await t.request('GET', `/w/packs/${SERVICE}/1/headless/bar.js`);
		expect(served.status).toBe(200);
		expect(served.headers.get('cache-control')).toContain('immutable');
		expect(served.text).toBe(fileBytes('headless/bar.js').toString('utf8'));
		expect((await t.request('GET', `/w/ui/${SERVICE}/1/headless/bar.js`)).status).toBe(404);

		// the loader key may call the product's own routes; the base URL falls back to the manifest's endpoints.base
		expect([...t.world.keys.values()].at(-1)?.scopes).toEqual([
			'events.write',
			'elements.read',
			'chat-box.read',
			'chat-box.write',
		]);
		/** @type {any} */ (t.world.apps.get(SERVICE)).app.baseUrl = null;
		await t.service.compile({ websiteId: W1 });
		expect((await t.request('GET', `/w/${W1}/loader.js`)).text).toContain('"api":"https://chat.example.net"');
		// an inactive product keeps delivering to existing subscriptions, without new product scopes on the key
		/** @type {any} */ (t.world.apps.get(SERVICE)).app.status = 'inactive';
		const keysBefore = t.world.keys.size;
		const inactive = await t.service.compile({ websiteId: W1 });
		expect(inactive.artefact.elements.map((/** @type {any} */ e) => e.key)).toEqual(['launcher']);
		expect(t.world.keys.size).toBe(keysBefore);
	});

	it('registers a second version for a changed descriptor and compiles the newest ready one', async () => {
		const t = await boot();
		const actor = /** @type {any} */ (STAFF_ACTOR);
		await t.service.registerWidgets({ appId: SERVICE, descriptor: widgetDescriptor(), actor });
		await t.uploadAll(SERVICE, 1, WIDGET_FILES);
		const changed = { ...widgetDescriptor(), assets: [...widgetDescriptor().assets].reverse() };
		const second = await t.service.registerWidgets({ appId: SERVICE, descriptor: changed, actor });
		expect(second).toMatchObject({ version: 2, status: 'uploading' });
		await t.subscribe(W1, SERVICE);
		const out = await t.service.compile({ websiteId: W1 });
		expect((await t.request('GET', `/w/${W1}/${out.version}/loader.js`)).text).toContain(`packs/${SERVICE}/1/`);
		await t.uploadAll(SERVICE, 2, WIDGET_FILES);
		const next = await t.service.compile({ websiteId: W1 });
		expect((await t.request('GET', `/w/${W1}/${next.version}/loader.js`)).text).toContain(`packs/${SERVICE}/2/`);
	});
});

describe('no client data in Portal collections', () => {
	it('delivery collections hold metadata only — never file contents', async () => {
		const t = await boot();
		await t.uploadAll(PACK);
		await t.subscribe(W1, PACK);
		await t.service.compile({ websiteId: W1 });
		for (const name of ['delivery_assets', 'delivery_artefacts', 'delivery_aliases', 'platform_jobs', 'platform_audit']) {
			const docs = await t.db.collection(name).find({}).toArray();
			expect(JSON.stringify(docs)).not.toContain('createBar = ({ config');
		}
		// the asset records are hashes and sizes, not file contents
		const asset = await t.db.collection('delivery_assets').findOne({ path: 'headless/bar.js' });
		expect(Object.keys(asset ?? {}).sort()).toEqual(
			[
				'_id',
				'appId',
				'contentType',
				'createdAt',
				'path',
				'sha256',
				'size',
				'storageKey',
				'updatedAt',
				'uploadedBy',
				'version',
			].sort(),
		);
	});
});
