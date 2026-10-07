import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/infra/db.js';
import { BUNDLE_FORMAT } from '../../../src/modules/catalog/core/bundle.js';
import { PORTAL_URL, startMongo } from '../../helpers.js';
import { bootPortal, problemOf } from './boot.js';
import { fakeCommerce, fakeDelivery } from './fakes/modules.js';
import { startFakeProduct } from './fakes/product.js';
import { packAssets, packManifest, renamedService, serviceManifest } from './fixtures.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
/** @type {Array<{ close: () => Promise<unknown> }>} */
const products = [];

beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await Promise.all(products.map((p) => p.close()));
	await closeMongoClients();
	await mongo?.stop();
});

/** @param {Partial<Parameters<typeof bootPortal>[0]>} [options] */
const boot = (options = {}) => bootPortal({ db: mongo.db('cat_packs'), ...options });

/** @param {{ manifest?: any, assets?: any[] }} [options] */
const bundle = ({ manifest = packManifest(), assets = packAssets() } = {}) => ({
	descriptor: { format: BUNDLE_FORMAT, manifest, assets },
});

/** @param {Awaited<ReturnType<typeof boot>>} t @param {any} body @param {string[]} [roles] */
const upload = (t, body, roles) => t.staff('POST', '/v1/admin/packs', { body, ...(roles ? { roles } : {}) });

/** @param {Awaited<ReturnType<typeof boot>>} t @param {string} appId @param {string} status */
const setStatus = (t, appId, status) => t.staff('POST', `/v1/admin/apps/${appId}/status`, { body: { status } });

/** @param {Awaited<ReturnType<typeof boot>>} t @param {string} slug @param {any} [manifest] */
const connected = async (t, slug, manifest = renamedService(slug)) => {
	const p = await startFakeProduct({ manifest, portalUrl: PORTAL_URL, now: t.clock.now });
	products.push(p);
	const res = await t.register(p);
	expect(res.status).toBe(201);
	return /** @type {string} */ (res.json.appId);
};

describe('element packs', () => {
	it('uploads a version, makes it current when its assets are in, and versions it', async () => {
		/** @type {string[]} */
		const invalidated = [];
		const t = await boot({ modules: [fakeCommerce([], invalidated)] });
		const paths = packAssets().map((/** @type {any} */ a) => a.path);

		const first = await upload(t, bundle());
		expect(first.status).toBe(201);
		const appId = first.json.appId;
		expect(first.json).toEqual({
			appId,
			slug: 'notice-bar',
			kind: 'pack',
			version: 1,
			status: 'uploading',
			missing: paths,
			uploadPath: `/v1/admin/packs/${appId}/versions/1/assets/`,
			changed: true,
		});
		// not ready yet: no current version, cannot be activated
		expect(await t.service().getApp(appId)).toMatchObject({
			kind: 'pack',
			status: 'inactive',
			name: 'Notice bar',
			baseUrl: null,
			currentVersion: null,
		});
		await expect(t.service().getManifest(appId)).rejects.toMatchObject({ code: 'conflict' });
		problemOf(await setStatus(t, appId, 'active'), 409, 'conflict');
		expect(await upload(t, bundle())).toMatchObject({
			status: 200,
			json: { changed: false, status: 'uploading', missing: paths },
		});

		// delivery has every asset
		expect(await t.service().versionReady({ appId, version: 1 })).toMatchObject({ currentVersion: 1 });
		expect(await t.service().versionReady({ appId, version: 1 })).toMatchObject({ currentVersion: 1 });
		await expect(t.service().versionReady({ appId, version: 9 })).rejects.toMatchObject({ code: 'not_found' });
		expect(await upload(t, bundle())).toMatchObject({ status: 200, json: { changed: false, status: 'ready', missing: [] } });
		expect(await t.service().versionDetail(appId, 1)).toMatchObject({ status: 'accepted', assets: packAssets() });

		// staff list it
		expect((await setStatus(t, appId, 'active')).json).toMatchObject({ status: 'active', currentVersion: 1 });
		expect((await setStatus(t, appId, 'active')).json.status).toBe('active');
		expect((await t.call('GET', '/v1/catalog/products?kind=pack')).json.items).toEqual([
			expect.objectContaining({ slug: 'notice-bar', kind: 'pack', version: '0.1.0', manifestVersion: 1 }),
		]);

		// a new version (other assets): uploading until ready; a newer upload supersedes it
		const v2 = packManifest();
		v2.product.version = '0.2.0';
		v2.elements[0].price.hourly = 100;
		const assets2 = [...packAssets(), { path: 'ui/extra.css', sha256: 'c'.repeat(64), size: 10 }];
		expect((await upload(t, bundle({ manifest: v2, assets: assets2 }))).json).toMatchObject({ version: 2, changed: true });
		expect((await upload(t, bundle({ manifest: v2, assets: assets2.slice(0, 2) }))).json).toMatchObject({ version: 3 });
		expect((await t.service().versionDetail(appId, 2)).status).toBe('superseded');
		expect(await t.service().versionReady({ appId, version: 2 })).toMatchObject({ currentVersion: 1 });
		expect(await t.service().versionReady({ appId, version: 3 })).toMatchObject({ currentVersion: 3, productVersion: '0.2.0' });
		expect((await t.staff('GET', `/v1/admin/apps/${appId}`)).json.versions.map((/** @type {any} */ v) => v.status)).toEqual([
			'accepted',
			'superseded',
			'superseded',
		]);
		expect((await t.call('GET', '/v1/catalog/products?kind=pack')).json.items[0]).toMatchObject({
			version: '0.2.0',
			price: expect.objectContaining({ fromHourlyMillicredits: 100 }),
		});
		expect(t.integration?.emitted.map((e) => e.data.version)).toEqual([1, 3]);
		expect(invalidated).toEqual([appId, appId]);

		// packs never authenticate as products and are never launched
		expect(await t.service().appKeys(appId)).toBeNull();
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/launch`, { body: { all: true } }), 422, 'catalog_launch_refused');

		// deactivated: no longer listed
		expect((await setStatus(t, appId, 'inactive')).json.status).toBe('inactive');
		expect((await t.call('GET', '/v1/catalog/products')).json.items).toEqual([]);
		problemOf(await t.call('GET', '/v1/catalog/products/notice-bar'), 404);
		problemOf(await setStatus(t, appId, 'retired'), 422, 'validation_failed');
		problemOf(await setStatus(t, 'app_nope', 'active'), 404);
		expect((await t.audit(appId)).map((a) => a.action)).toEqual([
			'catalog.pack_created',
			'catalog.version_ready',
			'catalog.app_activated',
			'catalog.pack_uploaded',
			'catalog.pack_uploaded',
			'catalog.version_ready',
			'catalog.app_deactivated',
		]);
	});

	it('validates bundle shape, manifest and module references', async () => {
		const t = await boot();
		const shape = problemOf(await upload(t, { descriptor: {} }), 422, 'catalog_bundle_invalid');
		expect(shape.errors.length).toBeGreaterThan(0);
		const svc = problemOf(await upload(t, bundle({ manifest: serviceManifest() })), 422, 'invalid_manifest');
		expect(svc.errors[0].path).toBe('/descriptor/manifest/product/kind');
		const broken = packManifest();
		broken.elements[0].modes = ['C'];
		problemOf(await upload(t, bundle({ manifest: broken })), 422, 'invalid_manifest');
		const missing = problemOf(await upload(t, bundle({ assets: packAssets().slice(1) })), 422, 'catalog_bundle_invalid');
		expect(missing.errors[0].path).toBe('/descriptor/manifest/elements/0/headless');
		problemOf(await upload(t, bundle(), ['support']), 403);
	});

	it('keeps slugs unique across kinds', async () => {
		const t = await boot();
		await upload(t, bundle());
		const other = renamedService('notice-bar');
		const p = await startFakeProduct({ manifest: other, portalUrl: PORTAL_URL, now: t.clock.now });
		products.push(p);
		problemOf(await t.register(p), 409, 'conflict');
	});
});

describe('service widgets', () => {
	const widgetAssets = () => [
		{ path: 'headless/applyBox.js', sha256: 'a'.repeat(64), size: 100, contentType: 'text/javascript' },
		{ path: 'ui/applyBox.js', sha256: 'b'.repeat(64), size: 200, contentType: 'text/javascript' },
		{ path: 'strings/codes.json', sha256: 'c'.repeat(64), size: 20, contentType: 'application/json' },
	];

	it('hands the widgets of mode A elements to delivery', async () => {
		const delivery = fakeDelivery();
		const t = await boot({ modules: [delivery.module] });
		const appId = await connected(t, 'coupons', serviceManifest());
		const res = await upload(t, bundle({ manifest: serviceManifest(), assets: widgetAssets() }));
		expect(res.status).toBe(201);
		expect(res.json).toEqual({
			appId,
			slug: 'coupons',
			kind: 'service',
			version: 1,
			status: 'uploading',
			missing: widgetAssets().map((a) => a.path),
			uploadPath: `/v1/admin/packs/${appId}/versions/1/assets/`,
			changed: true,
		});
		expect(delivery.calls).toEqual([
			{
				appId,
				descriptor: { format: BUNDLE_FORMAT, manifest: serviceManifest(), assets: widgetAssets() },
				actor: expect.objectContaining({ id: 'stf_alice' }),
			},
		]);

		// an element the product does not declare mode A, or a module not in the assets, is refused
		const wrong = serviceManifest();
		wrong.elements[0].headless = 'headless/codes.js#create';
		wrong.elements[0].renderer = 'ui/codes.js#render';
		wrong.elements[0].modes = ['A', 'C'];
		const refused = problemOf(
			await upload(t, bundle({ manifest: wrong, assets: widgetAssets() })),
			422,
			'catalog_bundle_invalid',
		);
		expect(refused.errors).toEqual([expect.objectContaining({ path: '/descriptor/manifest/elements/0/key' })]);
		const short = problemOf(
			await upload(t, bundle({ manifest: serviceManifest(), assets: widgetAssets().slice(1) })),
			422,
			'catalog_bundle_invalid',
		);
		expect(short.errors[0].path).toBe('/descriptor/manifest/elements/1/headless');
		expect(delivery.calls).toHaveLength(1);
	});
});

describe('catalog reads', () => {
	it('lists active products with elements, plans and prices; staff see everything', async () => {
		const t = await boot();
		/** @type {string[]} */
		const ids = [];
		for (const slug of ['alpha', 'beta', 'gamma']) ids.push(await connected(t, slug));
		await setStatus(t, /** @type {string} */ (ids[0]), 'active');
		await setStatus(t, /** @type {string} */ (ids[1]), 'active');

		const list = await t.call('GET', '/v1/catalog/products');
		expect(list.headers.get('cache-control')).toBe('public, max-age=60');
		expect(list.json.items.map((/** @type {any} */ e) => e.slug).sort()).toEqual(['alpha', 'beta']);
		const alpha = list.json.items.find((/** @type {any} */ e) => e.slug === 'alpha');
		expect(alpha).toMatchObject({
			kind: 'service',
			status: 'active',
			name: 'Coupons',
			elements: [
				expect.objectContaining({ key: 'codes', price: expect.objectContaining({ hourlyMillicredits: 1000 }) }),
				expect.objectContaining({ key: 'apply_box', price: { hourlyMillicredits: 0, metered: [] } }),
			],
			plans: [expect.objectContaining({ code: 'starter', includedHourlyMillicredits: 1000 })],
			price: expect.objectContaining({ fromHourlyMillicredits: 1000, metered: true, trialHours: 48 }),
		});
		expect(alpha.elements[0]).not.toHaveProperty('features');
		expect((await t.call('GET', '/v1/catalog/products?kind=pack')).json.items).toEqual([]);
		expect((await t.service().activeProducts({ kind: 'service' })).map((e) => e.slug).sort()).toEqual(['alpha', 'beta']);
		problemOf(await t.call('GET', '/v1/catalog/products?kind=other'), 400);

		const detail = await t.call('GET', '/v1/catalog/products/alpha');
		expect(detail.json.elements[0].features.properties.maxActive).toMatchObject({ 'x-kind': 'limit' });
		problemOf(await t.call('GET', '/v1/catalog/products/gamma'), 404);
		problemOf(await t.call('GET', '/v1/catalog/products/nope'), 404);

		// INTERFACES.md reads
		expect(await t.service().appBySlug('gamma')).toMatchObject({ slug: 'gamma', status: 'inactive' });
		await expect(t.service().appBySlug('nope')).rejects.toMatchObject({ code: 'not_found' });
		await expect(t.service().getApp('app_nope')).rejects.toMatchObject({ code: 'not_found' });
		await expect(t.service().getManifest(/** @type {string} */ (ids[0]), 7)).rejects.toMatchObject({ code: 'not_found' });
		expect((await t.service().getManifest(/** @type {string} */ (ids[0]), 1)).product.slug).toBe('alpha');
		await expect(t.service().versionDetail(/** @type {string} */ (ids[0]), 7)).rejects.toMatchObject({ code: 'not_found' });

		// staff listing: pagination and filters
		const page1 = await t.staff('GET', '/v1/admin/apps?limit=2');
		expect(page1.json.items).toHaveLength(2);
		expect(page1.headers.get('link')).toMatch(/rel="next"/);
		const page2 = await t.staff('GET', `/v1/admin/apps?limit=2&cursor=${page1.json.nextCursor}`);
		expect(page2.json).toMatchObject({ hasMore: false, nextCursor: null });
		expect([...page1.json.items, ...page2.json.items].map((/** @type {any} */ a) => a.appId)).toEqual([...ids].sort());
		const inactive = await t.staff('GET', '/v1/admin/apps?status=inactive&kind=service');
		expect(inactive.json.items.map((/** @type {any} */ a) => a.slug)).toEqual(['gamma']);
		problemOf(await t.staff('GET', '/v1/admin/apps?status=bogus'), 400);
		problemOf(await t.staff('GET', '/v1/admin/apps?kind=bogus'), 400);
		problemOf(await t.staff('GET', '/v1/admin/apps', { roles: [] }), 403);
		problemOf(await t.staff('GET', '/v1/admin/apps/app_nope'), 404);
	});
});
