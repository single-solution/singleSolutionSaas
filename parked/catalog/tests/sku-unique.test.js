/** Catalog-wide SKU uniqueness is race-free: a unique partial index on `skuKeys` backs the check before the write. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS, duplicateSkuOf } from '../adapters/db.js';
import { skuTaken } from '../api/catalog.js';
import { skuKey, skuKeysOf } from '../core/variants.js';
import { WEBSITE, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness();
}, 60_000);

afterAll(async () => {
	await h?.close();
});

/** @param {string} title @param {string} sku */
const create = (title, sku) => h.call('POST', '/v1/items', { body: { title, price: 100, sku } });

describe('SKU uniqueness across the catalog', () => {
	it('lets exactly one of two concurrent creates with the same SKU succeed', async () => {
		for (const round of [1, 2, 3]) {
			const sku = `RACE-${round}`;
			const results = await Promise.all([create(`Race ${round} a`, sku), create(`Race ${round} b`, ` ${sku} `)]);
			const statuses = results.map((r) => r.status).sort();
			expect(statuses).toEqual([201, 422]);
			const loser = results.find((r) => r.status === 422);
			expect(loser?.json.errors).toEqual([expect.objectContaining({ path: '/variants/0/sku', code: 'sku_taken' })]);
			expect(await h.collection('items').countDocuments({ websiteId: WEBSITE, skuKeys: sku })).toBe(1);
		}
		const winner = await create('Plain', 'PLAIN-1');
		expect(winner.json).not.toHaveProperty('skuKeys');
		expect((await h.collection('items').findOne({ websiteId: WEBSITE, id: winner.json.id }))?.skuKeys).toEqual(['PLAIN-1']);
	});

	it('lets exactly one of two concurrent variant changes claim an SKU, and frees the SKUs of deleted items', async () => {
		const a = (await create('Variant A', 'VA-1')).json;
		const b = (await create('Variant B', 'VB-1')).json;
		const [first, second] = await Promise.all([
			h.call('PATCH', `/v1/variants/${a.variants[0].id}`, { body: { sku: 'SHARED-1' } }),
			h.call('PATCH', `/v1/variants/${b.variants[0].id}`, { body: { sku: 'SHARED-1' } }),
		]);
		expect([first.status, second.status].sort()).toEqual([200, 422]);
		expect([first, second].find((r) => r.status === 422)?.json.errors[0].code).toBe('sku_taken');
		expect(await h.collection('items').countDocuments({ websiteId: WEBSITE, skuKeys: 'SHARED-1' })).toBe(1);

		const holder = first.status === 200 ? a : b;
		expect((await h.call('DELETE', `/v1/items/${holder.id}`)).status).toBeLessThan(300);
		expect((await h.collection('items').findOne({ websiteId: WEBSITE, id: holder.id }))?.skuKeys).toBeNull();
		expect((await create('After delete', 'SHARED-1')).status).toBe(201);
	});

	it('refuses an SKU held in the index even when the check before the write misses it', async () => {
		// a reservation the variant-SKU lookup cannot see (e.g. the other write has not landed its variants yet)
		await h
			.collection('items')
			.insertOne({ websiteId: WEBSITE, id: 'itm_holder', slug: 'holder', skuKeys: ['IDX-1'], variants: [] });
		const refused = await create('Index only', 'IDX-1');
		expect(refused.status).toBe(422);
		expect(refused.json.errors).toEqual([expect.objectContaining({ path: '/variants/0/sku', code: 'sku_taken' })]);
		const item = (await create('Index patch', 'IDX-2')).json;
		const patched = await h.call('PATCH', `/v1/variants/${item.variants[0].id}`, { body: { sku: 'IDX-1' } });
		expect(patched.status).toBe(422);
		expect(patched.json.errors[0]).toMatchObject({ path: '/variants/0/sku', code: 'sku_taken' });
		await h.collection('items').deleteOne({ websiteId: WEBSITE, id: 'itm_holder' });
	});

	it('does not reserve SKUs while the setting is off', async () => {
		await h.entitle({ config: { variants: { unique_sku_across_items: false } } });
		const results = await Promise.all([create('Off a', 'OFF-1'), create('Off b', 'OFF-1')]);
		expect(results.map((r) => r.status)).toEqual([201, 201]);
		expect(await h.collection('items').countDocuments({ websiteId: WEBSITE, 'variants.sku': 'OFF-1', skuKeys: null })).toBe(2);
		await h.entitle();
		// turned back on: the next write of either item meets the check (another live item holds the SKU)
		const again = await h.call('PATCH', `/v1/items/${results[0].json.id}`, { body: { title: 'Off a again' } });
		expect(again.status).toBe(200);
		expect((await create('On again', 'OFF-1')).json.errors[0].code).toBe('sku_taken');
	});

	it('reserves the SKUs of items written before the index (lazy migration), skipping SKUs already held', async () => {
		const items = h.collection('items');
		await items.insertMany([
			{
				websiteId: WEBSITE,
				id: 'itm_legacy_1',
				slug: 'legacy-1',
				deletedAt: null,
				variants: [{ sku: 'LEG-1' }, { sku: 'LEG-2' }],
			},
			{ websiteId: WEBSITE, id: 'itm_legacy_2', slug: 'legacy-2', deletedAt: null, variants: [{ sku: 'LEG-1' }] },
			{ websiteId: WEBSITE, id: 'itm_legacy_3', slug: 'legacy-3', deletedAt: null, variants: [{ sku: '   ' }] },
		]);
		const migration = MIGRATIONS.find((step) => step.name === 'sku_keys');
		await migration?.up({ websiteId: WEBSITE, collection: (/** @type {string} */ name) => h.collection(name) });
		expect((await items.findOne({ id: 'itm_legacy_1' }))?.skuKeys).toEqual(['LEG-1', 'LEG-2']);
		expect(await items.findOne({ id: 'itm_legacy_2' })).not.toHaveProperty('skuKeys');
		expect((await items.findOne({ id: 'itm_legacy_3' }))?.skuKeys).toBeNull();
		await items.deleteMany({ websiteId: WEBSITE, id: { $in: ['itm_legacy_1', 'itm_legacy_2', 'itm_legacy_3'] } });
	});

	it('normalises SKUs and maps only SKU index errors', () => {
		expect(skuKey(' Á ')).toBe('Á');
		expect(skuKeysOf([{ sku: 'b' }, { sku: 'a' }, { sku: ' a' }, { sku: null }, {}])).toEqual(['a', 'b']);
		const error = { code: 11000, keyPattern: { websiteId: 1, skuKeys: 1 }, keyValue: { websiteId: 'w', skuKeys: 'b' } };
		expect(duplicateSkuOf(error)).toBe('b');
		expect(duplicateSkuOf({ code: 11000, message: 'E11000 index: website_sku_unique dup key' })).toBe('');
		expect(duplicateSkuOf({ code: 11000, keyPattern: { websiteId: 1, slug: 1 } })).toBeNull();
		expect(duplicateSkuOf(new Error('x'))).toBeNull();
		expect(skuTaken(error, { variants: [{ sku: 'a' }, { sku: 'b' }] })).toMatchObject({
			reason: 'validation_failed',
			errors: [{ path: '/variants/1/sku', code: 'sku_taken' }],
		});
		expect(skuTaken({ code: 11000, message: 'website_sku_unique' }, {})).toMatchObject({
			errors: [{ path: '/variants', code: 'sku_taken' }],
		});
		expect(skuTaken(new Error('x'), {})).toBeNull();
	});
});
