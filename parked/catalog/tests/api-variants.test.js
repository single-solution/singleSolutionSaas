/** Mode C variants and stock: dimensions, pools, uniqueness, price/stock events, reservations and order events. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@ss/contracts';
import { HOUR, WEBSITE, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** @type {string} */
let itemId;

beforeAll(async () => {
	h = await createHarness({ config: { variants: { low_stock_threshold: 2, show_quantity: true } } });
	for (const body of [
		{ key: 'size', label: 'Size', type: 'select', options: ['S', 'M', 'L'], variantOption: true },
		{ key: 'color', label: 'Color', type: 'select', options: [{ value: 'navy', label: 'Navy' }, 'Red'], variantOption: true },
	])
		expect((await h.call('POST', '/v1/attributes', { body })).status).toBe(201);
	const created = await h.call('POST', '/v1/items', {
		body: {
			title: 'Polo',
			status: 'active',
			options: ['size', 'color'],
			optionPool: { size: ['s', 'm'] },
			variants: [
				{ sku: 'P-S-N', options: { size: 's', color: 'navy' }, price: 2000, cost: 900, quantity: 3 },
				{ sku: 'P-M-N', options: { size: 'm', color: 'navy' }, price: 2200, compareAtPrice: 2500, quantity: 0 },
			],
		},
	});
	expect(created.status, JSON.stringify(created.json)).toBe(201);
	itemId = created.json.id;
}, 60_000);

afterAll(async () => {
	await h?.close();
});

describe('variants', () => {
	it('lists variants per item for both key kinds (public: availability and quantity as configured)', async () => {
		const pub = await h.call('GET', `/v1/variants?filter[itemId]=${itemId}`, { key: h.pk });
		expect(pub.json.items.map((/** @type {any} */ v) => [v.sku, v.availability, v.quantity])).toEqual([
			['P-S-N', 'in_stock', 3],
			['P-M-N', 'sold_out', 0],
		]);
		expect(JSON.stringify(pub.json)).not.toContain('900');
		const bySku = await h.call('GET', '/v1/variants?filter[sku]=P-S-N');
		expect(bySku.json.items).toHaveLength(1);
		expect(bySku.json.items[0]).toMatchObject({ cost: 900, itemId });
		const all = await h.call('GET', '/v1/variants?limit=5', { key: h.pk });
		expect(all.json.items.length).toBeGreaterThan(0);
		expect((await h.call('GET', '/v1/variants?filter[itemId]=bad id')).json.items).toEqual([]);
		const item = await h.call('GET', `/v1/items/${itemId}`, { key: h.pk });
		expect(item.json.options).toEqual([
			{
				key: 'size',
				label: 'Size',
				values: [
					{ value: 's', label: 'S' },
					{ value: 'm', label: 'M' },
				],
			},
			{ key: 'color', label: 'Color', values: [{ value: 'navy', label: 'Navy' }] },
		]);
	});

	it('enforces dimensions, pools, option uniqueness and SKU uniqueness', async () => {
		const outside = await h.call('POST', '/v1/variants', {
			body: { itemId, sku: 'P-L-N', options: { size: 'l', color: 'navy' }, price: 2400 },
		});
		expect(outside.json.errors.map((/** @type {any} */ e) => e.code)).toContain('not_in_pool');
		const duplicate = await h.call('POST', '/v1/variants', {
			body: { itemId, options: { size: 's', color: 'navy' }, price: 1 },
		});
		expect(duplicate.json.errors.map((/** @type {any} */ e) => e.code)).toContain('duplicate_options');
		const missing = await h.call('POST', '/v1/variants', { body: { itemId, options: { size: 's' }, price: 1 } });
		expect(missing.json.errors.map((/** @type {any} */ e) => e.code)).toContain('required');
		const sku = await h.call('POST', '/v1/items', { body: { title: 'Other', price: 1, sku: 'P-S-N' } });
		expect(sku.json.errors[0].code).toBe('sku_taken');
		expect((await h.call('POST', '/v1/variants', { body: { options: {} } })).json.errors[0].path).toBe('/itemId');
		expect((await h.call('POST', '/v1/variants', { body: { itemId: 'itm_nope', price: 1 } })).status).toBe(404);
		const added = await h.call('POST', '/v1/variants', {
			body: { itemId, sku: 'P-S-R', options: { size: 's', color: 'red' }, price: 2000, quantity: 4 },
		});
		expect(added.status, JSON.stringify(added.json)).toBe(201);
		expect(added.json).toMatchObject({ sku: 'P-S-R', quantity: 4, itemId });
		const inventory = h.published('inventory.changed@1').at(-1);
		expect(inventory.data).toMatchObject({
			itemId,
			variantId: added.json.id,
			quantity: 4,
			previousQuantity: 0,
			reason: 'created',
		});
		const pools = await h.call('PATCH', `/v1/items/${itemId}`, { body: { optionPool: { size: ['m'] } } });
		expect(pools.json.errors.map((/** @type {any} */ e) => e.code)).toContain('not_in_pool');
		const dims = await h.call('PATCH', `/v1/items/${itemId}`, { body: { options: ['nope'] } });
		expect(dims.json.errors[0].code).toBe('not_a_variant_option');
	});

	it('patches prices and stock with price.changed@1 and inventory.changed@1, and deletes variants', async () => {
		const list = await h.call('GET', `/v1/variants?filter[itemId]=${itemId}`);
		const medium = list.json.items.find((/** @type {any} */ v) => v.sku === 'P-M-N');
		const patched = await h.call('PATCH', `/v1/variants/${medium.id}`, { body: { price: 2100, quantity: 6 } });
		expect(patched.status, JSON.stringify(patched.json)).toBe(200);
		expect(patched.json).toMatchObject({ price: 2100, quantity: 6, restockedAt: expect.any(String) });
		expect(h.published('price.changed@1').at(-1).data).toEqual({
			itemId,
			variantId: medium.id,
			sku: 'P-M-N',
			price: { amount: 2100, currency: 'EUR' },
			previousPrice: { amount: 2200, currency: 'EUR' },
			compareAtPrice: { amount: 2500, currency: 'EUR' },
			previousCompareAtPrice: { amount: 2500, currency: 'EUR' },
			reason: 'updated',
		});
		expect(h.published('inventory.changed@1').at(-1).data).toMatchObject({
			variantId: medium.id,
			quantity: 6,
			previousQuantity: 0,
		});
		expect((await h.call('PATCH', `/v1/variants/${medium.id}`, { body: { price: 2100 } })).json.price).toBe(2100);
		expect((await h.call('PATCH', `/v1/variants/${medium.id}`, { body: { price: -5 } })).status).toBe(422);
		expect((await h.call('PATCH', '/v1/variants/var_nope', { body: { price: 1 } })).status).toBe(404);
		const red = list.json.items.find((/** @type {any} */ v) => v.sku === 'P-S-R');
		expect((await h.call('DELETE', `/v1/variants/${red.id}`)).json.deleted).toBe(true);
		const item = await h.call('GET', `/v1/items/${itemId}`);
		expect(item.json.variants.map((/** @type {any} */ v) => v.sku)).toEqual(['P-S-N', 'P-M-N']);
		expect(item.json).toMatchObject({ priceMin: 2000, priceMax: 2100, available: 9 });
	});

	it('adjusts stock by delta or to a quantity, guarded by expectedQuantity', async () => {
		const item = await h.call('GET', `/v1/items/${itemId}`);
		const small = item.json.variants[0];
		const down = await h.call('POST', `/v1/variants/${small.id}/stock`, { body: { delta: -1, reason: 'damaged' } });
		expect(down.json.quantity).toBe(2);
		expect(down.json.lowStock).toBe(true);
		expect(h.published('inventory.changed@1').at(-1).data).toMatchObject({
			quantity: 2,
			previousQuantity: 3,
			reason: 'damaged',
		});
		const set = await h.call('POST', `/v1/variants/${small.id}/stock`, { body: { quantity: 10, expectedQuantity: 2 } });
		expect(set.json.quantity).toBe(10);
		const stale = await h.call('POST', `/v1/variants/${small.id}/stock`, { body: { quantity: 1, expectedQuantity: 2 } });
		expect(stale.status).toBe(412);
		expect((await h.call('POST', `/v1/variants/${small.id}/stock`, { body: { delta: 1, quantity: 1 } })).status).toBe(422);
		expect((await h.call('POST', `/v1/variants/${small.id}/stock`, { body: { delta: 1.5 } })).status).toBe(422);
		expect((await h.call('POST', `/v1/variants/${small.id}/stock`, { body: { delta: 1, reason: 'Bad Reason' } })).status).toBe(
			422,
		);
		expect((await h.call('POST', '/v1/variants/var_nope/stock', { body: { delta: 1 } })).status).toBe(404);
		expect((await h.call('POST', `/v1/variants/${small.id}/stock`, { body: [] })).status).toBe(422);
	});

	it('reserves stock atomically (all lines or none), releases and expires reservations', async () => {
		const item = await h.call('GET', `/v1/items/${itemId}`);
		const [small, medium] = item.json.variants;
		const tooMuch = await h.call('POST', '/v1/stock-reservations', {
			body: {
				lines: [
					{ variantId: small.id, quantity: 1 },
					{ sku: 'P-M-N', quantity: 999 },
				],
			},
		});
		expect(tooMuch.status).toBe(409);
		expect(tooMuch.json.type).toMatch(/insufficient_stock$/);
		expect((await h.call('GET', `/v1/items/${itemId}`)).json.variants[0].quantity).toBe(small.quantity);
		const held = await h.call('POST', '/v1/stock-reservations', {
			idempotencyKey: 'res-1',
			body: {
				lines: [
					{ variantId: small.id, quantity: 2 },
					{ sku: 'P-M-N', quantity: 1 },
				],
				orderId: 'ord_100',
			},
		});
		expect(held.status, JSON.stringify(held.json)).toBe(201);
		expect(held.json).toMatchObject({ status: 'held', orderId: 'ord_100', lines: [{ quantity: 2 }, { quantity: 1 }] });
		const replay = await h.call('POST', '/v1/stock-reservations', {
			idempotencyKey: 'res-1',
			body: {
				lines: [
					{ variantId: small.id, quantity: 2 },
					{ sku: 'P-M-N', quantity: 1 },
				],
				orderId: 'ord_100',
			},
		});
		expect(replay.status).toBe(409);
		expect(replay.json.type).toMatch(/duplicate_request$/);
		const after = await h.call('GET', `/v1/items/${itemId}`);
		expect(after.json.variants.map((/** @type {any} */ v) => v.quantity)).toEqual([small.quantity - 2, medium.quantity - 1]);
		expect((await h.call('GET', `/v1/stock-reservations/${held.json.id}`)).json.status).toBe('held');
		expect((await h.call('GET', `/v1/stock-reservations/${held.json.id}`, { key: h.pk })).status).toBe(403);
		expect((await h.call('GET', '/v1/stock-reservations/res_nope')).status).toBe(404);
		const sameOrder = await h.call('POST', '/v1/stock-reservations', {
			body: { lines: [{ variantId: small.id, quantity: 1 }], orderId: 'ord_100' },
		});
		expect(sameOrder.status).toBe(409);
		const released = await h.call('DELETE', `/v1/stock-reservations/${held.json.id}`);
		expect(released.json.status).toBe('released');
		expect((await h.call('DELETE', `/v1/stock-reservations/${held.json.id}`)).json.status).toBe('released');
		expect((await h.call('GET', `/v1/items/${itemId}`)).json.variants.map((/** @type {any} */ v) => v.quantity)).toEqual([
			small.quantity,
			medium.quantity,
		]);
		const expiring = await h.call('POST', '/v1/stock-reservations', {
			body: { lines: [{ variantId: small.id, quantity: 1 }] },
		});
		h.clock.advance(HOUR);
		const due = await h.call('POST', '/v1/dashboard/due-work', { key: await h.session('merchant'), idempotencyKey: null });
		expect(due.status, JSON.stringify(due.json)).toBe(200);
		expect(due.json.expiredReservations).toBe(1);
		expect((await h.call('GET', `/v1/stock-reservations/${expiring.json.id}`)).json.status).toBe('expired');
		const unknown = await h.call('POST', '/v1/stock-reservations', { body: { lines: [{ sku: 'NOPE', quantity: 1 }] } });
		expect(unknown.json.errors[0].code).toBe('variant_unknown');
		expect((await h.call('POST', '/v1/stock-reservations', { body: { lines: [] } })).status).toBe(422);
		expect(
			(await h.call('POST', '/v1/stock-reservations', { body: { lines: [{ sku: 'P-S-N', quantity: 1 }], orderId: 'bad id' } }))
				.status,
		).toBe(422);
	});

	it('takes stock on order.placed@1 once, converts reservations, gives it back on cancel and refund', async () => {
		const item = await h.call('GET', `/v1/items/${itemId}`);
		const small = item.json.variants[0];
		const start = small.quantity;
		const orderId = createId('ord');
		const placed = {
			orderId,
			currency: 'EUR',
			lines: [{ itemId, variantId: small.id, quantity: 2, unitAmount: 2000 }],
			amounts: { subtotal: 4000, total: 4000 },
		};
		const first = await h.deliver('order.placed@1', placed);
		expect(first.status).toBe(200);
		await h.deliver('order.placed@1', placed);
		const quantity = async () => (await h.call('GET', `/v1/items/${itemId}`)).json.variants[0].quantity;
		expect(await quantity()).toBe(start - 2);
		expect(h.published('inventory.changed@1').at(-1).data).toMatchObject({
			variantId: small.id,
			quantity: start - 2,
			reason: 'order',
		});
		await h.entitle({ config: { variants: { restock_on_refund: true } } });
		await h.deliver('order.refunded@1', {
			orderId,
			amount: { amount: 2000, currency: 'EUR' },
			lines: [{ itemId, variantId: small.id, quantity: 1 }],
		});
		expect(await quantity()).toBe(start - 1);
		await h.deliver('order.cancelled@1', { orderId });
		expect(await quantity()).toBe(start + 1);
		await h.deliver('order.cancelled@1', { orderId }, { id: createId('evt') });
		expect(await quantity()).toBe(start + 1);
		const reserved = await h.call('POST', '/v1/stock-reservations', {
			body: { lines: [{ sku: 'P-S-N', quantity: 1 }], orderId: 'ord_200' },
		});
		await h.deliver('order.placed@1', { ...placed, orderId: 'ord_200' });
		expect(await quantity()).toBe(start);
		expect((await h.call('GET', `/v1/stock-reservations/${reserved.json.id}`)).json.status).toBe('converted');
		await h.deliver('order.placed@1', {
			orderId: 'ord_unknown',
			currency: 'EUR',
			lines: [{ itemId: 'itm_x', quantity: 1, unitAmount: 1 }],
			amounts: { subtotal: 1, total: 1 },
		});
		await h.entitle({ config: { variants: { decrement_on_order: false, restock_on_cancel: false } } });
		await h.deliver('order.placed@1', { ...placed, orderId: 'ord_300' });
		await h.deliver('order.cancelled@1', { orderId: 'ord_200' });
		expect(await quantity()).toBe(start);
		await h.entitle({ elements: { variants: false } });
		await h.deliver('order.placed@1', { ...placed, orderId: 'ord_400' });
		await h.entitle();
		expect(await quantity()).toBe(start);
		const moves = await h.collection('stock_moves').countDocuments({ websiteId: WEBSITE });
		expect(moves).toBeGreaterThanOrEqual(3);
	});
});
