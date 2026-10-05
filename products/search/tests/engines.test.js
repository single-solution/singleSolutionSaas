/**
 * The same search suite against both engines, through the real HTTP API: the portable engine on the in-memory
 * MongoDB, and Atlas Search through the simulator (the product's real `$search` pipelines evaluated in memory).
 * Both must return the same response shape and the expected documents.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAtlasRunner, readyProbe } from './atlas-sim.js';
import { createHarness } from './harness.js';

const TYPES = [
	{
		key: 'item',
		label: 'Item',
		fields: [
			{ key: 'title', searchable: true, prefix: true, display: true },
			{ key: 'brand', searchable: true, prefix: true, display: true },
			{ key: 'description', searchable: true, display: true },
			{ key: 'supplier', searchable: true, private: true },
		],
	},
	{
		key: 'article',
		label: 'Article',
		fields: [
			{ key: 'title', searchable: true, prefix: true, display: true },
			{ key: 'body', searchable: true },
		],
	},
];

const DOCS = [
	{
		id: 'shirt',
		type: 'item',
		url: '/i/shirt',
		price: 4900,
		currency: 'EUR',
		fields: { title: 'Linen shirt', brand: 'Acme', description: 'Light summer shirt', supplier: 'Zebracorp' },
	},
	{
		id: 'sweater',
		type: 'item',
		url: '/i/sweater',
		fields: { title: 'Wool sweater', brand: 'Northwind', description: 'Warm winter knit' },
	},
	{
		id: 'trousers',
		type: 'item',
		url: '/i/trousers',
		boost: 50,
		fields: { title: 'Linen trousers', brand: 'Acme', description: 'Relaxed fit' },
	},
	{ id: 'care', type: 'article', url: '/a/care', fields: { title: 'Caring for linen', body: 'Wash cold and iron while damp.' } },
	{
		id: 'returns',
		type: 'article',
		url: '/a/returns',
		fields: { title: 'Returns policy', body: 'Return any order within thirty days.' },
	},
];

const CONFIG = {
	index: { document_types: TYPES },
	ranking: { synonyms: [{ terms: ['jumper', 'sweater'] }], pinned: [{ query: 'help', ids: ['returns'] }] },
};

/** @type {Array<{ name: string, q: string, key?: 'pk' | 'sk', expect: (ids: string[], body: any) => void }>} */
const SUITE = [
	{ name: 'exact word', q: 'sweater', expect: (ids) => expect(ids).toEqual(['sweater']) },
	{
		name: 'field boost: title before body',
		q: 'linen',
		expect: (ids) => expect(ids.slice(0, 3).sort()).toEqual(['care', 'shirt', 'trousers']),
	},
	{ name: 'document boost lifts a document', q: 'linen acme', expect: (ids) => expect(ids[0]).toBe('trousers') },
	{ name: 'prefix of the last word', q: 'swea', expect: (ids) => expect(ids).toContain('sweater') },
	{ name: 'one typo', q: 'sweatre', expect: (ids) => expect(ids).toContain('sweater') },
	{ name: 'synonym', q: 'jumper', expect: (ids) => expect(ids).toContain('sweater') },
	{ name: 'all words required', q: 'linen shirt', expect: (ids) => expect(ids[0]).toBe('shirt') },
	{
		name: 'relaxed to any word when nothing matches all',
		q: 'linen zzzzqqq',
		expect: (ids, body) => {
			expect(ids.length).toBeGreaterThan(0);
			expect(body.relaxed).toBe(true);
		},
	},
	{ name: 'pinned results first', q: 'help', expect: (ids) => expect(ids[0]).toBe('returns') },
	{ name: 'private field never matches for pk_', q: 'zebracorp', key: 'pk', expect: (ids) => expect(ids).toEqual([]) },
	{ name: 'private field matches for sk_', q: 'zebracorp', key: 'sk', expect: (ids) => expect(ids).toEqual(['shirt']) },
	{ name: 'nothing found', q: 'qqqqzzzz', expect: (ids, body) => expect([ids, body.relaxed]).toEqual([[], false]) },
];

const SHAPE = ['engine', 'hasMore', 'items', 'nextCursor', 'query', 'relaxed', 'total', 'totalIsEstimate'];

for (const engine of /** @type {const} */ (['portable', 'atlas'])) {
	describe(`${engine} engine`, () => {
		/** @type {Awaited<ReturnType<typeof createHarness>>} */
		let h;
		/** @type {any[]} */
		const calls = [];
		beforeAll(async () => {
			h = await createHarness({
				config: { ...CONFIG, index: { ...CONFIG.index, engine: engine === 'atlas' ? 'atlas' : 'portable' } },
				atlas: engine === 'atlas' ? { atlasRunner: createAtlasRunner({ calls }), atlasProbe: readyProbe } : {},
			});
			await h.index(DOCS);
		});
		afterAll(async () => h.close());

		for (const test of SUITE)
			it(test.name, async () => {
				const key = test.key === 'sk' ? h.sk : h.pk;
				const response = await h.call('GET', `/v1/search?q=${encodeURIComponent(test.q)}&limit=10`, { key });
				expect(response.status, response.text).toBe(200);
				expect(Object.keys(response.json).sort()).toEqual(SHAPE);
				expect(response.json.engine).toBe(engine);
				for (const item of response.json.items) {
					expect(Object.keys(item).sort()).toEqual(
						test.key === 'sk'
							? [
									'boost',
									'currency',
									'description',
									'fields',
									'id',
									'image',
									'price',
									'source',
									'title',
									'type',
									'updatedAt',
									'url',
								]
							: ['currency', 'description', 'fields', 'id', 'image', 'price', 'title', 'type', 'url'],
					);
					if (test.key !== 'sk') expect(item.fields.supplier).toBeUndefined();
				}
				test.expect(
					response.json.items.map((/** @type {any} */ item) => item.id),
					response.json,
				);
			});

		it('returns prices in minor units with the currency, and the website pins every query', async () => {
			const response = await h.call('GET', '/v1/search?q=shirt', { key: h.pk });
			expect(response.json.items[0]).toMatchObject({ id: 'shirt', price: 4900, currency: 'EUR', url: '/i/shirt' });
			if (engine === 'atlas') {
				expect(calls.length).toBeGreaterThan(0);
				for (const call of calls) {
					expect(call.pipeline[0].$search.compound.filter[0]).toEqual({
						equals: { path: 'websiteId', value: call.websiteId },
					});
					expect(call.pipeline[1]).toEqual({ $match: { websiteId: call.websiteId } });
				}
			}
		});
	});
}

describe('atlas fallback', () => {
	it('answers with the portable engine while the index is not ready, and after a $search failure', async () => {
		let fail = true;
		const h = await createHarness({
			config: { ...CONFIG, index: { ...CONFIG.index, engine: 'auto' } },
			atlas: {
				atlasProbe: async () => ({ state: 'building', detail: null }),
			},
		});
		await h.index(DOCS);
		const building = await h.call('GET', '/v1/search?q=sweater', { key: h.pk });
		expect(building.json.engine).toBe('portable');
		await h.close();

		const runner = createAtlasRunner();
		const h2 = await createHarness({
			config: { ...CONFIG, index: { ...CONFIG.index, engine: 'auto' } },
			atlas: {
				atlasProbe: readyProbe,
				atlasRunner: async (/** @type {any[]} */ ...args) => {
					if (fail) throw Object.assign(new Error('mongot down'), { codeName: 'InternalError' });
					return runner(.../** @type {[any, any, any]} */ (args));
				},
			},
		});
		await h2.index(DOCS);
		const failed = await h2.call('GET', '/v1/search?q=sweater', { key: h2.pk });
		expect(failed.json).toMatchObject({ engine: 'portable', items: [{ id: 'sweater' }] });
		fail = false;
		// cooldown: still portable until it ends
		expect((await h2.call('GET', '/v1/search?q=sweater', { key: h2.pk })).json.engine).toBe('portable');
		h2.clock.advance(6 * 60_000);
		h2.search.engines.forget('web_0123456789abcdefghjkmnpq');
		expect((await h2.call('GET', '/v1/search?q=sweater', { key: h2.pk })).json.engine).toBe('atlas');
		await h2.close();
	});
});
