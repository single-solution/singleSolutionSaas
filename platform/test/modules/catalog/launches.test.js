import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { manifest as notesManifest } from '@ss/contracts/testing';
import { closeMongoClients } from '../../../src/infra/db.js';
import { startMongo } from '../../helpers.js';
import { bootPortal, codeOf } from './boot.js';

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

/**
 * A merchant with three websites; notes on the first two, then removed from the second.
 * @param {string} name
 */
const setUp = async (name) => {
	const h = await bootPortal({
		db: mongo.db(name),
		settings: {
			branding: { name: 'Acme Portal', accent: '#112233' },
			support: { email: 'help@acme.test', phone: '+92 300 0000000', whatsapp: '+92 300 1111111' },
		},
	});
	cleanups.push(h.close);
	const owner = await h.owner();
	const product = await h.connect(notesManifest());
	const m = await h.merchant('m@shop.test', ['shop.example.com', 'blog.example.com', 'bare.example.com']);
	const [w1, w2, w3] = m.websiteIds;
	for (const websiteId of [w1, w2])
		await owner.post(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`, { productId: 'notes' });
	await owner.del(`/v1/merchants/${m.merchantId}/websites/${w2}/products/notes`);
	return { h, owner, product, m, w1: String(w1), w2: String(w2), w3: String(w3) };
};

describe('launches (PLAN 0.4.3)', () => {
	it('merchant launches name the merchant, its websites that have the product and the website to open', async () => {
		const { h, product, m, w1, w2, w3 } = await setUp('launch_merchant');
		const path = (/** @type {string} */ websiteId) =>
			`/v1/merchants/${m.merchantId}/websites/${websiteId}/products/notes/launch`;
		const opened = await m.client.post(path(w1));
		expect(opened.status).toBe(200);
		expect(opened.json.url.startsWith(`${product.url}/sso?launch=`)).toBe(true);
		expect(opened.json.expiresAt).toBe('2026-10-01T10:01:00.000Z');
		const claims = await h.verify(opened.json.url, 'notes');
		expect(claims).toMatchObject({
			iss: 'https://portal.test',
			aud: 'notes',
			sub: m.merchantId,
			kind: 'merchant',
			sessionExpiresAt: '2026-10-01T22:00:00.000Z',
			branding: { name: 'Acme Portal', accent: '#112233', logoUrl: null },
			support: { email: 'help@acme.test', phone: '+92 300 0000000', whatsapp: '+92 300 1111111' },
			merchant: { id: m.merchantId, name: m.name, websites: [{ websiteId: w1, domain: 'shop.example.com' }], websiteId: w1 },
		});
		expect(claims.admin).toBeUndefined();
		// removed products and websites without the product cannot be opened; nor can another merchant's
		expect(codeOf(await m.client.post(path(w2)))).toEqual([404, 'not_found']);
		expect(codeOf(await m.client.post(path(w3)))).toEqual([404, 'not_found']);
		const other = await h.merchant('o@shop.test', ['other.example.com']);
		expect(codeOf(await other.client.post(path(w1)))).toEqual([403, 'forbidden']);
		// admins open through the admin route, never the merchant one
		expect((await (await h.owner()).post(path(w1))).status).toBe(401);
		expect((await h.activity('product.dashboard_opened'))[0]).toMatchObject({
			actor: { type: 'merchant', id: m.merchantId },
			merchantId: m.merchantId,
			target: { type: 'website', id: w1 },
			after: { productId: 'notes', kind: 'merchant' },
		});
		// a suspended merchant cannot open any product (the session ends; the service refuses too)
		await (await h.owner()).post(`/v1/admin/merchants/${m.merchantId}/suspend`, { reason: 'unpaid' });
		expect((await m.client.post(path(w1))).status).toBe(401);
		const catalog = /** @type {any} */ (h.portal.modules.service('catalog'));
		const session = { expiresAt: new Date(Date.UTC(2026, 9, 1, 22)) };
		await expect(
			catalog.merchantLaunch({
				merchantId: m.merchantId,
				websiteId: w1,
				productId: 'notes',
				session,
				actor: { type: 'merchant', id: m.merchantId },
			}),
		).rejects.toMatchObject({ code: 'merchant_suspended' });
	});

	it('admin launches: Owner and Support for a website that has the product, Owners only with no website; Finance refused', async () => {
		const { h, owner, m, w1, w2 } = await setUp('launch_admin');
		const support = await h.admin('support');
		const finance = await h.admin('finance');
		const open = (/** @type {any} */ client, /** @type {unknown} */ body) =>
			client.post('/v1/admin/products/notes/launch', body);
		const forSite = await open(support.client, { websiteId: w1 });
		expect(forSite.status).toBe(200);
		expect(await h.verify(forSite.json.url, 'notes')).toMatchObject({
			kind: 'admin',
			sub: support.adminId,
			admin: { id: support.adminId, name: 'support admin', role: 'support', websiteId: w1 },
		});
		expect(codeOf(await open(support.client, {}))).toEqual([403, 'forbidden']); // no website: Owner only
		const defaults = await open(owner, {});
		expect((await h.verify(defaults.json.url, 'notes')).admin).toMatchObject({
			role: 'owner',
			websiteId: null,
			name: 'Olivia Owner',
		});
		expect(codeOf(await open(finance.client, { websiteId: w1 }))).toEqual([403, 'forbidden']);
		expect(codeOf(await open(owner, { websiteId: w2 }))).toEqual([404, 'not_found']); // removed
		expect(codeOf(await open(owner, { websiteId: 'nope' }))).toEqual([422, 'validation_failed']);
		expect(codeOf(await owner.post('/v1/admin/products/ghost/launch', {}))).toEqual([404, 'not_found']);
		expect((await m.client.post('/v1/admin/products/notes/launch', { websiteId: w1 })).status).toBe(401);
		// admins can still open a suspended merchant's products
		await owner.post(`/v1/admin/merchants/${m.merchantId}/suspend`, { reason: 'unpaid' });
		expect((await open(owner, { websiteId: w1 })).status).toBe(200);
		// the service refuses a Finance actor whatever the route
		const catalog = /** @type {any} */ (h.portal.modules.service('catalog'));
		await expect(
			catalog.adminLaunch({
				productId: 'notes',
				websiteId: w1,
				session: { expiresAt: new Date() },
				actor: { type: 'admin', id: finance.adminId, role: 'finance' },
			}),
		).rejects.toMatchObject({ code: 'forbidden' });
	});

	it('the product consumes each launch once; the launch ends with the launching session', async () => {
		const { h, product, m, w1, owner } = await setUp('launch_consume');
		const opened = await m.client.post(`/v1/merchants/${m.merchantId}/websites/${w1}/products/notes/launch`);
		const { jti } = await h.verify(opened.json.url, 'notes');
		expect((await h.productCall(product, 'POST', '/v1/product/launch/consume', { jti })).json).toEqual({ consumed: true });
		expect((await h.productCall(product, 'POST', '/v1/product/launch/consume', { jti })).json).toEqual({ consumed: false });
		expect((await h.productCall(product, 'POST', '/v1/product/launch/consume', { jti: 'x'.repeat(22) })).json).toEqual({
			consumed: false,
		});
		expect(codeOf(await h.productCall(product, 'POST', '/v1/product/launch/consume', { jti: 'bad' }))).toEqual([
			422,
			'validation_failed',
		]);
		// an expired launch is not consumed
		const late = await owner.post('/v1/admin/products/notes/launch', { websiteId: w1 });
		const lateClaims = await h.verify(late.json.url, 'notes');
		h.clock.advance(120_000);
		expect((await h.productCall(product, 'POST', '/v1/product/launch/consume', { jti: lateClaims.jti })).json).toEqual({
			consumed: false,
		});
		expect((await h.api.call('POST', '/v1/product/launch/consume', { body: { jti } })).status).toBe(401);
	});
});
