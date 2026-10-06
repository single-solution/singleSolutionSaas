import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { closeMongoClients } from '../../../src/infra/db.js';
import { startMongo } from '../../helpers.js';
import { BIG, M1, M2, PACK, SERVICE, UI_FILES, W1, W2, bootDelivery, fileBytes, packManifest, uiBundleBody } from './fixtures.js';

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
	it('stores assets whose bytes match the signed descriptor and refuses everything else', async () => {
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
		problemOf(
			await t.request('PUT', `/v1/admin/packs/${SERVICE}/versions/1/assets/ui/bar.js`, {
				raw: 'x',
				cookie: staff,
				headers: { 'content-type': 'text/javascript' },
			}),
			409,
			'conflict',
		);

		// the real bytes (binary too) are accepted, idempotently
		const ok = await put('headless/bar.js', fileBytes('headless/bar.js'));
		expect(ok.status).toBe(200);
		expect(ok.json).toMatchObject({
			path: 'headless/bar.js',
			changed: true,
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
	});
});

describe('compile, serve, rollback', () => {
	it('compiles the enabled mode-A elements, serves alias and immutable versions, and rolls back', async () => {
		const t = await boot();
		await t.uploadAll(PACK);
		const owner = await t.cookie();
		const pack = await t.subscribe(W1, PACK);

		const first = await t.request('POST', `${SITE}/delivery/compile`, { cookie: owner });
		expect(first.status).toBe(200);
		expect(first.json).toMatchObject({ changed: true, previousVersion: null });
		const v1 = first.json.version;
		expect(v1).toMatch(/^[0-9a-f]{16}$/);
		expect(first.json.artefact.elements).toEqual([{ appId: PACK, slug: 'notice-bar', key: 'bar', kind: 'pack', budgetKb: 6 }]);

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
			elements: [{ appId: PACK, key: 'bar', delivery: 'pack', modules: [{ path: 'headless/bar.js' }, { path: 'ui/bar.js' }] }],
		});
		expect(manifest.json.budget.totalKb).toBeLessThanOrEqual(60);
		problemOf(await t.request('GET', `/w/${W1}/0000000000000000/loader.js`), 404, 'not_found');
		problemOf(await t.request('GET', `/w/${W2}/loader.js`), 404, 'not_found');

		// snippet: SRI tag for the immutable URL, alias guidance
		const snippet = await t.request('GET', `${SITE}/delivery/snippet`, { cookie: owner });
		expect(snippet.json.immutable.tag).toBe(
			`<script src="https://portal.test/w/${W1}/${v1}/loader.js" integrity="${integrity}" crossorigin="anonymous" defer></script>`,
		);
		expect(snippet.json.alias.tag).toContain(`/w/${W1}/loader.js`);

		// a config change → new version; rollback flips back atomically
		t.world.layers.set(pack.subscriptionId, { website: { features: { 'bar.message': { value: 'Sale ends tonight' } } } });
		await t.commerce.invalidate(pack.subscriptionId);
		const second = await t.request('POST', `${SITE}/delivery/compile`, { cookie: owner });
		expect(second.json).toMatchObject({ changed: true, previousVersion: v1 });
		const v2 = second.json.version;
		expect(v2).not.toBe(v1);
		expect((await t.request('GET', `/w/${W1}/loader.js`)).text).toContain('Sale ends tonight');
		const back = await t.request('POST', `${SITE}/delivery/rollback`, { cookie: owner, body: { version: v1 } });
		expect(back.json).toMatchObject({ changed: true, version: v1, previousVersion: v2 });
		expect((await t.request('GET', `/w/${W1}/loader.js`)).headers.get('etag')).toBe(`"${v1}"`);
		problemOf(await t.request('POST', `${SITE}/delivery/rollback`, { cookie: owner, body: { version: 'f'.repeat(16) } }), 404);
		problemOf(await t.request('POST', `${SITE}/delivery/rollback`, { cookie: owner, body: { version: 'x' } }), 422);

		const status = await t.request('GET', `${SITE}/delivery`, { cookie: owner });
		expect(status.json).toMatchObject({ version: v1, previousVersion: v2, env: 'live' });
		expect(status.json.history.map((/** @type {any} */ h) => h.reason)).toEqual(['rollback', 'manual', 'manual']);
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
				keys: manifest.json.elements.map((/** @type {any} */ e) => `${e.key}:${e.delivery}`),
				out,
				manifest: manifest.json,
			};
		};
		// pack bar (A) + chat launcher (A, stub); tip (B only) and inbox (C only) are never delivered
		const all = await elementsOf();
		expect(all.keys).toEqual(['bar:pack', 'launcher:ss-element-stub@2']);
		expect(all.manifest.csp.connectSrc).toEqual(['https://chat.example.net', 'https://portal.test']);
		const loader = (await t.request('GET', `/w/${W1}/loader.js`)).text;
		expect(loader).toContain('"stub":"ss-element-stub@2"');
		expect(loader).toContain('"api":"https://chat.example.net"');

		// element switched off → gone
		await t.commerce.setElement({
			subscriptionId: chat.subscriptionId,
			elementKey: 'launcher',
			enabled: false,
			actor: /** @type {any} */ ({ type: 'merchant_user', id: 'usr_owner', merchantId: M1, roles: ['owner'] }),
		});
		expect((await elementsOf()).keys).toEqual(['bar:pack']);
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

	it('refuses a compile over the website budget and keeps the current alias', async () => {
		const t = await boot({ env: { DELIVERY_BUDGET_KB: '40' } });
		await t.uploadAll(PACK);
		await t.uploadAll(BIG);
		const owner = await t.cookie();
		await t.subscribe(W1, PACK);
		const ok = await t.request('POST', `${SITE}/delivery/compile`, { cookie: owner });
		expect(ok.status).toBe(200);
		await t.subscribe(W1, BIG);
		const refused = problemOf(
			await t.request('POST', `${SITE}/delivery/compile`, { cookie: owner }),
			422,
			'delivery_budget_exceeded',
		);
		expect(refused.detail).toMatch(/website budget is 40 KB/);
		expect(refused.errors).toEqual([
			{ path: '/elements/gallery', code: 'budget', message: 'big-gallery/gallery budget.js 40 KB' },
			{ path: '/elements/bar', code: 'budget', message: 'notice-bar/bar budget.js 6 KB' },
		]);
		expect((await t.request('GET', `/w/${W1}/loader.js`)).headers.get('etag')).toBe(`"${ok.json.version}"`);
	});

	it('refuses elements that ship more than their declared budget', async () => {
		const t = await boot();
		const entry = /** @type {any} */ (t.world.apps.get(PACK));
		entry.versions.set(1, { ...entry.versions.get(1), manifest: packManifest({ budget: 0 }) });
		await t.uploadAll(PACK);
		await t.subscribe(W1, PACK);
		await expect(t.service.compile({ websiteId: W1 })).rejects.toMatchObject({
			code: 'delivery_budget_exceeded',
			errors: [expect.objectContaining({ path: '/elements/bar', code: 'over_declared' })],
		});
	});

	it('recompiles through the job when commerce bumps a document version, coalescing requests', async () => {
		const t = await boot();
		await t.uploadAll(PACK);
		const pack = await t.subscribe(W1, PACK); // bump → requestCompile
		const queued = await t.db.collection('platform_jobs').find({ name: 'delivery.compile' }).toArray();
		expect(queued.length).toBeGreaterThan(0);
		t.world.layers.set(pack.subscriptionId, { website: { features: { 'bar.message': { value: 'v2' } } } });
		await t.commerce.invalidate(pack.subscriptionId); // second bump
		const run = await t.portal.operations.run('drain');
		expect(run?.status).toBe('ok');
		const alias = await t.db.collection('delivery_aliases').findOne({ websiteId: W1 });
		expect(alias).toMatchObject({ compiledRequest: alias?.requested });
		expect((await t.request('GET', `/w/${W1}/loader.js`)).text).toContain('"message":"v2"');
		expect(await t.db.collection('delivery_artefacts').countDocuments({ websiteId: W1 })).toBe(1);
	});
});

describe('service UI bundles (F.16)', () => {
	it('replaces the element stub with the product signed modules once every asset is uploaded', async () => {
		const t = await boot();
		await t.subscribe(W1, SERVICE);
		const first = await t.service.compile({ websiteId: W1 });
		expect(first.artefact.elements.map((/** @type {any} */ e) => e.key)).toEqual(['launcher']);
		const stubbed = await t.request('GET', `/w/${W1}/${first.version}/manifest.json`);
		expect(stubbed.json.elements[0].delivery).toBe('ss-element-stub@2');

		// packs cannot, forged signatures are refused (by catalog), a valid descriptor is pending until uploaded
		await expect(t.service.submitUiBundle({ appId: PACK, body: uiBundleBody() })).rejects.toMatchObject({ code: 'conflict' });
		await expect(t.service.submitUiBundle({ appId: SERVICE, body: uiBundleBody({ sig: 'forged' }) })).rejects.toMatchObject({
			code: 'forbidden',
		});
		const submitted = await t.service.submitUiBundle({ appId: SERVICE, body: uiBundleBody() });
		expect(submitted).toMatchObject({ version: 1, status: 'pending', elements: ['launcher'], missing: UI_FILES });
		expect((await t.service.submitUiBundle({ appId: SERVICE, body: uiBundleBody() })).version).toBe(1); // idempotent

		// the bytes must match the descriptor
		const upload = (/** @type {string} */ path, /** @type {Uint8Array} */ bytes) =>
			t.service.uploadUiAsset({ appId: SERVICE, version: 1, path, bytes, contentType: 'text/javascript' });
		await expect(upload('headless/bar.js', Buffer.from('tampered'))).rejects.toMatchObject({
			code: 'delivery_asset_mismatch',
		});
		await expect(upload('other.js', fileBytes('ui/bar.js'))).rejects.toMatchObject({ code: 'delivery_asset_mismatch' });
		await expect(
			t.service.uploadUiAsset({
				appId: SERVICE,
				version: 7,
				path: 'ui/bar.js',
				bytes: fileBytes('ui/bar.js'),
				contentType: 'text/javascript',
			}),
		).rejects.toMatchObject({ code: 'not_found' });
		expect((await upload('headless/bar.js', fileBytes('headless/bar.js'))).status).toBe('pending');
		// still the stub while incomplete
		const partial = await t.service.compile({ websiteId: W1 });
		expect(partial.version).toBe(first.version);
		const done = await upload('ui/bar.js', fileBytes('ui/bar.js'));
		expect(done).toMatchObject({ status: 'ready', missing: [] });
		expect((await t.service.listUiBundles({ appId: SERVICE })).items[0]).toMatchObject({ version: 1, status: 'ready' });

		// ready → every subscribed website was asked to recompile; the compile ships the modules from /w/ui/
		expect((await t.db.collection('delivery_aliases').findOne({ websiteId: W1 }))?.requested).toBeGreaterThan(0);
		const out = await t.service.compile({ websiteId: W1 });
		expect(out.changed).toBe(true);
		const manifest = await t.request('GET', `/w/${W1}/${out.version}/manifest.json`);
		expect(manifest.json.elements[0]).toMatchObject({ key: 'launcher', delivery: 'ui-bundle', uiBundleVersion: 1 });
		expect(manifest.json.elements[0].modules.map((/** @type {any} */ m) => m.path)).toEqual(UI_FILES);
		const loader = (await t.request('GET', `/w/${W1}/loader.js`)).text;
		expect(loader).toContain(`"path":"ui/${SERVICE}/1/headless/bar.js"`);
		expect(loader).toContain('"api":"https://chat.example.net"');
		expect(loader).not.toContain('"stub":"ss-element-stub');
		const served = await t.request('GET', `/w/ui/${SERVICE}/1/headless/bar.js`);
		expect(served.status).toBe(200);
		expect(served.headers.get('cache-control')).toContain('immutable');
		expect(served.text).toBe(fileBytes('headless/bar.js').toString('utf8'));
		// UI-bundle assets are not reachable as pack assets
		expect((await t.request('GET', `/w/packs/${SERVICE}/1/headless/bar.js`)).status).toBe(404);
	});
});

describe('no client data in Portal collections', () => {
	it('delivery collections hold metadata only — never fetched pages or element payloads', async () => {
		const marker = 'CUSTOMER-SECRET-PAGE-CONTENT';
		const t = await boot({
			delivery: {
				fetch: async (url) => ({
					status: 200,
					headers: { 'content-type': 'text/html; charset=utf-8' },
					body: Buffer.from(`<html><head></head><body><p>${marker}</p></body></html>`),
					url,
				}),
			},
		});
		await t.uploadAll(PACK);
		await t.subscribe(W1, PACK);
		const owner = await t.cookie();
		await t.request('POST', `${SITE}/delivery/compile`, { cookie: owner });
		const preview = await t.request('POST', `${SITE}/preview`, { cookie: owner, body: { path: '/' } });
		const page = await t.request('GET', new URL(preview.json.url).pathname);
		expect(page.text).toContain(marker);
		for (const name of [
			'delivery_assets',
			'delivery_artefacts',
			'delivery_aliases',
			'delivery_previews',
			'platform_jobs',
			'platform_audit',
		]) {
			const docs = await t.db.collection(name).find({}).toArray();
			expect(JSON.stringify(docs)).not.toContain(marker);
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
