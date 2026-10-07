import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { manifest as notesManifest } from '@ss/contracts/testing';
import { closeMongoClients } from '../../../src/infra/db.js';
import { launchUrl, parseAdminLaunch, parseConnect, parseConsume, parseStatus } from '../../../src/modules/catalog/core/input.js';
import { startMongo } from '../../helpers.js';
import { bootPortal, codeOf } from './boot.js';
import { startFakeProduct } from './fakes/product.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
/** @type {Array<() => Promise<unknown>>} */
const cleanups = [];
beforeAll(async () => {
	mongo = await startMongo();
}, 180_000);
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});

/** @param {string} name */
const boot = async (name) => {
	const h = await bootPortal({ db: mongo.db(name) });
	cleanups.push(h.close);
	return h;
};

/** @param {Parameters<typeof startFakeProduct>[0]} options */
const fake = async (options) => {
	const product = await startFakeProduct(options);
	cleanups.push(product.close);
	return product;
};

describe('catalog inputs (pure)', () => {
	it('parses connect, status, launch and consume bodies; builds launch URLs', () => {
		expect(parseConnect({ url: 'https://p.example', secret: 's' }, { urlRequired: true })).toEqual({
			ok: true,
			value: { url: 'https://p.example', secret: 's' },
		});
		expect(parseConnect({ secret: 's' }, { urlRequired: false })).toEqual({ ok: true, value: { url: null, secret: 's' } });
		expect(parseConnect({ secret: '' }, { urlRequired: true })).toMatchObject({ ok: false });
		expect(parseConnect({ url: 5, secret: 's', x: 1 }, { urlRequired: false })).toMatchObject({
			ok: false,
			errors: [
				{ path: '/x', message: 'unknown property' },
				{ path: '/url', message: 'must be a URL' },
			],
		});
		expect(parseConnect(null, { urlRequired: true })).toMatchObject({ ok: false });
		expect(parseStatus({ status: 'active' })).toEqual({ ok: true, value: { status: 'active' } });
		expect(parseStatus({ status: 'gone' }).ok).toBe(false);
		expect(parseAdminLaunch(undefined)).toEqual({ ok: true, value: { websiteId: null } });
		expect(parseAdminLaunch({ websiteId: 'web_0123456789abcdefghjk' })).toMatchObject({ ok: true });
		expect(parseAdminLaunch({ websiteId: 'nope' }).ok).toBe(false);
		expect(parseConsume({ jti: 'a'.repeat(22) })).toEqual({ ok: true, value: { jti: 'a'.repeat(22) } });
		expect(parseConsume({ jti: 'short' }).ok).toBe(false);
		expect(launchUrl('https://p.example/', 'a b')).toBe('https://p.example/sso?launch=a%20b');
	});
});

describe('Products (PLAN 0.8.2): Add product, Reconnect, active / inactive', () => {
	it('connects a product under its manifest id, inactive, with price list 1; refuses an id already connected', async () => {
		const h = await boot('cat_connect');
		const owner = await h.owner();
		const product = await fake({ manifest: notesManifest(), portalUrl: 'https://portal.test', now: h.clock.now });
		const added = await owner.post('/v1/admin/products', { url: product.url, secret: product.secret });
		expect(added.status).toBe(201);
		expect(added.json.product).toEqual({
			productId: 'notes',
			name: 'Notes',
			status: 'inactive',
			baseUrl: product.url,
			version: '1.0.0',
			widgetScriptUrl: 'https://notes.example.dev/widget.js',
			docsUrl: `${product.url}/docs`,
			connectedAt: '2026-10-01T10:00:00.000Z',
			reconnectedAt: null,
		});
		// the product pinned PORTAL_URL and the Portal keys; the Portal sent its last accepted version (none yet)
		expect(product.connects).toEqual([{ portalUrl: 'https://portal.test', baseUrl: product.url, priceListVersion: 0 }]);
		const detail = await owner.get('/v1/admin/products/notes');
		expect(detail.json).toMatchObject({
			priceListVersion: 1,
			features: [
				{ key: 'notes', name: 'Notes', dependsOn: [], millicreditsPerHour: 0 },
				{ key: 'inbox', name: 'Notes inbox', dependsOn: ['notes'], millicreditsPerHour: 0 },
			],
			numbers: { productId: 'notes', websites: 0, earnedThisMonth: 0 },
		});
		expect(detail.json.numbers.days).toHaveLength(30);
		expect((await owner.get('/v1/admin/products')).json.items).toMatchObject([
			{ productId: 'notes', status: 'inactive', websites: 0, earnedThisMonth: 0 },
		]);
		expect((await owner.get('/v1/admin/products?status=active')).json.items).toEqual([]);
		expect(codeOf(await owner.get('/v1/admin/products?status=gone'))).toEqual([400, 'bad_request']);
		expect(codeOf(await owner.get('/v1/admin/products/unknown'))).toEqual([404, 'not_found']);
		expect((await h.activity('product.connected'))[0]).toMatchObject({
			target: { type: 'product', id: 'notes' },
			after: { productId: 'notes', baseUrl: product.url },
		});
		// the same id again: use Reconnect
		const again = await owner.post('/v1/admin/products', { url: product.url, secret: product.secret });
		expect(codeOf(again)).toEqual([409, 'conflict']);
		expect(again.json.detail).toContain('use Reconnect');
		// the product's client assertions are accepted with the key it answered
		const directory = await h.productCall(product, 'GET', '/v1/product/directory/notes');
		expect(directory.json).toEqual({ baseUrl: product.url });
		expect(codeOf(await h.productCall(product, 'GET', '/v1/product/directory/other'))).toEqual([404, 'not_found']);
		expect((await h.api.call('GET', '/v1/product/directory/notes')).status).toBe(401);
	});

	it('refuses bad input, refused targets and answers that do not verify', async () => {
		const h = await boot('cat_connect_refused');
		const owner = await h.owner();
		const product = await fake({ manifest: notesManifest(), portalUrl: 'https://portal.test', now: h.clock.now });
		const add = (/** @type {Record<string, unknown>} */ body) => owner.post('/v1/admin/products', body);
		expect(codeOf(await add({ url: product.url }))).toEqual([422, 'validation_failed']);
		expect(codeOf(await add({ url: product.url, secret: 'short' }))).toEqual([422, 'validation_failed']);
		expect(codeOf(await add({ url: 'not a url', secret: product.secret }))).toEqual([422, 'validation_failed']);
		expect(codeOf(await add({ url: 'http://10.0.0.8:3000', secret: product.secret }))).toEqual([422, 'catalog_target_refused']);
		expect(codeOf(await add({ url: product.url, secret: `${product.secret}-wrong` }))).toEqual([401, 'unauthorized']);
		for (const [tampered, expected] of /** @type {const} */ ([
			['no_secret', [502, 'upstream_error']],
			['status_500', [502, 'upstream_error']],
			['bad_signature', [502, 'upstream_error']],
			['other_nonce', [502, 'upstream_error']],
			['other_id', [422, 'invalid_manifest']],
			['bad_prices', [422, 'validation_failed']],
		])) {
			product.tamper.connect = tampered;
			expect([tampered, ...codeOf(await add({ url: product.url, secret: product.secret }))]).toEqual([tampered, ...expected]);
		}
		delete product.tamper.connect;
		product.setManifest({ ...notesManifest(), features: 'none' });
		expect(codeOf(await add({ url: product.url, secret: product.secret }))).toEqual([422, 'invalid_manifest']);
		// nothing was stored; a closed port cannot be reached
		expect((await owner.get('/v1/admin/products')).json.items).toEqual([]);
		await product.close();
		expect(codeOf(await add({ url: product.url, secret: product.secret }))).toEqual([502, 'upstream_error']);
	});

	it('Reconnect keeps everything, needs the same id and handles the returned price list as a price report', async () => {
		const h = await boot('cat_reconnect');
		const owner = await h.owner();
		const product = await h.connect(notesManifest());
		const m = await h.merchant('m@shop.test', ['shop.example.com']);
		expect(
			(await owner.post(`/v1/merchants/${m.merchantId}/websites/${m.websiteIds[0]}/products`, { productId: 'notes' })).status,
		).toBe(201);
		// the product reported a newer price list meanwhile
		await h.productCall(product, 'PUT', '/v1/product/prices', {
			version: 2,
			features: [
				{ key: 'notes', name: 'Notes', description: 'Notes.', dependsOn: [], millicreditsPerHour: 1000 },
				{ key: 'inbox', name: 'Inbox', description: 'Inbox.', dependsOn: ['notes'], millicreditsPerHour: 0 },
			],
		});
		const oldAssertion = await product.assertion();
		// a new key and a new list, at the same address (secret given again, URL kept)
		await product.rotateKey('product-k2');
		product.setPrices({
			version: 3,
			features: [{ key: 'notes', name: 'Notes', description: 'Notes.', dependsOn: [], millicreditsPerHour: 2000 }],
		});
		const reconnected = await owner.post('/v1/admin/products/notes/reconnect', { secret: product.secret });
		expect(reconnected.status).toBe(200);
		expect(reconnected.json.product).toMatchObject({ productId: 'notes', status: 'active', reconnectedAt: expect.any(String) });
		expect(product.connects.at(-1)).toMatchObject({ priceListVersion: 2 });
		expect((await owner.get('/v1/admin/products/notes')).json).toMatchObject({
			priceListVersion: 3,
			features: [{ key: 'notes', millicreditsPerHour: 2000 }],
		});
		expect((await h.activity('product.prices_changed')).map((e) => e.after.version).sort()).toEqual([2, 3]);
		expect((await h.activity('product.reconnected'))[0]).toMatchObject({ before: { baseUrl: product.url } });
		// the old key no longer signs assertions; the new one does; the product stays on the website
		expect((await h.api.call('GET', '/v1/product/directory/notes', { bearer: oldAssertion })).status).toBe(401);
		expect((await h.productCall(product, 'GET', `/v1/product/websites/${m.websiteIds[0]}/status`)).json.status).toBe('active');
		// same version again: nothing to record
		expect((await owner.post('/v1/admin/products/notes/reconnect', { secret: product.secret })).status).toBe(200);
		expect(await h.activity('product.prices_changed')).toHaveLength(2);
		// a lower version is refused and nothing changes
		product.tamper.pricesVersion = 1;
		expect(codeOf(await owner.post('/v1/admin/products/notes/reconnect', { secret: product.secret }))).toEqual([
			409,
			'conflict',
		]);
		delete product.tamper.pricesVersion;
		// another product at the address: the same id is required
		const other = await startFakeProduct({
			manifest: { ...notesManifest(), id: 'other' },
			portalUrl: 'https://portal.test',
			now: h.clock.now,
		});
		cleanups.push(other.close);
		const wrong = await owner.post('/v1/admin/products/notes/reconnect', { url: other.url, secret: other.secret });
		expect(codeOf(wrong)).toEqual([409, 'conflict']);
		expect((await owner.get('/v1/admin/products/notes')).json.baseUrl).toBe(product.url);
		expect(codeOf(await owner.post('/v1/admin/products/notes/reconnect', { secret: 'short' }))).toEqual([
			422,
			'validation_failed',
		]);
		expect(codeOf(await owner.post('/v1/admin/products/ghost/reconnect', { secret: product.secret }))).toEqual([
			404,
			'not_found',
		]);
	});

	it('active / inactive: inactive products are not offered in Add product; websites that have them are unaffected', async () => {
		const h = await boot('cat_status');
		const owner = await h.owner();
		const product = await h.connect(notesManifest());
		const m = await h.merchant('m@shop.test', ['shop.example.com', 'blog.example.com']);
		const [w1, w2] = m.websiteIds;
		expect((await owner.post(`/v1/merchants/${m.merchantId}/websites/${w1}/products`, { productId: 'notes' })).status).toBe(
			201,
		);
		const off = await owner.post('/v1/admin/products/notes/status', { status: 'inactive' });
		expect(off.json.product.status).toBe('inactive');
		expect((await owner.post('/v1/admin/products/notes/status', { status: 'inactive' })).json.product.status).toBe('inactive');
		expect(codeOf(await owner.post(`/v1/merchants/${m.merchantId}/websites/${w2}/products`, { productId: 'notes' }))).toEqual([
			409,
			'conflict',
		]);
		expect((await h.productCall(product, 'GET', `/v1/product/websites/${w1}/status`)).json.status).toBe('active');
		expect(codeOf(await owner.post('/v1/admin/products/notes/status', { status: 'gone' }))).toEqual([422, 'validation_failed']);
		expect((await owner.post('/v1/admin/products/notes/status', { status: 'active' })).json.product.status).toBe('active');
		expect(await h.activity('product.deactivated')).toHaveLength(1);
		expect(await h.activity('product.activated')).toHaveLength(2);
	});
});
