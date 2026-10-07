/** Mode C taxonomy: attributes and facets, the collections tree (depth, moves, cascade, in use), brands and scoping. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness } from './harness.js';

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;

beforeAll(async () => {
	h = await createHarness({ config: { collections: { max_depth: 3 } } });
}, 60_000);

afterAll(async () => {
	await h?.close();
});

describe('taxonomy', () => {
	/** @type {Record<string, string>} */
	const ids = {};

	it('builds a collections tree with a depth limit, cascade visibility and moves', async () => {
		const root = await h.call('POST', '/v1/collections', {
			body: { title: 'Clothing', heading: 'All clothing', seo: { title: 'Clothing' } },
		});
		expect(root.status, JSON.stringify(root.json)).toBe(201);
		expect(root.json).toMatchObject({ slug: 'clothing', depth: 1, ancestors: [], breadcrumbs: [] });
		ids.root = root.json.id;
		const tops = await h.call('POST', '/v1/collections', { body: { title: 'Tops', parentId: ids.root } });
		ids.tops = tops.json.id;
		const shirts = await h.call('POST', '/v1/collections', { body: { title: 'Shirts', parentId: ids.tops } });
		ids.shirts = shirts.json.id;
		expect(shirts.json).toMatchObject({
			depth: 3,
			ancestors: [ids.root, ids.tops],
			breadcrumbs: [{ title: 'Clothing' }, { title: 'Tops' }],
		});
		const tooDeep = await h.call('POST', '/v1/collections', { body: { title: 'Linen', parentId: ids.shirts } });
		expect(tooDeep.json.errors[0].code).toBe('too_deep');
		const orphan = await h.call('POST', '/v1/collections', { body: { title: 'Orphan', parentId: 'col_nope' } });
		expect(orphan.json.errors[0].code).toBe('parent_unknown');
		const cycle = await h.call('PATCH', `/v1/collections/${ids.root}`, { body: { parentId: ids.shirts } });
		expect(cycle.json.errors[0].code).toBe('cycle');
		const sale = await h.call('POST', '/v1/collections', { body: { title: 'Sale' } });
		ids.sale = sale.json.id;
		const clearance = await h.call('POST', '/v1/collections', { body: { title: 'Clearance', parentId: ids.sale } });
		const moveTooDeep = await h.call('PATCH', `/v1/collections/${ids.tops}`, { body: { parentId: clearance.json.id } });
		expect(moveTooDeep.json.errors[0].code).toBe('too_deep');
		const moved = await h.call('PATCH', `/v1/collections/${ids.shirts}`, { body: { parentId: ids.sale } });
		expect(moved.json).toMatchObject({ depth: 2, ancestors: [ids.sale] });
		await h.call('PATCH', `/v1/collections/${ids.shirts}`, { body: { parentId: ids.tops } });
		const hidden = await h.call('PATCH', `/v1/collections/${ids.tops}`, { body: { visible: false } });
		expect(hidden.json.visible).toBe(false);
		const pub = await h.call('GET', '/v1/collections', { key: h.pk });
		expect(pub.json.items.map((/** @type {any} */ c) => c.title).sort()).toEqual(['Clearance', 'Clothing', 'Sale']);
		expect((await h.call('GET', `/v1/collections/${ids.shirts}`, { key: h.pk })).status).toBe(404);
		const tree = await h.call('GET', '/v1/collections?tree=true');
		expect(tree.json.items.find((/** @type {any} */ c) => c.title === 'Clothing').children[0].children[0].title).toBe('Shirts');
		const roots = await h.call('GET', '/v1/collections?filter[parentId]=root');
		expect(roots.json.items.map((/** @type {any} */ c) => c.title).sort()).toEqual(['Clothing', 'Sale']);
		expect((await h.call('GET', '/v1/collections?filter[parentId]=bad id')).status).toBe(422);
		await h.call('PATCH', `/v1/collections/${ids.tops}`, { body: { visible: true } });
		const bySlug = await h.call('GET', '/v1/collections/shirts', { key: h.pk });
		expect(bySlug.json.id).toBe(ids.shirts);
		const slugTaken = await h.call('PATCH', `/v1/collections/${ids.sale}`, { body: { slug: 'shirts' } });
		expect(slugTaken.json.type).toMatch(/slug_taken$/);
		expect((await h.call('POST', '/v1/collections', { body: { title: 'Shirts' } })).json.type).toMatch(/slug_taken$/);
		expect((await h.call('PATCH', '/v1/collections/col_nope', { body: { title: 'x' } })).status).toBe(404);
		expect((await h.call('POST', '/v1/collections', { body: { title: '' } })).status).toBe(422);
	});

	it('defines attributes and counts facets over public items in a collection', async () => {
		const size = await h.call('POST', '/v1/attributes', {
			body: { key: 'size', label: 'Size', options: ['S', 'M'], variantOption: true, collectionIds: [ids.root] },
		});
		expect(size.status, JSON.stringify(size.json)).toBe(201);
		expect(size.json.options).toEqual([
			{ value: 's', label: 'S', display: 'S' },
			{ value: 'm', label: 'M', display: 'M' },
		]);
		const storage = await h.call('POST', '/v1/attributes', {
			body: { key: 'storage', label: 'Storage', unit: 'GB', options: ['128', '256'] },
		});
		expect(storage.json.options[0]).toEqual({ value: '128gb', label: '128', display: '128 GB' });
		const material = await h.call('POST', '/v1/attributes', {
			body: { key: 'material', label: 'Material', type: 'text', filterable: true },
		});
		expect(material.status).toBe(201);
		expect(
			(await h.call('POST', '/v1/attributes', { body: { key: 'size', label: 'Again', options: ['X'] } })).json.type,
		).toMatch(/key_taken$/);
		expect((await h.call('POST', '/v1/attributes', { body: { key: 'Bad', label: 'x' } })).status).toBe(422);
		for (const [title, value] of [
			['Shirt S', 's'],
			['Shirt M', 'm'],
			['Shirt M2', 'm'],
		]) {
			const created = await h.call('POST', '/v1/items', {
				body: {
					title,
					status: 'active',
					collectionIds: [ids.shirts],
					options: ['size'],
					variants: [{ options: { size: value }, price: 1000 }],
					attributes: { material: 'linen', storage: '128gb' },
				},
			});
			expect(created.status, JSON.stringify(created.json)).toBe(201);
		}
		const facets = await h.call('GET', `/v1/attributes:facets?filter[collectionId]=${ids.root}`, { key: h.pk });
		const bySize = facets.json.items.find((/** @type {any} */ f) => f.key === 'size');
		expect(bySize.values).toEqual([
			{ value: 's', label: 'S', count: 1 },
			{ value: 'm', label: 'M', count: 2 },
		]);
		expect(facets.json.items.find((/** @type {any} */ f) => f.key === 'material').values).toEqual([
			{ value: 'linen', label: 'linen', count: 3 },
		]);
		const filtered = await h.call('GET', `/v1/items?filter[collectionId]=${ids.root}&filter[attr.size]=m`, { key: h.pk });
		expect(filtered.json.items).toHaveLength(2);
		const all = await h.call('GET', '/v1/attributes', { key: h.pk });
		expect(all.json.items.map((/** @type {any} */ a) => a.key).sort()).toEqual(['material', 'size', 'storage']);
		const badValue = await h.call('POST', '/v1/items', { body: { title: 'Bad attr', attributes: { storage: '512gb' } } });
		expect(badValue.json.errors[0].code).toBe('option_invalid');
		const unknown = await h.call('POST', '/v1/items', { body: { title: 'Unknown attr', attributes: { nope: 1 } } });
		expect(unknown.json.errors[0].code).toBe('attribute_unknown');
		await h.entitle({ config: { attributes: { facets: false } } });
		expect((await h.call('GET', '/v1/attributes:facets', { key: h.pk })).status).toBe(403);
		await h.entitle();
		expect((await h.call('GET', '/v1/attributes:facets?filter[collectionId]=bad id', { key: h.pk })).status).toBe(422);
	});

	it('refuses to remove what items still use', async () => {
		const attributes = (await h.call('GET', '/v1/attributes')).json.items;
		const size = attributes.find((/** @type {any} */ a) => a.key === 'size');
		const dropOption = await h.call('PATCH', `/v1/attributes/${size.id}`, { body: { options: [{ value: 's', label: 'S' }] } });
		expect(dropOption.json.type).toMatch(/in_use$/);
		const relabel = await h.call('PATCH', `/v1/attributes/${size.id}`, { body: { label: 'Size (EU)' } });
		expect(relabel.json.label).toBe('Size (EU)');
		expect((await h.call('DELETE', `/v1/attributes/${size.id}`)).json.type).toMatch(/in_use$/);
		expect((await h.call('DELETE', `/v1/collections/${ids.shirts}`)).json.type).toMatch(/in_use$/);
		expect((await h.call('DELETE', `/v1/collections/${ids.root}`)).json.type).toMatch(/in_use$/);
		const unused = await h.call('POST', '/v1/attributes', { body: { key: 'unused', label: 'Unused', options: ['A'] } });
		expect((await h.call('DELETE', `/v1/attributes/${unused.json.id}`)).json.deleted).toBe(true);
		expect((await h.call('DELETE', `/v1/attributes/${unused.json.id}`)).status).toBe(404);
		expect((await h.call('PATCH', '/v1/attributes/att_nope', { body: {} })).status).toBe(404);
		expect((await h.call('PATCH', `/v1/attributes/${size.id}`, { body: { type: 'text' } })).status).toBe(422);
		const empty = await h.call('POST', '/v1/collections', { body: { title: 'Empty' } });
		expect((await h.call('DELETE', `/v1/collections/${empty.json.id}`)).json.deleted).toBe(true);
		expect((await h.call('DELETE', `/v1/collections/${empty.json.id}`)).status).toBe(404);
	});

	it('registers brands with logos, scopes them to collections and hides invisible ones', async () => {
		const acme = await h.call('POST', '/v1/brands', {
			body: { name: 'Acme', logo: { url: 'https://cdn.example.com/acme.svg', alt: 'Acme' }, collectionIds: [ids.root] },
		});
		expect(acme.status, JSON.stringify(acme.json)).toBe(201);
		expect(acme.json).toMatchObject({
			slug: 'acme',
			logo: { url: 'https://cdn.example.com/acme.svg', alt: 'Acme' },
			visible: true,
		});
		const scoped = await h.call('POST', '/v1/items', {
			body: { title: 'Scoped', brandId: acme.json.id, collectionIds: [ids.sale] },
		});
		expect(scoped.json.errors[0].code).toBe('brand_out_of_scope');
		const inScope = await h.call('POST', '/v1/items', {
			body: { title: 'In scope', status: 'active', price: 1, brandId: acme.json.id, collectionIds: [ids.shirts] },
		});
		expect(inScope.status).toBe(201);
		expect((await h.call('GET', `/v1/items/${inScope.json.id}`, { key: h.pk })).json.brand).toMatchObject({ name: 'Acme' });
		const hidden = await h.call('POST', '/v1/brands', { body: { name: 'Hidden', visible: false } });
		const pub = await h.call('GET', '/v1/brands', { key: h.pk });
		expect(pub.json.items.map((/** @type {any} */ b) => b.name)).toEqual(['Acme']);
		expect((await h.call('GET', `/v1/brands/${hidden.json.id}`, { key: h.pk })).status).toBe(404);
		expect((await h.call('GET', '/v1/brands/acme', { key: h.pk })).json.id).toBe(acme.json.id);
		const renamed = await h.call('PATCH', `/v1/brands/${hidden.json.id}`, { body: { name: 'Shown', visible: true } });
		expect(renamed.json).toMatchObject({ name: 'Shown', visible: true });
		expect((await h.call('PATCH', `/v1/brands/${hidden.json.id}`, { body: { slug: 'acme' } })).json.type).toMatch(
			/slug_taken$/,
		);
		expect((await h.call('POST', '/v1/brands', { body: { name: 'Acme' } })).json.type).toMatch(/slug_taken$/);
		expect((await h.call('DELETE', `/v1/brands/${acme.json.id}`)).json.type).toMatch(/in_use$/);
		expect((await h.call('DELETE', `/v1/brands/${hidden.json.id}`)).json.deleted).toBe(true);
		expect((await h.call('DELETE', `/v1/brands/${hidden.json.id}`)).status).toBe(404);
		expect((await h.call('PATCH', '/v1/brands/brd_nope', { body: {} })).status).toBe(404);
		expect((await h.call('POST', '/v1/brands', { body: { name: '' } })).status).toBe(422);
		const unknownBrand = await h.call('POST', '/v1/items', { body: { title: 'No brand', brandId: 'brd_nope' } });
		expect(unknownBrand.json.errors[0].code).toBe('brand_unknown');
		await h.entitle({ config: { brands: { require_brand: true, max_brands: 1 } } });
		expect((await h.call('POST', '/v1/items', { body: { title: 'Needs brand' } })).json.errors[0].code).toBe('required');
		expect((await h.call('POST', '/v1/brands', { body: { name: 'Third' } })).json.type).toMatch(/limit_reached$/);
		await h.entitle({ config: { collections: { max_collections: 1 }, attributes: { max_attributes: 1 } } });
		expect((await h.call('POST', '/v1/collections', { body: { title: 'More' } })).json.type).toMatch(/limit_reached$/);
		expect(
			(await h.call('POST', '/v1/attributes', { body: { key: 'more', label: 'More', options: ['A'] } })).json.type,
		).toMatch(/limit_reached$/);
		await h.entitle();
	});

	it('serves the listing contract widgets use: q, page / total, facets with a price range, aliases and card fields', async () => {
		const pk = { key: h.pk };
		const search = await h.call('GET', '/v1/items?q=SHIRT%20m', pk);
		expect(search.json.items.map((/** @type {any} */ i) => i.title).sort()).toEqual(['Shirt M', 'Shirt M2']);
		expect((await h.call('GET', '/v1/items?q=nothing-like-this', pk)).json.items).toEqual([]);
		expect((await h.call('GET', `/v1/items?q=${'x'.repeat(41)}`, pk)).status).toBe(422);
		const first = await h.call('GET', `/v1/items?filter[collectionId]=${ids.root}&sort=title&limit=2&page=1`, pk);
		expect(first.json).toMatchObject({ page: 1, next: 2, total: 4, hasMore: true, nextCursor: null });
		const second = await h.call('GET', `/v1/items?filter[collectionId]=${ids.root}&sort=title&limit=2&page=2`, pk);
		expect(second.json).toMatchObject({ page: 2, next: null, total: 4, hasMore: false });
		expect(second.json.items.map((/** @type {any} */ i) => i.title)).toEqual(['Shirt M2', 'Shirt S']);
		expect((await h.call('GET', '/v1/items?page=0', pk)).status).toBe(422);
		const cursor = (await h.call('GET', '/v1/items?limit=1', pk)).json.nextCursor;
		expect((await h.call('GET', `/v1/items?page=1&cursor=${encodeURIComponent(cursor)}`, pk)).status).toBe(422);
		const bare = await h.call(
			'GET',
			`/v1/items?filter[size]=m&filter[price_min]=500&filter[price_max]=1500&include=facets,total`,
			pk,
		);
		expect(bare.json.total).toBe(2);
		expect(bare.json.facets.find((/** @type {any} */ f) => f.key === 'price')).toMatchObject({
			range: { min: 1000, max: 1000 },
		});
		expect(bare.json.facets.find((/** @type {any} */ f) => f.key === 'size').values).toEqual([
			{ value: 'm', label: 'M', count: 2 },
		]);
		const card = bare.json.items[0];
		expect(card).toMatchObject({ price: 1000, compareAtPrice: null, image: null, createdAt: expect.any(String) });
		const branded = await h.call('GET', '/v1/items?filter[brand]=acme', pk);
		expect(branded.json.items.map((/** @type {any} */ i) => i.title)).toEqual(['In scope']);
		expect((await h.call('GET', '/v1/items?filter[brand]=Bad Slug', pk)).status).toBe(422);
		const scoped = await h.call('GET', `/v1/items?filter[collectionId]=${ids.shirts}&include=facets`, pk);
		expect(scoped.json.facets.map((/** @type {any} */ f) => f.key)).toEqual(expect.arrayContaining(['size', 'price']));
	});
});
