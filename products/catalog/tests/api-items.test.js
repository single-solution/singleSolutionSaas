/** Mode C items: create / read / patch / delete, owner vs public views (cost never public), listing, publication, events. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, HOUR, WEBSITE, createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness({
		config: {
			items: {
				custom_fields: [
					{ key: 'care', label: 'Care', type: 'text', public: true },
					{ key: 'supplier', label: 'Supplier', type: 'text' },
				],
				item_types: [
					{ key: 'item', label: 'Item', kind: 'physical', requires_shipping: true },
					{ key: 'class', label: 'Class', kind: 'service', custom_fields: ['care'] },
				],
				languages: ['de'],
			},
		},
	});
}, 60_000);

afterAll(async () => {
	await h?.close();
});

describe('items', () => {
	it('creates an item with the single-variant shorthand, publishes item.created@1 without cost, and replays', async () => {
		const create = await h.call('POST', '/v1/items', {
			idempotencyKey: 'create-shirt',
			body: {
				title: 'Linen shirt',
				status: 'active',
				price: 4900,
				cost: 2100,
				quantity: 12,
				sku: 'LS-1',
				custom: { care: 'Cold wash', supplier: 'Mill A' },
			},
		});
		expect(create.status, JSON.stringify(create.json)).toBe(201);
		expect(create.json).toMatchObject({
			slug: 'linen-shirt',
			status: 'active',
			currency: 'EUR',
			priceMin: 4900,
			inStock: true,
			available: 12,
			version: 1,
		});
		expect(create.json.variants[0]).toMatchObject({ sku: 'LS-1', price: 4900, cost: 2100, quantity: 12 });
		expect(create.headers.get('location')).toBe(`/v1/items/${create.json.id}`);
		const replay = await h.call('POST', '/v1/items', {
			idempotencyKey: 'create-shirt',
			body: {
				title: 'Linen shirt',
				status: 'active',
				price: 4900,
				cost: 2100,
				quantity: 12,
				sku: 'LS-1',
				custom: { care: 'Cold wash', supplier: 'Mill A' },
			},
		});
		expect(replay.status).toBe(201);
		expect(replay.json.id).toBe(create.json.id);
		const [event] = h.published('item.created@1');
		expect(event.data).toMatchObject({ itemId: create.json.id, title: 'Linen shirt', status: 'active', currency: 'EUR' });
		expect(event.data.variants[0]).toMatchObject({ sku: 'LS-1', price: 4900, inventory: 12 });
		expect(JSON.stringify(event.data)).not.toContain('2100');
		const stored = await h.collection('items').findOne({ websiteId: WEBSITE, id: create.json.id });
		expect(stored?.outbox ?? []).toEqual([]);
		expect(stored).toMatchObject({ merchantId: expect.any(String), env: 'live' });
	});

	it('serves public views to pk_ keys: no cost, no private custom fields, public cache headers', async () => {
		const list = await h.call('GET', '/v1/items', { key: h.pk });
		expect(list.status).toBe(200);
		expect(list.headers.get('cache-control')).toMatch(/^public, max-age=60/);
		const [item] = list.json.items;
		expect(item).toMatchObject({
			slug: 'linen-shirt',
			kind: 'physical',
			requiresShipping: true,
			custom: { care: 'Cold wash' },
		});
		expect(item.custom.supplier).toBeUndefined();
		expect(JSON.stringify(list.json)).not.toContain('"cost"');
		expect(item.variants[0]).toEqual(expect.objectContaining({ availability: 'in_stock', purchasable: true }));
		expect(item.variants[0].quantity).toBeUndefined();
		const one = await h.call('GET', `/v1/items/${item.slug}`, { key: h.pk });
		expect(one.json.id).toBe(item.id);
		const owner = await h.call('GET', `/v1/items/${item.id}`);
		expect(owner.headers.get('cache-control')).toBe('no-store');
		expect(owner.json.custom.supplier).toBe('Mill A');
		const pkWrite = await h.call('POST', '/v1/items', { key: h.pk, body: { title: 'Nope' } });
		expect(pkWrite.status).toBe(403);
	});

	it('validates input with field problems and refuses unknown fields', async () => {
		const bad = await h.call('POST', '/v1/items', {
			body: { title: '', type: 'nope', price: -1, custom: { nope: 1 }, junk: true },
		});
		expect(bad.status).toBe(422);
		expect(bad.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/junk']);
		const fields = await h.call('POST', '/v1/items', { body: { title: '', type: 'nope', price: -1, custom: { nope: 1 } } });
		expect(fields.json.errors.map((/** @type {any} */ e) => e.code)).toEqual(
			expect.arrayContaining(['required', 'type_unknown', 'field_unknown']),
		);
		const both = await h.call('POST', '/v1/items', { body: { title: 'X', price: 1, variants: [] } });
		expect(both.json.errors[0].code).toBe('variants_or_price');
		const taken = await h.call('POST', '/v1/items', { body: { title: 'Other', slug: 'linen-shirt' } });
		expect(taken.status).toBe(409);
		expect(taken.json.type).toMatch(/slug_taken$/);
		const sku = await h.call('POST', '/v1/items', { body: { title: 'Dup', price: 1, sku: 'LS-1' } });
		expect(sku.json.errors[0].code).toBe('sku_taken');
		const auto = await h.call('POST', '/v1/items', { body: { title: 'Linen shirt' } });
		expect(auto.json.slug).toBe('linen-shirt-2');
		expect(auto.json.variants).toEqual([]);
	});

	it('patches item fields (JSON Merge Patch), keeps old slugs, honours If-Match and publishes item.updated@1', async () => {
		const list = await h.call('GET', '/v1/items?filter[slug]=linen-shirt');
		const item = list.json.items[0];
		const patched = await h.call('PATCH', `/v1/items/${item.id}`, {
			body: { slug: 'linen-summer-shirt', tags: ['summer'], summary: 'Light', translations: { de: { title: 'Leinenhemd' } } },
		});
		expect(patched.status, JSON.stringify(patched.json)).toBe(200);
		expect(patched.json).toMatchObject({ slug: 'linen-summer-shirt', previousSlugs: ['linen-shirt'], version: 2 });
		const updated = h.published('item.updated@1').at(-1);
		expect(updated.data.changed).toEqual(expect.arrayContaining(['slug', 'tags', 'summary', 'translations']));
		const old = await h.call('GET', '/v1/items/linen-shirt', { key: h.pk });
		expect(old.json).toMatchObject({ slug: 'linen-summer-shirt', redirectFrom: 'linen-shirt' });
		const german = await h.call('GET', '/v1/items/linen-summer-shirt?lang=de', { key: h.pk });
		expect(german.json).toMatchObject({ title: 'Leinenhemd', lang: 'de' });
		const stale = await h.call('PATCH', `/v1/items/${item.id}`, { headers: { 'if-match': '"1"' }, body: { summary: 'x' } });
		expect(stale.status).toBe(412);
		const same = await h.call('PATCH', `/v1/items/${item.id}`, { body: { summary: 'Light' } });
		expect(same.json.version).toBe(2);
		const sub = await h.call('PATCH', `/v1/items/${item.id}`, { body: { price: 1 } });
		expect(sub.json.errors[0].code).toBe('use_sub_resource');
		const missing = await h.call('PATCH', '/v1/items/itm_missing', { body: { title: 'x' } });
		expect(missing.status).toBe(404);
		expect((await h.call('PATCH', `/v1/items/${item.id}`, { body: [] })).status).toBe(422);
	});

	it('lists with filters, sorts and disjoint cursor pages', async () => {
		for (const [title, price] of [
			['Alpha', 100],
			['Beta', 300],
			['Gamma', 200],
		])
			await h.call('POST', '/v1/items', { body: { title, price, status: 'active', tags: ['bulk'] } });
		const cheap = await h.call('GET', '/v1/items?filter[tag]=bulk&sort=price_asc', { key: h.pk });
		expect(cheap.json.items.map((/** @type {any} */ i) => i.title)).toEqual(['Alpha', 'Gamma', 'Beta']);
		const dear = await h.call('GET', '/v1/items?filter[tag]=bulk&sort=price_desc&filter[priceMax]=250');
		expect(dear.json.items.map((/** @type {any} */ i) => i.title)).toEqual(['Gamma', 'Alpha']);
		const byTitle = await h.call('GET', '/v1/items?filter[tag]=bulk&sort=title&limit=2');
		expect(byTitle.json.items.map((/** @type {any} */ i) => i.title)).toEqual(['Alpha', 'Beta']);
		expect(byTitle.headers.get('link')).toContain('rel="next"');
		const next = await h.call(
			'GET',
			`/v1/items?filter[tag]=bulk&sort=title&limit=2&cursor=${encodeURIComponent(byTitle.json.nextCursor)}`,
		);
		expect(next.json.items.map((/** @type {any} */ i) => i.title)).toEqual(['Gamma']);
		const wrongCursor = await h.call('GET', `/v1/items?sort=price_asc&cursor=${encodeURIComponent(byTitle.json.nextCursor)}`);
		expect(wrongCursor.status).toBe(400);
		for (const sort of ['newest', 'oldest', 'updated']) {
			const first = await h.call('GET', `/v1/items?sort=${sort}&limit=1`);
			const second = await h.call('GET', `/v1/items?sort=${sort}&limit=1&cursor=${encodeURIComponent(first.json.nextCursor)}`);
			expect(second.json.items[0].id).not.toBe(first.json.items[0].id);
		}
		const statuses = await h.call('GET', '/v1/items?filter[status]=draft');
		expect(statuses.json.items.every((/** @type {any} */ i) => i.status === 'draft')).toBe(true);
		expect((await h.call('GET', '/v1/items?filter[status]=draft', { key: h.pk })).status).toBe(422);
		expect((await h.call('GET', '/v1/items?sort=bogus')).status).toBe(422);
		const inStock = await h.call('GET', '/v1/items?filter[inStock]=false');
		expect(inStock.json.items.every((/** @type {any} */ i) => i.inStock === false)).toBe(true);
		const bySku = await h.call('GET', '/v1/items?filter[sku]=LS-1&filter[type]=item');
		expect(bySku.json.items).toHaveLength(1);
		expect((await h.call('GET', '/v1/items/!!bad')).status).toBe(404);
	});

	it('hides drafts and items outside their publication window from pk_, and the sweep publishes visibility changes', async () => {
		const at = new Date(h.clock.now() + 2 * HOUR).toISOString();
		const until = new Date(h.clock.now() + DAY).toISOString();
		const scheduled = await h.call('POST', '/v1/items', {
			body: { title: 'Launch', status: 'active', price: 10, publishAt: at, unpublishAt: until },
		});
		expect(scheduled.status).toBe(201);
		expect((await h.call('GET', '/v1/items/launch', { key: h.pk })).status).toBe(404);
		const draft = await h.call('POST', '/v1/items', { body: { title: 'Secret', price: 10 } });
		expect((await h.call('GET', `/v1/items/${draft.json.id}`, { key: h.pk })).status).toBe(404);
		h.clock.advance(3 * HOUR);
		expect((await h.call('GET', '/v1/items/launch', { key: h.pk })).status).toBe(200);
		const unauthorized = await h.call('GET', '/cron/sweep', { key: null });
		expect(unauthorized.status).toBe(401);
		const sweep = await h.call('GET', '/cron/sweep', {
			key: null,
			headers: { authorization: 'Bearer cron-secret-0123456789abcdef' },
		});
		expect(sweep.status).toBe(200);
		expect(sweep.json.results[0]).toMatchObject({ websiteId: WEBSITE, transitions: 1 });
		const event = h.published('item.updated@1').at(-1);
		expect(event.data).toMatchObject({ itemId: scheduled.json.id, changed: ['published'] });
		const bad = await h.call('POST', '/v1/items', { body: { title: 'Bad window', publishAt: until, unpublishAt: at } });
		expect(bad.json.errors[0].code).toBe('before_publish');
	});

	it('soft-deletes with item.deleted@1 and lists deleted items for owners only', async () => {
		const created = await h.call('POST', '/v1/items', { body: { title: 'Gone soon', price: 5, status: 'active' } });
		const removed = await h.call('DELETE', `/v1/items/${created.json.id}`);
		expect(removed.json).toEqual({ id: created.json.id, deleted: true });
		expect(h.published('item.deleted@1').at(-1).data).toEqual({ itemId: created.json.id, reason: 'deleted' });
		expect((await h.call('DELETE', `/v1/items/${created.json.id}`)).status).toBe(200);
		expect((await h.call('GET', `/v1/items/${created.json.id}`, { key: h.pk })).status).toBe(404);
		const deleted = await h.call('GET', '/v1/items?filter[deleted]=true');
		expect(deleted.json.items.map((/** @type {any} */ i) => i.id)).toContain(created.json.id);
		expect((await h.call('GET', '/v1/items?filter[deleted]=true', { key: h.pk })).status).toBe(422);
		expect((await h.call('PATCH', `/v1/items/${created.json.id}`, { body: { title: 'x' } })).status).toBe(404);
	});

	it('describes the item model (item-schema) per key kind', async () => {
		const pub = await h.call('GET', '/v1/item-schema', { key: h.pk });
		expect(pub.json).toMatchObject({ currency: 'EUR', languages: ['de'], customFields: [{ key: 'care' }] });
		expect(pub.json.statuses).toEqual([{ key: 'active', label: 'Active' }]);
		const owner = await h.call('GET', '/v1/item-schema');
		expect(owner.json.customFields).toHaveLength(2);
		expect(owner.json.defaultStatus).toBe('draft');
	});

	it('gates sk_ keys by the api element, writes by api.allow_writes, cost by api.expose_cost; meters requests', async () => {
		const before = (await h.catalog.product.usage.stats()).pending;
		await h.call('GET', '/v1/items');
		expect((await h.catalog.product.usage.stats()).pending).toBe(before + 1);
		await h.entitle({ config: { api: { allow_writes: false, expose_cost: false } } });
		const write = await h.call('POST', '/v1/items', { body: { title: 'Blocked' } });
		expect(write.status).toBe(403);
		expect(write.json.type).toMatch(/writes_disabled$/);
		const read = await h.call('GET', '/v1/items?filter[sku]=LS-1');
		expect(read.json.items[0].variants[0].cost).toBeUndefined();
		await h.entitle({ elements: { api: false } });
		expect((await h.call('GET', '/v1/items')).json.type).toMatch(/element_disabled$/);
		expect((await h.call('GET', '/v1/items', { key: h.pk })).status).toBe(200);
		await h.entitle({ config: { items: { max_items: 1 } } });
		const limited = await h.call('POST', '/v1/items', { body: { title: 'Over the limit' } });
		expect(limited.status).toBe(409);
		expect(limited.json.type).toMatch(/limit_reached$/);
		await h.entitle({ elements: { items: false } });
		expect((await h.call('GET', '/v1/items', { key: h.pk })).status).toBe(403);
		await h.entitle();
	});
});
