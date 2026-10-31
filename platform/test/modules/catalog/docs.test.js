import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { manifest as notesManifest } from '@ss/contracts/testing';
import { closeMongoClients } from '../../../src/testing.js';
import { startMongo } from '../../helpers.js';
import { PORTAL_URL, bootPortal } from './boot.js';

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

describe('Docs hub (PLAN §10 B1, B2, B3)', () => {
	it('B1: serves public hub index with active catalog products; unplaced products readable with no login', async () => {
		const h = await boot('docs_hub_index');
		const owner = await h.owner();

		// Initially empty
		const emptyRes = await h.api.call('GET', '/v1/docs');
		expect(emptyRes.status).toBe(200);
		expect(emptyRes.json).toEqual({ items: [] });

		// Connect product inactive
		const m = notesManifest();
		const product = await h.connect(m, { active: false });

		// Inactive product is not in docs
		const inactiveRes = await h.api.call('GET', '/v1/docs');
		expect(inactiveRes.json?.items).toEqual([]);

		// Activate product
		await owner.post(`/v1/admin/products/${product.productId}/status`, { status: 'active' });

		// Public GET /v1/docs: no cookies, no Authorization header
		const publicRes = await h.api.call('GET', '/v1/docs');
		expect(publicRes.status).toBe(200);
		expect(publicRes.json?.items).toHaveLength(1);
		const item = publicRes.json?.items[0];
		expect(item).toMatchObject({
			productId: product.productId,
			name: m.name,
			version: m.version,
			status: 'active',
			docsUrl: `/docs/${product.productId}`,
			openapiUrl: `/docs/${product.productId}/openapi.json`,
			widgetScriptUrl: m.widgetScriptUrl,
			widgetScriptLoading: 'async',
		});
		expect(item.features).toEqual(m.features);
		expect(item.needs).toEqual({ database: true, storage: 'none' });
	});

	it('B2: serves product documentation and live OpenAPI spec from product baseUrl', async () => {
		const h = await boot('docs_product_detail');
		const m = notesManifest();
		const product = await h.connect(m, { active: true });

		// Public GET /v1/docs/:productId
		const detailRes = await h.api.call('GET', `/v1/docs/${product.productId}`);
		expect(detailRes.status).toBe(200);
		expect(detailRes.json?.product).toMatchObject({
			productId: product.productId,
			name: m.name,
			version: m.version,
			status: 'active',
			docsUrl: `/docs/${product.productId}`,
			openapiUrl: `/docs/${product.productId}/openapi.json`,
		});
		// Operations extracted from fake product's /openapi.json
		expect(detailRes.json?.product?.operations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					method: 'GET',
					path: '/v1/test',
					summary: 'Test operation',
					auth: 'server',
					permission: 'test.read',
				}),
			]),
		);

		// Public GET /v1/docs/:productId/openapi.json
		const openapiRes = await h.api.call('GET', `/v1/docs/${product.productId}/openapi.json`);
		expect(openapiRes.status).toBe(200);
		expect(openapiRes.json).toMatchObject({
			openapi: '3.1.0',
			info: { title: `${m.name} API` },
			paths: {
				'/v1/test': {
					get: {
						summary: 'Test operation',
						'x-ss-auth': 'server',
						'x-ss-permission': 'test.read',
					},
				},
			},
		});

		// 404 for unknown or inactive product
		const missingRes = await h.api.call('GET', '/v1/docs/unknown-product');
		expect(missingRes.status).toBe(404);
		const missingOpenapi = await h.api.call('GET', '/v1/docs/unknown-product/openapi.json');
		expect(missingOpenapi.status).toBe(404);
	});

	it('B2: serves aggregated catalog OpenAPI spec index', async () => {
		const h = await boot('docs_catalog_openapi');
		const m = notesManifest();
		const product = await h.connect(m, { active: true });

		const catalogRes = await h.api.call('GET', '/v1/docs/openapi.json');
		expect(catalogRes.status).toBe(200);
		expect(catalogRes.json).toMatchObject({
			openapi: '3.1.0',
			info: { title: 'Shelfway Catalog OpenAPI' },
			'x-products': [
				{
					productId: product.productId,
					name: m.name,
					docsUrl: `${PORTAL_URL}/docs/${product.productId}`,
					openapiUrl: `${PORTAL_URL}/docs/${product.productId}/openapi.json`,
				},
			],
		});
	});

	it('B3: developer pack includes docsHubUrl and products point to docs hub URLs', async () => {
		const h = await boot('docs_dev_pack');
		const owner = await h.owner();
		const m = notesManifest();
		const product = await h.connect(m, { active: true });

		const merchant = await h.merchant('merchant@shop.test', ['shop.example.com']);
		const websiteId = String(merchant.websiteIds[0]);
		await owner.post(`/v1/merchants/${merchant.merchantId}/websites/${websiteId}/products`, {
			productId: product.productId,
		});

		// A5 step-up OTP required for Developer Pack
		await owner.post('/v1/me/step-up-otp', {});
		const otpMsg = [...h.mailer.sent].reverse().find((msg) => msg.template === 'step_up_otp');
		const code = otpMsg?.data?.otp;

		const packRes = await owner.post(`/v1/merchants/${merchant.merchantId}/websites/${websiteId}/pack`, { code });
		expect(packRes.status).toBe(200);
		expect(packRes.json?.docsHubUrl).toBe(`${PORTAL_URL}/docs`);
		expect(packRes.json?.products).toHaveLength(1);
		const p = packRes.json?.products[0];
		expect(p.docs).toBe(`${PORTAL_URL}/docs/${product.productId}`);
		expect(p.openapi).toBe(`${PORTAL_URL}/docs/${product.productId}/openapi.json`);
	});
});
