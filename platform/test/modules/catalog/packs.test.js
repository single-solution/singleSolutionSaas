import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSigner, generateSigningKey, signBundle } from '@ss/protocol';
import { closeMongoClients } from '../../../src/infra/db.js';
import { BUNDLE_FORMAT } from '../../../src/modules/catalog/core/bundle.js';
import { PORTAL_URL, startMongo } from '../../helpers.js';
import { bootPortal, problemOf } from './boot.js';
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

const boot = () => bootPortal({ db: mongo.db('cat_packs') });

/**
 * @param {any} signer
 * @param {{ manifest?: any, assets?: any[], publicJwk?: any }} [options]
 */
const bundle = async (signer, { manifest = packManifest(), assets = packAssets(), publicJwk } = {}) => {
	const descriptor = /** @type {any} */ ({ format: BUNDLE_FORMAT, manifest, assets });
	return { descriptor, signature: await signBundle({ signer, descriptor }), ...(publicJwk ? { publicJwk } : {}) };
};

describe('element packs', () => {
	it('uploads, versions, reviews and lists a signed pack', async () => {
		const t = await boot();
		const dev = await generateSigningKey({ kid: 'dev-1' });
		const signer = createSigner(dev.privateJwk);

		// a new pack needs the developer key it is signed with
		problemOf(await t.staff('POST', '/v1/admin/packs', { body: await bundle(signer) }), 422, 'catalog_bundle_invalid');
		const other = await generateSigningKey({ kid: 'dev-x' });
		problemOf(
			await t.staff('POST', '/v1/admin/packs', { body: await bundle(signer, { publicJwk: other.publicJwk }) }),
			422,
			'catalog_bundle_invalid',
		);
		const forged = await bundle(createSigner(other.privateJwk), { publicJwk: { ...dev.publicJwk, kid: 'dev-x' } });
		problemOf(await t.staff('POST', '/v1/admin/packs', { body: forged }), 422, 'catalog_bundle_invalid');

		const first = await t.staff('POST', '/v1/admin/packs', { body: await bundle(signer, { publicJwk: dev.publicJwk }) });
		expect(first.status).toBe(201);
		expect(first.json).toMatchObject({
			changed: true,
			app: {
				slug: 'notice-bar',
				kind: 'pack',
				status: 'pending',
				health: null,
				environments: { production: null, staging: null },
			},
			version: { version: 1, status: 'accepted', source: 'upload', assets: packAssets() },
		});
		const appId = first.json.app.appId;
		// the same descriptor again is a no-op
		const again = await t.staff('POST', '/v1/admin/packs', { body: await bundle(signer) });
		expect(again).toMatchObject({ status: 200, json: { changed: false, version: { version: 1 } } });

		// a new version: signed by the pinned key, stored as pending with a diff
		const v2 = packManifest();
		v2.product.version = '0.2.0';
		v2.elements[0].price.hourly = 100;
		const assets2 = [...packAssets(), { path: 'ui/extra.css', sha256: 'c'.repeat(64), size: 10 }];
		const second = await t.staff('POST', '/v1/admin/packs', { body: await bundle(signer, { manifest: v2, assets: assets2 }) });
		expect(second.json.version).toMatchObject({ version: 2, status: 'pending', breaking: true, assets: assets2 });
		// unknown signer / new key / tampered descriptor are refused
		problemOf(
			await t.staff('POST', '/v1/admin/packs', { body: await bundle(createSigner(other.privateJwk), { manifest: v2 }) }),
			422,
		);
		problemOf(
			await t.staff('POST', '/v1/admin/packs', { body: await bundle(signer, { manifest: v2, publicJwk: other.publicJwk }) }),
			422,
		);
		const tampered = await bundle(signer, { manifest: v2 });
		tampered.descriptor.assets = [...packAssets(), { path: 'ui/evil.js', sha256: 'd'.repeat(64), size: 1 }];
		problemOf(await t.staff('POST', '/v1/admin/packs', { body: tampered }), 422, 'catalog_bundle_invalid');

		expect((await t.staff('POST', `/v1/admin/apps/${appId}/versions/2/approve`)).json.status).toBe('accepted');
		await t.staff('POST', `/v1/admin/apps/${appId}/lifecycle`, { body: { action: 'activate' } });
		const listed = await t.call('GET', '/v1/catalog/products?kind=pack');
		expect(listed.json.items).toEqual([
			expect.objectContaining({
				slug: 'notice-bar',
				kind: 'pack',
				version: '0.2.0',
				price: expect.objectContaining({ fromHourlyMillicredits: 100 }),
			}),
		]);

		// packs never authenticate as products, have no environments, are never launched or refreshed
		expect(await t.service().appKeys(appId)).toBeNull();
		problemOf(
			await t.staff('PUT', `/v1/admin/apps/${appId}/environments`, { body: { staging: 'https://x.example.com' } }),
			409,
		);
		problemOf(await t.staff('POST', `/v1/admin/apps/${appId}/refresh`), 409);
		problemOf(
			await t.staff('POST', `/v1/admin/apps/${appId}/launch`, { body: { kind: 'demo' } }),
			422,
			'catalog_launch_refused',
		);
		expect((await t.audit(appId)).map((a) => a.action)).toEqual([
			'catalog.pack_created',
			'catalog.pack_uploaded',
			'catalog.version_approved',
			'catalog.app_activated',
		]);
		expect(t.integration?.emitted.map((e) => e.data.version)).toEqual([2]);
	});

	it('validates bundle shape, manifest and module references', async () => {
		const t = await boot();
		const dev = await generateSigningKey({ kid: 'dev-1' });
		const signer = createSigner(dev.privateJwk);
		const shape = problemOf(
			await t.staff('POST', '/v1/admin/packs', { body: { descriptor: {} } }),
			422,
			'catalog_bundle_invalid',
		);
		expect(shape.errors.length).toBeGreaterThan(0);
		const svc = problemOf(
			await t.staff('POST', '/v1/admin/packs', {
				body: await bundle(signer, { manifest: serviceManifest(), publicJwk: dev.publicJwk }),
			}),
			422,
			'invalid_manifest',
		);
		expect(svc.errors[0].path).toBe('/descriptor/manifest/product/kind');
		const broken = packManifest();
		broken.elements[0].modes = ['C'];
		problemOf(
			await t.staff('POST', '/v1/admin/packs', { body: await bundle(signer, { manifest: broken, publicJwk: dev.publicJwk }) }),
			422,
			'invalid_manifest',
		);
		const missing = problemOf(
			await t.staff('POST', '/v1/admin/packs', {
				body: await bundle(signer, { assets: packAssets().slice(1), publicJwk: dev.publicJwk }),
			}),
			422,
			'catalog_bundle_invalid',
		);
		expect(missing.errors[0].path).toBe('/descriptor/manifest/elements/0/headless');
		problemOf(
			await t.staff('POST', '/v1/admin/packs', {
				body: await bundle(signer, { publicJwk: dev.publicJwk }),
				roles: ['support'],
			}),
			403,
		);
	});

	it('keeps slugs unique across kinds and refuses uploads to retired packs', async () => {
		const t = await boot();
		const p = await startFakeProduct({
			manifest: renamedService('notice-bar'),
			portalUrl: PORTAL_URL,
			fetchJwks: t.jwks,
			now: t.clock.now,
		});
		products.push(p);
		expect((await t.staff('POST', '/v1/admin/apps/register', { body: { baseUrl: p.url, token: p.token } })).status).toBe(201);
		const dev = await generateSigningKey({ kid: 'dev-1' });
		problemOf(
			await t.staff('POST', '/v1/admin/packs', {
				body: await bundle(createSigner(dev.privateJwk), { publicJwk: dev.publicJwk }),
			}),
			409,
		);

		const t2 = await bootPortal({ db: mongo.db('cat_packs_b') });
		const created = await t2.staff('POST', '/v1/admin/packs', {
			body: await bundle(createSigner(dev.privateJwk), { publicJwk: dev.publicJwk }),
		});
		await t2.staff('POST', `/v1/admin/apps/${created.json.app.appId}/lifecycle`, { body: { action: 'retire', reason: 'x' } });
		const v2 = packManifest();
		v2.product.version = '0.3.0';
		problemOf(
			await t2.staff('POST', '/v1/admin/packs', { body: await bundle(createSigner(dev.privateJwk), { manifest: v2 }) }),
			409,
		);
	});
});

describe('catalog reads', () => {
	it('lists active products with elements, plans and prices; staff see everything', async () => {
		const t = await boot();
		/** @type {string[]} */
		const ids = [];
		for (const slug of ['alpha', 'beta', 'gamma']) {
			const p = await startFakeProduct({
				manifest: renamedService(slug),
				portalUrl: PORTAL_URL,
				fetchJwks: t.jwks,
				now: t.clock.now,
			});
			products.push(p);
			const res = await t.staff('POST', '/v1/admin/apps/register', { body: { baseUrl: p.url, token: p.token } });
			ids.push(res.json.appId);
		}
		await t.staff('POST', `/v1/admin/apps/${ids[0]}/lifecycle`, { body: { action: 'activate' } });
		await t.staff('POST', `/v1/admin/apps/${ids[1]}/lifecycle`, { body: { action: 'activate' } });

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
		problemOf(await t.call('GET', '/v1/catalog/products?kind=other'), 400);

		const detail = await t.call('GET', '/v1/catalog/products/alpha');
		expect(detail.json.elements[0].features.properties.maxActive).toMatchObject({ 'x-kind': 'limit' });
		problemOf(await t.call('GET', '/v1/catalog/products/gamma'), 404);
		problemOf(await t.call('GET', '/v1/catalog/products/nope'), 404);

		// INTERFACES.md reads
		expect(await t.service().appBySlug('gamma')).toMatchObject({ slug: 'gamma', status: 'pending' });
		await expect(t.service().appBySlug('nope')).rejects.toMatchObject({ code: 'not_found' });
		await expect(t.service().getApp('app_nope')).rejects.toMatchObject({ code: 'not_found' });
		await expect(t.service().getManifest(/** @type {string} */ (ids[0]), 7)).rejects.toMatchObject({ code: 'not_found' });

		// staff listing: pagination and filters
		const page1 = await t.staff('GET', '/v1/admin/apps?limit=2');
		expect(page1.json.items).toHaveLength(2);
		expect(page1.headers.get('link')).toMatch(/rel="next"/);
		const page2 = await t.staff('GET', `/v1/admin/apps?limit=2&cursor=${page1.json.nextCursor}`);
		expect(page2.json).toMatchObject({ hasMore: false, nextCursor: null });
		expect([...page1.json.items, ...page2.json.items].map((/** @type {any} */ a) => a.appId)).toEqual([...ids].sort());
		const pending = await t.staff('GET', '/v1/admin/apps?status=pending&kind=service');
		expect(pending.json.items.map((/** @type {any} */ a) => a.slug)).toEqual(['gamma']);
		problemOf(await t.staff('GET', '/v1/admin/apps?status=bogus'), 400);
		problemOf(await t.staff('GET', '/v1/admin/apps?kind=bogus'), 400);
		problemOf(await t.staff('GET', '/v1/admin/apps', { roles: [] }), 403);
		problemOf(await t.staff('GET', '/v1/admin/apps/app_nope'), 404);
		problemOf(await t.staff('GET', '/v1/admin/apps/app_nope/versions'), 404);
	});
});
