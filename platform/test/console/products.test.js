// @vitest-environment jsdom
/**
 * Admin Products in the browser (jsdom) against a live in-process Portal with fake products (PLAN 0.8.2 Products): the
 * list with its search and Add product (missing fields, a refused secret, an unreachable address, an id already
 * connected → "use Reconnect", a new product connected inactive), and the product page (Open as admin on Defaults with
 * no website, Set active / inactive, Reconnect, the numbers and the paged websites of a selected product).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@ss/ui';
import { cleanup, render } from '@ss/ui/testing';
import { closeMongoClients } from '../../src/infra/db.js';
import * as admin from '../../src/console/admin/loaders.js';
import { ProductsView } from '../../src/console/admin/views/products.js';
import { startMongo } from '../helpers.js';
import { PORTAL_URL } from '../helpers.js';
import { startFakeProduct } from '../modules/catalog/fakes/product.js';
import {
	button,
	buttons,
	createWorld,
	dialog,
	fill,
	fillDialog,
	press,
	pressDialog,
	productManifest,
	quiet,
	shows,
	until,
} from './merchant-harness.js';

vi.mock('next/navigation.js', async (importOriginal) => {
	const { testRouter } = await import('./router.js');
	return { .../** @type {object} */ (await importOriginal()), useRouter: () => testRouter };
});

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
});
afterAll(async () => {
	await closeMongoClients();
	await mongo?.stop();
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** @param {import('react').ReactNode} node */
const withToasts = (node) => render(<ToastProvider durationMs={600_000}>{node}</ToastProvider>);

/**
 * The claims of a launch URL's token (decoded, not verified).
 * @param {string} url
 */
const claimsOf = (url) => {
	const token = String(new URL(url).searchParams.get('launch'));
	return JSON.parse(Buffer.from(String(token.split('.')[1]), 'base64url').toString('utf8'));
};

describe('admin Products (jsdom)', () => {
	it('lists products and connects one with Add product', async () => {
		const restore = quiet();
		const world = await createWorld({ db: mongo.db('products_add') });
		const delta = await startFakeProduct({ manifest: productManifest({ id: 'delta', name: 'Delta' }), portalUrl: PORTAL_URL });
		try {
			const { ownerBrowser, owner } = world;
			const notes = await world.connect();
			await world.connect({ id: 'chatty', name: 'Chatty' }, { active: false });
			ownerBrowser.use();
			withToasts(<ProductsView {...await admin.loadProducts(ownerBrowser.api, {})} admin={owner} />);
			expect(shows('Notes') && shows('Chatty') && shows('Inactive')).toBe(true);
			fill('Search products', 'chat');
			expect(shows('Notes')).toBe(false);
			fill('Search products', '');

			await press('Add product');
			expect(shows('New products start inactive.')).toBe(true);
			await pressDialog('Connect');
			expect(shows('Enter the product URL.') && shows('Enter the connect secret.')).toBe(true);
			// a secret too short, then a refused one
			fillDialog('Product URL', delta.url);
			fillDialog('Connect secret', 'not the secret');
			await pressDialog('Connect');
			await ownerBrowser.waitCall('POST', '/v1/admin/products', (st) => st === 422);
			fillDialog('Connect secret', 'w'.repeat(40));
			await pressDialog('Connect');
			await ownerBrowser.waitCall('POST', '/v1/admin/products', (st) => st === 401);
			expect(dialog().querySelector('[role="alert"]')).not.toBeNull();
			// an unreachable address
			fillDialog('Product URL', 'http://127.0.0.1:1');
			fillDialog('Connect secret', delta.secret);
			await pressDialog('Connect');
			await until(() => ownerBrowser.calls.some((c) => c.path === '/v1/admin/products' && c.status === 502));
			// an id already connected: use Reconnect
			fillDialog('Product URL', notes.url);
			fillDialog('Connect secret', notes.secret);
			await pressDialog('Connect');
			await until(() => ownerBrowser.calls.some((c) => c.path === '/v1/admin/products' && c.status === 409));
			await until(() => shows('This product is already connected. Open it and use Reconnect.'));
			// a new product: connected inactive, then its page opens
			fillDialog('Product URL', delta.url);
			fillDialog('Connect secret', delta.secret);
			await pressDialog('Connect');
			const created = await ownerBrowser.waitCall('POST', '/v1/admin/products', (st) => st === 201);
			expect(created.body.product).toMatchObject({ productId: 'delta', name: 'Delta', status: 'inactive' });
			await until(() => shows('Delta connected. It stays inactive until you set it active.'));
			cleanup();

			// Support sees the list read-only
			const { admin: support, b: supportBrowser } = await world.adminOf('support');
			supportBrowser.use();
			withToasts(<ProductsView {...await admin.loadProducts(supportBrowser.api, { status: 'inactive' })} admin={support} />);
			expect(shows('Chatty') && shows('Delta')).toBe(true);
			expect(shows('Notes')).toBe(false);
			expect(buttons('Add product')).toHaveLength(0);
		} finally {
			await delta.close();
			await world.close();
			restore();
		}
	});

	it('drives a selected product: Open as admin, Set active / inactive, Reconnect, its numbers and websites', async () => {
		const restore = quiet();
		const world = await createWorld({ db: mongo.db('products_page') });
		try {
			const { ownerBrowser, owner } = world;
			const notes = await world.connect();
			const { merchantId } = await world.signup('owner@shop.test', 'Shop & Co');
			const site = await world.addWebsite(merchantId, 'shop.example.com');
			await world.addProduct(merchantId, site.websiteId, 'notes');
			await world.switchFeatures(notes, site.websiteId, ['notes']);
			const open = vi.fn();
			vi.stubGlobal('open', open);
			ownerBrowser.use();
			const list = await admin.loadProducts(ownerBrowser.api, {});
			const loaded = await admin.loadProduct(ownerBrowser.api, 'notes');
			/** @param {Record<string, unknown>} [over] the selected product's loader result, changed */
			const screen = (over = {}) => (
				<ProductsView {...list} detail={{ ...loaded, ...over }} selectedId="notes" admin={owner} />
			);
			withToasts(screen());
			expect(document.querySelector('a[aria-current="page"]')?.textContent).toContain('Notes');
			expect(shows('Credits earned this month (UTC)') && shows('Websites using it')).toBe(true);
			expect(shows(notes.url)).toBe(true);

			// Open as admin: Defaults, no website picked
			await press('Open as admin');
			const launched = await ownerBrowser.waitCall('POST', '/v1/admin/products/notes/launch', (st) => st === 200);
			expect(open).toHaveBeenCalledWith(launched.body.url, '_blank', 'noopener,noreferrer');
			expect(claimsOf(launched.body.url)).toMatchObject({ kind: 'admin', admin: { role: 'owner', websiteId: null } });

			// Set inactive, then active again
			await press('Set inactive');
			await ownerBrowser.waitCall('POST', '/v1/admin/products/notes/status', (st) => st === 200);
			await until(() => shows('The product is inactive'));
			expect(buttons('Set active')).toHaveLength(1);
			await press('Set active');
			await until(
				() => ownerBrowser.calls.filter((c) => c.path === '/v1/admin/products/notes/status' && c.status === 200).length === 2,
			);
			await until(() => shows('The product is active'));

			// Reconnect: the secret is required; a wrong one is refused; the same id reconnects
			await press('Reconnect');
			expect(shows('New product URL (optional)')).toBe(true);
			await pressDialog('Reconnect');
			expect(shows('Enter the connect secret.')).toBe(true);
			fillDialog('Connect secret', 'w'.repeat(40));
			await pressDialog('Reconnect');
			await ownerBrowser.waitCall('POST', '/v1/admin/products/notes/reconnect', (st) => st === 401);
			fillDialog('Connect secret', notes.secret);
			await pressDialog('Reconnect');
			await ownerBrowser.waitCall('POST', '/v1/admin/products/notes/reconnect', (st) => st === 200);
			await until(() => shows('Reconnected.'));
			expect(shows('Reconnected')).toBe(true);

			// Websites using it (on the same page): merchant, domain, status, features on, daily cost; the domain opens its
			// website card on the merchant's page
			expect(shows('shop.example.com') && shows('Shop & Co') && shows('Notes')).toBe(true);
			expect(document.querySelector(`a[href="/admin/merchants/${merchantId}#website-${site.websiteId}"]`)).not.toBeNull();
			cleanup();

			// the next page of websites, and failures (a stubbed Portal)
			const more = {
				websiteId: 'web_more',
				domain: 'more.example.com',
				merchantId,
				merchantName: 'Shop & Co',
				status: 'active',
				featuresOn: [],
				dailyCost: 0,
			};
			/** @type {Array<{ url: string, method: string }>} */
			const asked = [];
			let failing = false;
			vi.stubGlobal('fetch', async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
				asked.push({ url: String(url), method: init.method ?? 'GET' });
				if (failing) return new Response(JSON.stringify({ status: 500, title: 'Boom' }), { status: 500 });
				return new Response(JSON.stringify({ items: [more], cursor: null }), { status: 200 });
			});
			if (!loaded.ok) throw new Error('product');
			withToasts(screen({ websites: { items: loaded.websites.items, cursor: 'next-page' } }));
			await press('Load more');
			await until(() => shows('more.example.com'));
			expect(asked.at(-1)).toEqual({ url: '/v1/admin/products/notes/websites?cursor=next-page', method: 'GET' });
			expect(buttons('Load more')).toHaveLength(0);
			cleanup();
			failing = true;
			withToasts(screen({ websites: { items: [], cursor: 'next-page' } }));
			expect(shows('No website has this product yet.')).toBe(true);
			await press('Load more');
			await until(() => shows('Something went wrong on our side.'));
			await press('Open as admin');
			await until(() => buttons('Open as admin').length === 1 && !button('Open as admin').disabled);
			expect(open).toHaveBeenCalledTimes(1);
			await press('Set inactive');
			await until(() => document.querySelectorAll('[role="status"], [role="alert"]').length > 0);
			expect(buttons('Set inactive')).toHaveLength(1);
		} finally {
			await world.close();
			restore();
		}
	});
});
