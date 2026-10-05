import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestIdentityIssuer } from '@ss/app-kit/testing';
import { CONNECTED, URLS, WEBSITE, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** @type {ReturnType<typeof createTestIdentityIssuer>} */
let issuer;

beforeAll(async () => {
	h = await createHarness({ config: CONNECTED });
	issuer = createTestIdentityIssuer({ issuer: 'https://id.shop.example.com' });
	await h.entitle({ identity: issuer.section });
	await h.call('PUT', '/v1/integrations/key', { body: { key: 'sk_live_integration_key_0123456789' } });
}, 60_000);
afterAll(async () => h?.close());

/** @param {string} subject */
const as = async (subject) => {
	const now = Math.floor(h.clock.now() / 1000);
	return {
		key: h.pk,
		headers: { 'ss-identity': issuer.sign({ iss: issuer.section.issuer, sub: subject, iat: now, exp: now + 900 }) },
	};
};

describe('items', () => {
	it('stores merchant items (sk only) and shows browsers no stock counts', async () => {
		await h.item('itm_socks', {
			variants: [
				{ variantId: 'm', price: 1200, available: 3, sku: 'S-M' },
				{ variantId: 'l', price: 1300 },
			],
		});
		expect((await h.call('PUT', '/v1/items/itm_x', { body: { title: 'x' } })).status).toBe(422);
		expect((await h.call('PUT', '/v1/items/itm_x', { key: h.pk, body: { title: 'x' } })).status).toBe(403);
		const browser = await h.call('GET', '/v1/items/itm_socks', { key: h.pk });
		expect(browser.json.variants[0]).toMatchObject({ inStock: true });
		expect(browser.json.variants[0].available).toBeUndefined();
		expect((await h.call('GET', '/v1/items/itm_socks')).json.variants[0].available).toBe(3);
		expect((await h.call('GET', '/v1/items/nope')).status).toBe(404);
		const page = await h.call('GET', '/v1/items?limit=1');
		expect(page.json.items).toHaveLength(1);
		await h.item('itm_gone');
		expect((await h.call('DELETE', '/v1/items/itm_gone')).status).toBe(200);
		expect((await h.call('DELETE', '/v1/items/itm_gone')).status).toBe(404);
	});

	it('mirrors Catalog events (items, prices, stock)', async () => {
		const data = {
			itemId: 'itm_cat',
			title: 'Catalog item',
			currency: 'EUR',
			variants: [{ variantId: 'v', price: 900, inventory: 2 }],
		};
		expect((await h.deliver('item.created@1', data)).status).toBe(200);
		await h.deliver('price.changed@1', { itemId: 'itm_cat', variantId: 'v', price: { amount: 950, currency: 'EUR' } });
		await h.deliver('inventory.changed@1', { itemId: 'itm_cat', variantId: 'v', quantity: 7, available: 6 });
		await h.deliver('price.changed@1', { itemId: 'itm_unknown', price: { amount: 1, currency: 'EUR' } });
		await h.deliver('price.changed@1', { itemId: 'itm_cat', price: { amount: 1, currency: 'USD' } });
		await h.deliver('item.updated@1', { itemId: 'itm_cat' });
		await h.deliver('item.updated@1', { notAnItem: true });
		const item = (await h.call('GET', '/v1/items/itm_cat')).json;
		expect(item.variants[0]).toMatchObject({ price: 950, available: 6 });
		await h.deliver('item.created@1', {
			itemId: 'itm_del',
			title: 'x',
			currency: 'EUR',
			variants: [{ variantId: 'v', price: 1 }],
		});
		await h.deliver('item.deleted@1', { itemId: 'itm_del' });
		await h.deliver('item.deleted@1', { itemId: 'itm_del' });
		expect((await h.call('GET', '/v1/items/itm_del')).status).toBe(404);
	});
});

describe('carts', () => {
	it('creates guest carts, prices lines on the server, caps and reports changes', async () => {
		const created = await h.call('POST', '/v1/carts', { key: h.pk, body: { note: 'gift' } });
		expect(created.status).toBe(201);
		expect(created.json).toMatchObject({ status: 'open', currency: 'EUR', lines: [], signedIn: false, note: 'gift' });
		const id = created.json.id;
		const added = await h.call('POST', `/v1/carts/${id}/lines`, {
			key: h.pk,
			body: { itemId: 'itm_socks', variantId: 'm', quantity: 5, unitAmount: 1 },
		});
		expect(added.status).toBe(200);
		expect(added.json.lines[0]).toMatchObject({ unitAmount: 1200, quantity: 3, maxQuantity: 3 });
		expect(added.json.changes[0]).toMatchObject({ kind: 'quantity', to: 3 });
		const many = await h.call('POST', `/v1/carts/${id}/lines`, {
			key: h.pk,
			body: { lines: [{ itemId: 'itm_socks', variantId: 'l', quantity: 1, note: 'blue' }] },
		});
		expect(many.json.lines).toHaveLength(2);
		expect(many.json.subtotalAmount).toBe(3 * 1200 + 1300);
		expect(
			(await h.call('POST', `/v1/carts/${id}/lines`, { key: h.pk, body: { itemId: 'itm_none', quantity: 1 } })).json.type,
		).toMatch(/item_unavailable$/);
		expect(
			(
				await h.call('POST', `/v1/carts/${id}/lines`, {
					key: h.pk,
					body: {
						lines: [
							{ itemId: 'itm_none', quantity: 1 },
							{ itemId: 'itm_socks', variantId: 'm', quantity: 1 },
						],
					},
				})
			).status,
		).toBe(409);
		expect((await h.call('POST', `/v1/carts/${id}/lines`, { key: h.pk, body: { itemId: '!', quantity: 1 } })).status).toBe(422);
		expect(
			(await h.call('POST', `/v1/carts/${id}/lines`, { key: h.pk, body: { itemId: 'itm_socks', variantId: '!' } })).status,
		).toBe(422);
		expect(
			(await h.call('POST', `/v1/carts/${id}/lines`, { key: h.pk, body: { itemId: 'itm_socks', quantity: 0 } })).status,
		).toBe(422);
		expect((await h.call('POST', `/v1/carts/${id}/lines`, { key: h.pk, body: { lines: [] } })).status).toBe(422);
		const line = many.json.lines[1].lineId;
		const patched = await h.call('PATCH', `/v1/carts/${id}/lines/${line}`, { key: h.pk, body: { quantity: 2, note: 'red' } });
		expect(patched.json.lines[1]).toMatchObject({ quantity: 2, note: 'red' });
		expect(
			(await h.call('PATCH', `/v1/carts/${id}/lines/${line}`, { key: h.pk, body: { note: 'green' } })).json.lines[1].note,
		).toBe('green');
		expect((await h.call('PATCH', `/v1/carts/${id}/lines/nope`, { key: h.pk, body: { note: 'x' } })).status).toBe(404);
		expect((await h.call('PATCH', `/v1/carts/${id}/lines/nope`, { key: h.pk, body: { quantity: 1 } })).status).toBe(404);
		expect((await h.call('PATCH', `/v1/carts/${id}/lines/${line}`, { key: h.pk, body: { quantity: -1 } })).status).toBe(422);
		expect((await h.call('PATCH', `/v1/carts/${id}`, { key: h.pk, body: { note: 'new' } })).json.note).toBe('new');
		expect((await h.call('DELETE', `/v1/carts/${id}/lines/${line}`, { key: h.pk })).json.lines).toHaveLength(1);
		expect((await h.call('GET', `/v1/carts/${id}`, { key: h.pk })).json.lines).toHaveLength(1);
		expect((await h.call('GET', '/v1/carts/crt_unknown', { key: h.pk })).status).toBe(404);
		expect((await h.call('GET', '/v1/carts/!!', { key: h.pk })).status).toBe(404);
		expect(h.published('cart.updated@1').length).toBeGreaterThan(0);
		const list = await h.call('GET', '/v1/carts?limit=1');
		expect(list.json.items).toHaveLength(1);
		expect((await h.call('GET', '/v1/carts', { key: h.pk })).status).toBe(403);
	});

	it('reconciles price and stock changes', async () => {
		const id = await h.cartWith([
			{ itemId: 'itm_socks', variantId: 'm', quantity: 3 },
			{ itemId: 'itm_socks', variantId: 'l', quantity: 1 },
		]);
		expect((await h.call('POST', `/v1/carts/${id}/reconcile`, { key: h.pk })).json.changes).toEqual([]);
		await h.item('itm_socks', { variants: [{ variantId: 'm', price: 1100, available: 1 }] });
		const result = await h.call('POST', `/v1/carts/${id}/reconcile`, { key: h.pk });
		expect(result.json.changes.map((/** @type {any} */ c) => c.kind)).toEqual(['price', 'quantity', 'unavailable']);
		expect(result.json.lines[1].available).toBe(false);
		await h.item('itm_socks', {
			variants: [
				{ variantId: 'm', price: 1200, available: 3, sku: 'S-M' },
				{ variantId: 'l', price: 1300 },
			],
		});
	});

	it('guards signed-in carts and merges a guest cart on sign-in', async () => {
		const ada = await as('user_ada');
		const own = await h.call('POST', '/v1/carts', { ...ada, body: {} });
		expect(own.json.signedIn).toBe(true);
		expect((await h.call('POST', '/v1/carts', { ...ada, body: {} })).json.id).toBe(own.json.id);
		await h.call('POST', `/v1/carts/${own.json.id}/lines`, {
			...ada,
			body: { itemId: 'itm_socks', variantId: 'm', quantity: 1 },
		});
		expect((await h.call('GET', `/v1/carts/${own.json.id}`, { key: h.pk })).status).toBe(404);
		expect((await h.call('GET', `/v1/carts/${own.json.id}`, { ...(await as('user_bob')) })).status).toBe(404);
		expect((await h.call('GET', `/v1/carts/${own.json.id}`)).status).toBe(200);
		const guest = await h.cartWith([
			{ itemId: 'itm_socks', variantId: 'm', quantity: 1 },
			{ itemId: 'itm_socks', variantId: 'l', quantity: 2 },
		]);
		expect((await h.call('POST', `/v1/carts/${guest}/merge`, { key: h.pk })).status).toBe(401);
		const merged = await h.call('POST', `/v1/carts/${guest}/merge`, { ...ada });
		expect(merged.status).toBe(200);
		expect(merged.json.id).toBe(own.json.id);
		expect(merged.json.lines.map((/** @type {any} */ l) => l.quantity)).toEqual([2, 2]);
		expect((await h.call('GET', `/v1/carts/${guest}`)).json.status).toBe('merged');
		expect(
			(await h.call('POST', `/v1/carts/${guest}/lines`, { ...ada, body: { itemId: 'itm_socks', quantity: 1 } })).status,
		).toBe(409);
		// a shopper without a cart claims the guest cart
		const lone = await h.cartWith([{ itemId: 'itm_socks', variantId: 'l', quantity: 1 }]);
		const claimed = await h.call('POST', `/v1/carts/${lone}/merge`, { ...(await as('user_cy')) });
		expect(claimed.json).toMatchObject({ id: lone, signedIn: true });
		expect((await h.call('POST', `/v1/carts/${lone}/merge`, { ...(await as('user_cy')) })).json.id).toBe(lone);
		const server = await h.call('POST', '/v1/carts', { body: { customerId: 'user_dee' } });
		expect(server.json.signedIn).toBe(true);
		await h.entitle({ identity: issuer.section, config: { ...CONNECTED, cart: { ...CONNECTED.cart, guest_merge: false } } });
		expect((await h.call('POST', `/v1/carts/${guest}/merge`, { ...ada })).status).toBe(403);
		await h.entitle({ identity: issuer.section });
	});

	it('looks items up live in the Catalog product when configured', async () => {
		await h.entitle({
			identity: issuer.section,
			config: { ...CONNECTED, cart: { catalog_url: URLS.catalog, item_source: 'catalog' } },
		});
		h.remote.on(`GET ${URLS.catalog}/v1/items/itm_live`, () => ({
			status: 200,
			body: {
				id: 'itm_live',
				title: 'Live',
				currency: 'EUR',
				variants: [{ id: 'lv', price: 4000, availability: 'in_stock' }],
			},
		}));
		h.remote.on(`GET ${URLS.catalog}/v1/items/itm_missing`, () => ({ status: 404, body: { type: 'x/not_found' } }));
		const id = await h.cartWith([{ itemId: 'itm_live', quantity: 1 }]);
		expect((await h.call('GET', `/v1/carts/${id}`, { key: h.pk })).json.subtotalAmount).toBe(4000);
		const call = h.remote.calls.find((c) => c.url.endsWith('/v1/items/itm_live'));
		expect(call?.headers.authorization).toBe('Bearer sk_live_integration_key_0123456789');
		expect(
			(await h.call('POST', `/v1/carts/${id}/lines`, { key: h.pk, body: { itemId: 'itm_missing', quantity: 1 } })).status,
		).toBe(409);
		expect((await h.call('GET', '/v1/items/itm_live')).json.source).toBe('catalog');
		await h.entitle({ identity: issuer.section });
	});

	it('refuses lines without a website currency and when the element is off', async () => {
		await h.entitle({ identity: issuer.section, website: {} });
		const created = await h.call('POST', '/v1/carts', { key: h.pk, body: {} });
		expect(created.json.currency).toBeNull();
		expect(
			(
				await h.call('POST', `/v1/carts/${created.json.id}/lines`, {
					key: h.pk,
					body: { itemId: 'itm_socks', variantId: 'm', quantity: 1 },
				})
			).json.type,
		).toMatch(/currency_not_configured$/);
		await h.entitle({ identity: issuer.section, website: { currency: 'USD' } });
		const usd = await h.call('POST', `/v1/carts/${created.json.id}/lines`, {
			key: h.pk,
			body: { itemId: 'itm_socks', variantId: 'm', quantity: 1 },
		});
		expect(usd.json.type).toMatch(/currency_mismatch$/);
		await h.entitle({ identity: issuer.section, elements: { cart: false } });
		expect((await h.call('POST', '/v1/carts', { key: h.pk, body: {} })).status).toBe(403);
		await h.entitle({ identity: issuer.section });
		expect(WEBSITE).toMatch(/^web_/);
	});
});
